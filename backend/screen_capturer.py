from __future__ import annotations

import asyncio
import re
import time
from contextlib import suppress
from typing import Any, Awaitable, Callable

from tmux_bridge import TmuxBridge

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]

STOP_PATTERNS = re.compile(
    r"Thought for |Cooked for |Worked for |Crunched for "
    r"|ctrl\+o to expand|bypass permissions"
)

TOOL_CALL_RE = re.compile(
    r"^(Bash|Read|Edit|Write|Glob|Grep|Monitor|WebFetch|WebSearch"
    r"|NotebookEdit|Task|Agent|Skill|mcp__)\b"
)


class ScreenCapturer:
    """Poll tmux capture-pane to stream Claude's terminal output in real-time."""

    def __init__(
        self,
        tmux_bridge: TmuxBridge,
        callback: EventCallback,
        poll_interval: float = 0.15,
    ):
        self.tmux = tmux_bridge
        self.callback = callback
        self.poll_interval = poll_interval
        self._task: asyncio.Task[None] | None = None
        self._baseline = ""
        self._preview_text = ""
        self._active = False
        self.enabled = False

    async def start_turn(self) -> None:
        if not self.enabled:
            return
        if self._task and not self._task.done():
            self._active = False
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
        try:
            screen = await self.tmux.capture_pane(lines=200)
            self._baseline = _extract_last_bullet(screen)
        except Exception:
            self._baseline = ""
        self._preview_text = ""
        self._active = True
        self._task = asyncio.create_task(self._poll_loop())

    def stop_turn(self) -> None:
        self._active = False

    async def _poll_loop(self) -> None:
        while self._active:
            try:
                screen = await self.tmux.capture_pane(lines=200)
                current = _extract_last_bullet(screen)

                if current and current != self._baseline:
                    if self._baseline and current.startswith(self._baseline):
                        candidate = current[len(self._baseline) :]
                    else:
                        candidate = current

                    if not candidate or candidate == self._preview_text:
                        await asyncio.sleep(self.poll_interval)
                        continue

                    if candidate.startswith(self._preview_text):
                        delta = candidate[len(self._preview_text) :]
                    elif not self._preview_text:
                        delta = candidate
                    else:
                        delta = ""

                    if delta or candidate:
                        await self.callback({
                            "type": "stream_preview",
                            "delta": delta,
                            "text": candidate,
                            "timestamp": time.time(),
                        })
                        self._preview_text = candidate
            except Exception:
                pass
            await asyncio.sleep(self.poll_interval)


def _extract_last_bullet(screen: str) -> str:
    lines = screen.rstrip("\n").split("\n")

    last_bullet = -1
    for i in range(len(lines) - 1, -1, -1):
        stripped = lines[i].lstrip()
        if stripped.startswith("● "):
            text_after = stripped[2:]
            if text_after.startswith("How is Claude doing this session?"):
                continue
            if TOOL_CALL_RE.match(text_after):
                continue
            last_bullet = i
            break

    if last_bullet == -1:
        return ""

    first = lines[last_bullet].lstrip()[2:]
    paragraphs: list[str] = [first]

    for i in range(last_bullet + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()

        if STOP_PATTERNS.search(line):
            break
        if stripped.startswith(("❯", "❮", "✻", "● ")):
            break
        if "━━━" in line or "───" in line:
            break
        if stripped and TOOL_CALL_RE.match(stripped):
            break

        if stripped == "":
            if paragraphs and paragraphs[-1] != "":
                paragraphs.append("")
        elif line.startswith("  ") or stripped:
            if paragraphs and paragraphs[-1] != "":
                paragraphs[-1] += stripped
            else:
                paragraphs.append(stripped)

    return "\n\n".join(p for p in paragraphs if p).rstrip()
