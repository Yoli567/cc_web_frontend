from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal
from zoneinfo import ZoneInfo


BEIJING_TZ = ZoneInfo("Asia/Shanghai")
CHECK_INTERVAL_SECONDS = 30
MAX_PENDING_ALARMS = 50
DEFAULT_DIARY_PROMPT = (
    "晚上好。请温柔地提醒用户写今天的晚间日记：先慢慢回想今天发生了什么，"
    "再整理情绪、感谢、遗憾、明天的小小愿望。不要像任务提醒，要像坐在旁边一起收尾。"
)

ScheduleSource = Literal["self_alarm", "diary"]
SendScheduledWake = Callable[[ScheduleSource, str, str | None, str, str | None], Awaitable[None]]


@dataclass(slots=True)
class SelfAlarm:
    id: str
    wake_at: float
    reason: str
    created_at: float


@dataclass(slots=True)
class DiarySettings:
    enabled: bool = True
    time: str = "22:30"
    prompt: str = DEFAULT_DIARY_PROMPT
    session_id: str | None = None
    last_fired_date: str | None = None


@dataclass(slots=True)
class ScheduledWakeState:
    self_alarms: list[SelfAlarm] = field(default_factory=list)
    diary: DiarySettings = field(default_factory=DiarySettings)
    updated_at: float = 0.0


class ScheduledWakeService:
    def __init__(self, storage_path: Path, send_wake: SendScheduledWake):
        self.storage_path = storage_path
        self.send_wake = send_wake
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
            return {
                "self_alarms": [self._public_alarm(alarm) for alarm in sorted(state.self_alarms, key=lambda item: item.wake_at)],
                "pending_self_alarm_count": len(state.self_alarms),
                "max_pending_self_alarms": MAX_PENDING_ALARMS,
                "diary": asdict(state.diary),
                "next_diary_at": self._next_diary_at(state.diary),
                "updated_at": state.updated_at,
            }

    async def add_self_alarm(self, wake_at_value: object, reason_value: object) -> dict[str, Any]:
        reason = reason_value.strip() if isinstance(reason_value, str) else ""
        if not reason:
            raise ValueError("reason is required")
        wake_at = parse_wake_at(wake_at_value)
        now = time.time()
        if wake_at <= now:
            raise ValueError("wake_at must be in the future")

        async with self._lock:
            if len(self._state.self_alarms) >= MAX_PENDING_ALARMS:
                raise OverflowError(f"too many pending self alarms; limit is {MAX_PENDING_ALARMS}")
            alarm = SelfAlarm(
                id=f"alarm-{uuid.uuid4().hex[:12]}",
                wake_at=wake_at,
                reason=reason,
                created_at=now,
            )
            self._state.self_alarms.append(alarm)
            self._state.updated_at = now
            self._save_state()
            return {
                "status": "scheduled",
                "alarm": self._public_alarm(alarm),
                "pending_count": len(self._state.self_alarms),
                "max_pending": MAX_PENDING_ALARMS,
            }

    async def update_diary_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            diary = self._state.diary
            if "enabled" in values:
                diary.enabled = bool(values["enabled"])
            if isinstance(values.get("time"), str):
                diary.time = _normalize_time(values["time"])
            if isinstance(values.get("prompt"), str):
                diary.prompt = values["prompt"].strip() or DEFAULT_DIARY_PROMPT
            if "session_id" in values:
                session_id = values.get("session_id")
                diary.session_id = session_id if isinstance(session_id, str) and session_id else None
            self._state.updated_at = time.time()
            self._save_state()
            return asdict(diary)

    async def trigger_diary_now(self) -> dict[str, Any]:
        async with self._lock:
            diary = self._state.diary
            now = time.time()
            message_id = self._message_id(diary.session_id, "diary", now)
            prompt = diary.prompt
            session_id = diary.session_id
            diary.last_fired_date = datetime.fromtimestamp(now, BEIJING_TZ).date().isoformat()
            self._state.updated_at = now
            self._save_state()
        await self.send_wake("diary", message_id, session_id, prompt, None)
        return {"status": "fired", "message_id": message_id}

    async def _run(self) -> None:
        while True:
            try:
                await self._maybe_fire()
            except Exception as exc:
                print(f"[scheduled-wake] scheduler error: {type(exc).__name__}: {exc}", flush=True)
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)

    async def _maybe_fire(self) -> None:
        due_alarms: list[SelfAlarm] = []
        diary_fire: tuple[str, str | None, str] | None = None

        async with self._lock:
            state = self._state
            now = time.time()
            if state.self_alarms:
                due_alarms = [alarm for alarm in state.self_alarms if alarm.wake_at <= now]
                if due_alarms:
                    due_ids = {alarm.id for alarm in due_alarms}
                    state.self_alarms = [alarm for alarm in state.self_alarms if alarm.id not in due_ids]

            diary = state.diary
            today = datetime.fromtimestamp(now, BEIJING_TZ).date().isoformat()
            if diary.enabled and diary.last_fired_date != today and _minutes_now(now) >= _time_to_minutes(diary.time):
                message_id = self._message_id(diary.session_id, "diary", now)
                diary_fire = (message_id, diary.session_id, diary.prompt)
                diary.last_fired_date = today

            if due_alarms or diary_fire:
                state.updated_at = now
                self._save_state()

        for alarm in sorted(due_alarms, key=lambda item: item.wake_at):
            message_id = self._message_id(None, "self_alarm", alarm.wake_at)
            await self.send_wake("self_alarm", message_id, None, alarm.reason, self._format_alarm_time(alarm.wake_at))

        if diary_fire:
            message_id, session_id, prompt = diary_fire
            await self.send_wake("diary", message_id, session_id, prompt, None)

    def _load_state(self) -> ScheduledWakeState:
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ScheduledWakeState(updated_at=time.time())
        if not isinstance(raw, dict):
            return ScheduledWakeState(updated_at=time.time())

        alarms_raw = raw.get("self_alarms")
        alarms: list[SelfAlarm] = []
        if isinstance(alarms_raw, list):
            for item in alarms_raw:
                if not isinstance(item, dict):
                    continue
                try:
                    alarm = SelfAlarm(
                        id=str(item.get("id") or f"alarm-{uuid.uuid4().hex[:12]}"),
                        wake_at=float(item.get("wake_at") or 0),
                        reason=str(item.get("reason") or ""),
                        created_at=float(item.get("created_at") or time.time()),
                    )
                except (TypeError, ValueError):
                    continue
                if alarm.wake_at > 0 and alarm.reason.strip():
                    alarms.append(alarm)

        diary_raw = raw.get("diary") if isinstance(raw.get("diary"), dict) else {}
        diary = DiarySettings(
            enabled=bool(diary_raw.get("enabled", True)),
            time=_normalize_time(str(diary_raw.get("time") or "22:30")),
            prompt=str(diary_raw.get("prompt") or DEFAULT_DIARY_PROMPT),
            session_id=diary_raw.get("session_id") if isinstance(diary_raw.get("session_id"), str) else None,
            last_fired_date=diary_raw.get("last_fired_date") if isinstance(diary_raw.get("last_fired_date"), str) else None,
        )
        return ScheduledWakeState(
            self_alarms=alarms[-MAX_PENDING_ALARMS:],
            diary=diary,
            updated_at=float(raw.get("updated_at") or time.time()),
        )

    def _save_state(self) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.storage_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self._state), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.storage_path)

    @staticmethod
    def _message_id(session_id: str | None, source: str, timestamp: float) -> str:
        return f"user:{session_id or 'default'}:{source}:{int(timestamp * 1000)}:{uuid.uuid4().hex[:8]}"

    @staticmethod
    def _format_alarm_time(timestamp: float) -> str:
        return datetime.fromtimestamp(timestamp, BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _public_alarm(alarm: SelfAlarm) -> dict[str, Any]:
        return {
            "id": alarm.id,
            "wake_at": alarm.wake_at,
            "wake_at_text": ScheduledWakeService._format_alarm_time(alarm.wake_at),
            "reason": alarm.reason,
            "created_at": alarm.created_at,
        }

    @staticmethod
    def _next_diary_at(diary: DiarySettings) -> float | None:
        if not diary.enabled:
            return None
        now = datetime.now(BEIJING_TZ)
        hour, minute = divmod(_time_to_minutes(diary.time), 60)
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate.timestamp() <= time.time():
            candidate = candidate + timedelta(days=1)
        return candidate.timestamp()


def parse_wake_at(value: object) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("wake_at is required")
    text = value.strip()
    candidates = [text]
    if "T" not in text and " " in text:
        candidates.append(text.replace(" ", "T", 1))
    if text.endswith("Z"):
        candidates.append(text[:-1] + "+00:00")

    for candidate in candidates:
        try:
            dt = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BEIJING_TZ)
        return dt.timestamp()
    raise ValueError("wake_at must be ISO or YYYY-MM-DD HH:MM")


def _normalize_time(value: str) -> str:
    minutes = _time_to_minutes(value)
    hour, minute = divmod(minutes, 60)
    return f"{hour:02d}:{minute:02d}"


def _time_to_minutes(value: str) -> int:
    try:
        hour_raw, minute_raw = value.split(":", 1)
        hour = max(0, min(23, int(hour_raw)))
        minute = max(0, min(59, int(minute_raw)))
    except (ValueError, TypeError):
        return 0
    return hour * 60 + minute


def _minutes_now(timestamp: float) -> int:
    now = datetime.fromtimestamp(timestamp, BEIJING_TZ)
    return now.hour * 60 + now.minute
