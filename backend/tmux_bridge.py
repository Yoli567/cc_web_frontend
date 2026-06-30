from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from dataclasses import dataclass


class TmuxBridgeError(RuntimeError):
    pass


@dataclass(slots=True)
class TmuxBridge:
    session_name: str = os.getenv("CC_TMUX_SESSION", "cc-main")
    buffer_name: str = "cc-web-input"
    timeout_seconds: float = 8.0
    paste_enter_delay_seconds: float = float(os.getenv("CC_PASTE_ENTER_DELAY_SECONDS", "0.12"))
    enter_verify_delay_seconds: float = float(os.getenv("CC_ENTER_VERIFY_DELAY_SECONDS", "0.12"))

    def available(self) -> bool:
        return shutil.which("tmux") is not None and self.has_session()

    def has_session(self) -> bool:
        if shutil.which("tmux") is None:
            return False
        result = subprocess.run(
            ["tmux", "has-session", "-t", self.session_name],
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            check=False,
        )
        return result.returncode == 0

    async def send_input(self, text: str) -> bool:
        return await asyncio.to_thread(self._send_input_sync, text)

    async def send_command(self, command: str) -> None:
        command = command.strip()
        if not command.startswith("/"):
            command = f"/{command}"
        await self.send_input(command)

    async def capture_pane(self, lines: int = 120) -> str:
        return await asyncio.to_thread(self._capture_pane_sync, lines)

    def _send_input_sync(self, text: str) -> bool:
        self._require_tmux_session()
        before = self._capture_pane_sync(lines=80)

        self._run(
            ["tmux", "load-buffer", "-b", self.buffer_name, "-"],
            input_text=text,
        )
        self._run(["tmux", "paste-buffer", "-t", self.session_name, "-b", self.buffer_name])
        time.sleep(max(0.0, self.paste_enter_delay_seconds))
        after_paste = self._capture_pane_sync(lines=80)

        if after_paste == before:
            self._run(["tmux", "paste-buffer", "-t", self.session_name, "-b", self.buffer_name])
            time.sleep(max(0.0, self.paste_enter_delay_seconds))
            after_paste = self._capture_pane_sync(lines=80)

        if after_paste == before:
            self._run(["tmux", "send-keys", "-t", self.session_name, "Escape"])
            time.sleep(max(0.0, self.paste_enter_delay_seconds))
            before = self._capture_pane_sync(lines=80)
            self._run(["tmux", "paste-buffer", "-t", self.session_name, "-b", self.buffer_name])
            time.sleep(max(0.0, self.paste_enter_delay_seconds))
            after_paste = self._capture_pane_sync(lines=80)
            if after_paste == before:
                return False

        self._run(["tmux", "send-keys", "-t", self.session_name, "Enter"])
        time.sleep(max(0.0, self.enter_verify_delay_seconds))
        after_enter = self._capture_pane_sync(lines=80)
        if after_enter != after_paste:
            return True

        self._run(["tmux", "send-keys", "-t", self.session_name, "Enter"])
        time.sleep(max(0.0, self.enter_verify_delay_seconds))
        after_second_enter = self._capture_pane_sync(lines=80)
        return after_second_enter != after_paste

    def _capture_pane_sync(self, lines: int) -> str:
        self._require_tmux_session()
        result = self._run(
            ["tmux", "capture-pane", "-t", self.session_name, "-p", "-S", f"-{max(1, lines)}"],
        )
        return result.stdout

    def _require_tmux_session(self) -> None:
        if shutil.which("tmux") is None:
            raise TmuxBridgeError("tmux is not installed or not on PATH")
        if not self.has_session():
            raise TmuxBridgeError(f"tmux session not found: {self.session_name}")

    def _run(self, args: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            check=False,
        )
        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or "tmux command failed"
            raise TmuxBridgeError(message)
        return result
