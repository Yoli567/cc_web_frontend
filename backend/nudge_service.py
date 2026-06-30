from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from push_service import PushService


BEIJING_TZ = ZoneInfo("Asia/Shanghai")
CHECK_INTERVAL_SECONDS = 30
DEFAULT_NUDGE_MESSAGE = "想起你了。要不要一起把现在的想法整理一下？"


@dataclass(slots=True)
class NudgeSettings:
    enabled: bool = True
    message: str = DEFAULT_NUDGE_MESSAGE
    active_start: str = "09:00"
    active_end: str = "23:00"
    interval_value: int = 2
    interval_unit: str = "hours"
    session_id: str | None = None


@dataclass(slots=True)
class NudgeState:
    settings: NudgeSettings
    last_interaction_at: float = 0.0
    last_fired_at: float = 0.0
    updated_at: float = 0.0


class NudgeService:
    def __init__(
        self,
        storage_path: Path,
        push_service: PushService,
        send_nudge: Callable[[str, str | None, str], Awaitable[None]],
    ):
        self.storage_path = storage_path
        self.push_service = push_service
        self.send_nudge = send_nudge
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._state = self._load_state()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def status(self) -> dict[str, Any]:
        async with self._lock:
            state = self._state
            now = time.time()
            return {
                "settings": asdict(state.settings),
                "last_interaction_at": state.last_interaction_at,
                "last_fired_at": state.last_fired_at,
                "idle_seconds": max(0, now - state.last_interaction_at) if state.last_interaction_at else None,
                "next_nudge_at": self._next_nudge_at(state),
            }

    async def update_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            settings = self._state.settings
            if "enabled" in values:
                settings.enabled = bool(values["enabled"])
            if isinstance(values.get("message"), str):
                settings.message = values["message"].strip() or DEFAULT_NUDGE_MESSAGE
            if isinstance(values.get("active_start"), str):
                settings.active_start = values["active_start"]
            if isinstance(values.get("active_end"), str):
                settings.active_end = values["active_end"]
            if "interval_value" in values:
                settings.interval_value = max(1, int(values.get("interval_value") or 1))
            if values.get("interval_unit") in {"minutes", "hours"}:
                settings.interval_unit = values["interval_unit"]
            if "session_id" in values:
                session_id = values.get("session_id")
                settings.session_id = session_id if isinstance(session_id, str) and session_id else None
            self._state.updated_at = time.time()
            self._save_state()
            return asdict(settings)

    async def trigger_now(self) -> dict[str, Any]:
        """Fire a nudge immediately, ignoring schedule/active-hours/enabled — for
        testing the nudge + push pipeline from the Settings page."""
        async with self._lock:
            settings = self._state.settings
            now = time.time()
            message = settings.message
            session_id = settings.session_id
            message_id = f"user:{session_id or 'default'}:nudge:{int(now * 1000)}:{uuid.uuid4().hex[:8]}"
            self._state.last_fired_at = now
            self._state.updated_at = now
            self._save_state()
        await self.send_nudge(message_id, session_id, message)
        return {"status": "fired", "message_id": message_id}

    async def mark_interaction(self, timestamp: float | None = None, session_id: str | None = None) -> None:
        async with self._lock:
            self._state.last_interaction_at = timestamp or time.time()
            if session_id:
                self._state.settings.session_id = session_id
            self._state.updated_at = time.time()
            self._save_state()

    async def _run(self) -> None:
        while True:
            try:
                await self._maybe_fire()
            except Exception as exc:
                print(f"[nudge] scheduler error: {type(exc).__name__}: {exc}", flush=True)
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)

    async def _maybe_fire(self) -> None:
        async with self._lock:
            state = self._state
            settings = state.settings
            now = time.time()
            if not settings.enabled:
                return
            if not self._within_active_hours(now, settings.active_start, settings.active_end):
                return
            interval = self._interval_seconds(settings)
            if not state.last_interaction_at:
                state.last_interaction_at = now
                state.updated_at = now
                self._save_state()
                return
            if now - state.last_interaction_at < interval:
                return
            if state.last_fired_at and now - state.last_fired_at < interval:
                return

            message = settings.message
            session_id = settings.session_id
            message_id = f"user:{session_id or 'default'}:nudge:{int(now * 1000)}:{uuid.uuid4().hex[:8]}"
            state.last_fired_at = now
            state.updated_at = now
            self._save_state()

        await self.send_nudge(message_id, session_id, message)

    def _load_state(self) -> NudgeState:
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return NudgeState(settings=NudgeSettings(), updated_at=time.time())
        if not isinstance(raw, dict):
            return NudgeState(settings=NudgeSettings(), updated_at=time.time())
        settings_raw = raw.get("settings") if isinstance(raw, dict) else {}
        settings = NudgeSettings(
            enabled=bool(settings_raw.get("enabled", True)) if isinstance(settings_raw, dict) else True,
            message=str(settings_raw.get("message") or DEFAULT_NUDGE_MESSAGE) if isinstance(settings_raw, dict) else DEFAULT_NUDGE_MESSAGE,
            active_start=str(settings_raw.get("active_start") or "09:00") if isinstance(settings_raw, dict) else "09:00",
            active_end=str(settings_raw.get("active_end") or "23:00") if isinstance(settings_raw, dict) else "23:00",
            interval_value=max(1, int(settings_raw.get("interval_value") or 2)) if isinstance(settings_raw, dict) else 2,
            interval_unit=settings_raw.get("interval_unit") if isinstance(settings_raw, dict) and settings_raw.get("interval_unit") in {"minutes", "hours"} else "hours",
            session_id=settings_raw.get("session_id") if isinstance(settings_raw, dict) and isinstance(settings_raw.get("session_id"), str) else None,
        )
        return NudgeState(
            settings=settings,
            last_interaction_at=float(raw.get("last_interaction_at") or 0),
            last_fired_at=float(raw.get("last_fired_at") or 0),
            updated_at=float(raw.get("updated_at") or time.time()),
        )

    def _save_state(self) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.storage_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self._state), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.storage_path)

    def _next_nudge_at(self, state: NudgeState) -> float | None:
        if not state.settings.enabled or not state.last_interaction_at:
            return None
        interval = self._interval_seconds(state.settings)
        return max(state.last_interaction_at + interval, state.last_fired_at + interval if state.last_fired_at else 0)

    @staticmethod
    def _interval_seconds(settings: NudgeSettings) -> int:
        multiplier = 60 if settings.interval_unit == "minutes" else 3600
        return max(1, settings.interval_value) * multiplier

    @staticmethod
    def _within_active_hours(timestamp: float, start: str, end: str) -> bool:
        now = datetime.fromtimestamp(timestamp, BEIJING_TZ)
        current_minutes = now.hour * 60 + now.minute
        start_minutes = _time_to_minutes(start)
        end_minutes = _time_to_minutes(end)
        if start_minutes == end_minutes:
            return True
        if start_minutes < end_minutes:
            return start_minutes <= current_minutes <= end_minutes
        return current_minutes >= start_minutes or current_minutes <= end_minutes


def _time_to_minutes(value: str) -> int:
    try:
        hour_raw, minute_raw = value.split(":", 1)
        hour = max(0, min(23, int(hour_raw)))
        minute = max(0, min(59, int(minute_raw)))
    except (ValueError, TypeError):
        return 0
    return hour * 60 + minute
