from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal


ChatMode = Literal["message", "cabin"]
BACKGROUND_SOURCES = {"nudge", "self_alarm", "diary"}
EventCallback = Callable[[dict[str, Any]], Awaitable[None]]

# A new send only queues behind the active turn while that turn is still
# actively producing JSONL output (last activity within this window). Once the
# turn completes or simply goes quiet, the new message takes over immediately.
# We never gate on the bridge-completion counter or the queue, so a desync can
# no longer lock the pipeline and silently swallow cabin replies.
ACTIVE_TURN_QUIET_SECONDS = 30


@dataclass(slots=True)
class ActiveTurn:
    client_id: str
    mode: ChatMode
    user_message_id: str
    source: str = "manual"


class ClaudeJsonlTranslator:
    """Translate Claude Code JSONL records into the frontend WS event protocol."""

    def __init__(self, callback: EventCallback):
        self.callback = callback
        self.active_turn: ActiveTurn | None = None
        self._queued_turns: list[ActiveTurn] = []
        self._cabin_streaming_id: str | None = None
        self._cabin_streaming_text = ""
        self._seen_tool_ids: set[str] = set()
        self._skipped_tool_ids: set[str] = set()
        self._turn_completed = False
        self._turn_started_at = 0.0
        self._bridge_completions_pending_jsonl_end = 0
        self.lines_seen = 0
        self.events_emitted = 0
        self.tool_uses_seen = 0
        self.last_tool_name: str | None = None
        self.last_event_type: str | None = None
        self.last_line_at: float | None = None
        self.last_event_at: float | None = None

    def set_active_turn(self, client_id: str, mode: ChatMode, user_message_id: str, source: str = "manual") -> None:
        self.active_turn = ActiveTurn(client_id=client_id, mode=mode, user_message_id=user_message_id, source=source)
        self._cabin_streaming_id = None
        self._cabin_streaming_text = ""
        self._turn_completed = False
        self._turn_started_at = time.time()
        self._skipped_tool_ids.clear()

    def start_or_queue_turn(self, client_id: str, mode: ChatMode, user_message_id: str, source: str = "manual") -> bool:
        # Only hold the new message back while the active turn is genuinely
        # mid-stream; otherwise take over right away. Queueing exists so an
        # in-flight turn's JSONL output keeps the right turn_id/mode — not to
        # serialize behind a finished-but-undetected turn.
        if self.active_turn and self._active_turn_is_busy():
            self._queued_turns.append(
                ActiveTurn(client_id=client_id, mode=mode, user_message_id=user_message_id, source=source),
            )
            return False
        self._queued_turns.clear()
        self.set_active_turn(client_id, mode, user_message_id, source)
        return True

    def abandon_turn(self, user_message_id: str) -> None:
        if self.active_turn and self.active_turn.user_message_id == user_message_id:
            self.active_turn = None
            self._cabin_streaming_id = None
            self._cabin_streaming_text = ""
            self._turn_completed = True
        self._queued_turns = [
            turn for turn in self._queued_turns
            if turn.user_message_id != user_message_id
        ]

    def _active_turn_is_busy(self) -> bool:
        if self._turn_completed:
            return False
        last_activity = self.last_line_at or self.last_event_at
        reference = max(self._turn_started_at, last_activity or 0.0)
        return (time.time() - reference) <= ACTIVE_TURN_QUIET_SECONDS

    async def wait_for_user(self) -> None:
        if self._turn_completed:
            return
        self._turn_completed = True
        # Clamp so a desync can't drift this unboundedly. It no longer gates new
        # turns; it only absorbs the trailing JSONL end_turn for this completion.
        self._bridge_completions_pending_jsonl_end = min(
            self._bridge_completions_pending_jsonl_end + 1, 2,
        )
        if self._cabin_streaming_id:
            await self._emit({
                "type": "stream_end",
                "message_id": self._cabin_streaming_id,
                "timestamp": time.time(),
                "mode": "cabin",
            })
            self._cabin_streaming_id = None
            self._cabin_streaming_text = ""
        await self._emit({"type": "turn_complete", "timestamp": time.time()})

    async def translate_line(self, raw_line: str) -> None:
        raw_line = raw_line.strip()
        if not raw_line:
            return
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError:
            return
        self.lines_seen += 1
        self.last_line_at = time.time()

        message = record.get("message") if isinstance(record.get("message"), dict) else record
        if not isinstance(message, dict):
            return

        content = message.get("content")

        # Detect where CC starts responding to a queued (interjected) message so
        # its thinking/messages carry the NEW turn_id. Two shapes appear:
        #   * a fresh `<cc-web-frontend>` prompt record — a clean new turn (this
        #     normally follows an end_turn that already activated the queue, so
        #     it's a harmless no-op, but covers the race where it doesn't);
        #   * bare `last-prompt`/`mode`/`permission-mode` marker records WHILE the
        #     active turn has already produced output and hasn't ended — this is
        #     user interjecting mid-reply, where CC keeps going without an
        #     end_turn and the full prompt record isn't written until much later.
        # Without this, the new (usually most informative) thinking stays tagged
        # to the previous turn, whose first bubble already owns a thinking block,
        # so the frontend drops it.
        record_type = record.get("type")
        # A queued (interjected) frontend message surfaces in CC's JSONL as a
        # `queue-operation`/enqueue record carrying the prompt — the reliable
        # boundary for activating the queued turn so CC's reply to it gets the
        # new turn_id. (CC otherwise continues without an end_turn and the new
        # thinking stays tagged to the previous turn, which already owns a
        # thinking block, so the frontend drops it.) The `<cc-web-frontend>`
        # user record is a fallback for clean new turns (usually a no-op since
        # end_turn already activated the queue).
        if record_type == "queue-operation" and record.get("operation") == "enqueue":
            await self._handle_user_prompt_boundary()
        elif record_type == "user" and isinstance(content, str) and "<cc-web-frontend>" in content:
            await self._handle_user_prompt_boundary()

        blocks = content if isinstance(content, list) else [content] if isinstance(content, dict) else []

        for block in blocks:
            if isinstance(block, dict):
                await self._translate_block(block)

        stop_reason = message.get("stop_reason") or record.get("stop_reason")
        if stop_reason == "end_turn":
            if self._bridge_completions_pending_jsonl_end:
                self._bridge_completions_pending_jsonl_end -= 1
                if self._turn_completed:
                    self._activate_next_turn()
            else:
                await self._finish_turn()

        usage = message.get("usage") if isinstance(message.get("usage"), dict) else record.get("usage")
        if isinstance(usage, dict):
            await self._emit_context_update(usage)

    async def _translate_block(self, block: dict[str, Any]) -> None:
        block_type = block.get("type")
        if block_type == "thinking":
            thinking = block.get("thinking") or block.get("text") or ""
            if thinking:
                await self._emit({"type": "thinking", "thinking": thinking})
            return

        if block_type == "tool_use":
            self.tool_uses_seen += 1
            await self._translate_tool_use(block)
            return

        if block_type == "tool_result":
            await self._translate_tool_result(block)
            return

        if block_type == "text":
            text = block.get("text") or ""
            if text:
                await self._emit_text(text)

    async def _translate_tool_use(self, block: dict[str, Any]) -> None:
        tool_id = str(block.get("id") or "")
        if tool_id and tool_id in self._seen_tool_ids:
            return
        if tool_id:
            self._seen_tool_ids.add(tool_id)

        name = block.get("name")
        self.last_tool_name = str(name) if name else None
        tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}

        # Bridge architecture: cc-frontend MCP tools POST directly to
        # backend /api/mcp/* from mcp-server/server.py. We skip them here to
        # avoid double-emission.
        #
        # CC prefixes MCP tools as "mcp__<server>__<tool>". Strip to match.
        short_name = name.rsplit("__", 1)[-1] if isinstance(name, str) and "__" in name else name

        if short_name in {
            "send_message",
            "reply_message",
            "wait_for_user",
            "send_image",
            "send_voice",
            "load_stickers",
            "send_sticker",
            "set_self_alarm",
        }:
            if tool_id:
                self._skipped_tool_ids.add(tool_id)
            return

        await self._emit({
            "type": "tool_use",
            "id": tool_id or str(uuid.uuid4()),
            "name": str(name or "tool"),
            "input": tool_input,
            "timestamp": time.time(),
        })

    async def _translate_tool_result(self, block: dict[str, Any]) -> None:
        tool_use_id = str(block.get("tool_use_id") or "")
        if tool_use_id and tool_use_id in self._skipped_tool_ids:
            return
        content = block.get("content")
        if isinstance(content, str):
            result_text = content
        else:
            result_text = json.dumps(content, ensure_ascii=False)

        await self._emit({
            "type": "tool_result",
            "tool_use_id": str(block.get("tool_use_id") or ""),
            "content": result_text,
            "timestamp": time.time(),
        })

    async def _emit_text(self, text: str) -> None:
        mode = self.active_turn.mode if self.active_turn else "cabin"
        source = self.active_turn.source if self.active_turn else "manual"
        if mode == "message":
            if source in BACKGROUND_SOURCES:
                # Background turns have no Message-page bubble of their own;
                # archive the plain assistant reply to Activity.
                await self._emit({
                    "type": "message",
                    "role": "assistant",
                    "text": text,
                    "message_id": str(uuid.uuid4()),
                    "timestamp": time.time(),
                })
                return
            # Message mode only accepts explicit MCP send_message bubbles.
            # Plain assistant text in the JSONL is usually incidental narration
            # around tool calls, so dropping it keeps the chat flow clean.
            return

        if not self._cabin_streaming_id:
            self._cabin_streaming_id = str(uuid.uuid4())
            await self._emit({
                "type": "stream_start",
                "message_id": self._cabin_streaming_id,
                "timestamp": time.time(),
                "mode": "cabin",
            })
        if self._cabin_streaming_text:
            self._cabin_streaming_text = f"{self._cabin_streaming_text}\n\n{text}"
        else:
            self._cabin_streaming_text = text
        await self._emit({
            "type": "stream_chunk",
            "message_id": self._cabin_streaming_id,
            "chunk": self._cabin_streaming_text,
            "mode": "cabin",
        })

    async def _finish_turn(self) -> None:
        if self._turn_completed:
            self._activate_next_turn()
            return
        self._turn_completed = True
        if self._cabin_streaming_id:
            await self._emit({
                "type": "stream_end",
                "message_id": self._cabin_streaming_id,
                "timestamp": time.time(),
                "mode": "cabin",
            })
            self._cabin_streaming_id = None
            self._cabin_streaming_text = ""
        await self._emit({"type": "turn_complete", "timestamp": time.time()})
        self._activate_next_turn()

    async def _handle_user_prompt_boundary(self) -> None:
        if not self._queued_turns:
            return
        if self.active_turn and not self._turn_completed:
            # Closes out the current turn (emits turn_complete for the old
            # turn_id) and activates the queued one.
            await self._finish_turn()
        else:
            self._activate_next_turn()

    def _activate_next_turn(self) -> None:
        if not self._queued_turns:
            return
        next_turn = self._queued_turns.pop(0)
        self.set_active_turn(next_turn.client_id, next_turn.mode, next_turn.user_message_id, next_turn.source)

    async def _emit_context_update(self, usage: dict[str, Any]) -> None:
        tokens = usage.get("input_tokens") or usage.get("total_tokens")
        if isinstance(tokens, int):
            await self._emit({"type": "context_updated", "tokens": tokens})

    async def _emit(self, event: dict[str, Any]) -> None:
        if self.active_turn:
            if "mode" not in event:
                event["mode"] = self.active_turn.mode
            if "turn_id" not in event:
                event["turn_id"] = self.active_turn.user_message_id
            if "source" not in event and self.active_turn.source != "manual":
                event["source"] = self.active_turn.source
        self.events_emitted += 1
        self.last_event_type = str(event.get("type") or "")
        self.last_event_at = time.time()
        await self.callback(event)


class ClaudeJsonlWatcher:
    """Tail Claude Code JSONL files and feed records to a translator."""

    def __init__(
        self,
        translator: ClaudeJsonlTranslator,
        projects_dir: str | Path | None = None,
    ):
        self.translator = translator
        self.projects_dir = Path(
            projects_dir
            or os.getenv("CC_PROJECTS_DIR")
            or Path.home() / ".claude" / "projects",
        )
        self._offsets: dict[Path, int] = {}
        self._task: asyncio.Task[None] | None = None
        self.last_file: str | None = None
        self.last_read_at: float | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.watch())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def watch(self) -> None:
        from watchfiles import Change, awatch

        self.projects_dir.mkdir(parents=True, exist_ok=True)
        await self._seed_existing_files()
        # Self-healing: if awatch raises (transient FS/inotify error), log it and
        # re-establish the watch instead of letting the task die silently — a dead
        # watcher would stop all cabin replies until a backend restart. Offsets are
        # preserved across restarts so no appended lines get skipped.
        while True:
            try:
                async for changes in awatch(self.projects_dir):
                    for change, path_text in changes:
                        if change not in {Change.added, Change.modified}:
                            continue
                        path = Path(path_text)
                        if path.suffix == ".jsonl":
                            await self.read_new_lines(path)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                print(f"[watcher] awatch failed, retrying: {self.last_error}", flush=True)
                await asyncio.sleep(2)

    async def _seed_existing_files(self) -> None:
        for path in self.projects_dir.rglob("*.jsonl"):
            try:
                self._offsets[path] = path.stat().st_size
            except OSError:
                continue

    async def read_new_lines(self, path: Path) -> None:
        previous = self._offsets.get(path, 0)
        try:
            with path.open("r", encoding="utf-8") as handle:
                handle.seek(previous)
                for line in handle:
                    await self.translator.translate_line(line)
                self._offsets[path] = handle.tell()
                self.last_file = str(path)
                self.last_read_at = time.time()
        except OSError:
            self.last_error = f"could not read {path}"
            return

    def status(self) -> dict[str, Any]:
        return {
            "projects_dir": str(self.projects_dir),
            "projects_dir_exists": self.projects_dir.exists(),
            "watched_files": len(self._offsets),
            "task_running": self._task is not None and not self._task.done(),
            "last_file": self.last_file,
            "last_read_at": self.last_read_at,
            "last_error": self.last_error,
        }
