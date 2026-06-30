from fastapi import WebSocket
import asyncio
from collections import deque
from typing import Optional

MAX_EVENT_HISTORY = 500
REPLAYABLE_EVENT_TYPES = {
    "message",
    "thinking",
    "stream_start",
    "stream_chunk",
    "stream_end",
    "tool_use",
    "tool_result",
    "turn_complete",
    "context_updated",
    "send_status",
}


class ConnectionManager:
    def __init__(self):
        self.connections: dict[str, WebSocket] = {}
        self._history: deque[dict] = deque(maxlen=MAX_EVENT_HISTORY)
        self._lock = asyncio.Lock()
        self._event_seq = 0

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.connections[client_id] = websocket

    async def disconnect(self, client_id: str):
        async with self._lock:
            self.connections.pop(client_id, None)

    async def send(self, client_id: str, data: dict):
        event = await self._record_event(data)
        async with self._lock:
            ws = self.connections.get(client_id)
            fallback_targets = [
                (cid, target) for cid, target in self.connections.items()
                if cid != client_id
            ] if not ws else []
        if ws:
            try:
                await ws.send_json(event)
                return
            except Exception:
                await self.disconnect(client_id)
                fallback_targets = await self._connection_snapshot(exclude=client_id)

        for cid, target in fallback_targets:
            try:
                await target.send_json(event)
            except Exception:
                await self.disconnect(cid)

    async def broadcast(self, data: dict, exclude: Optional[str] = None):
        event = await self._record_event(data)
        targets = await self._connection_snapshot(exclude=exclude)
        for cid, ws in targets:
            try:
                await ws.send_json(event)
            except Exception:
                await self.disconnect(cid)

    async def replay_since(self, client_id: str, after_seq: int):
        async with self._lock:
            effective_seq = 0 if after_seq > self._event_seq else after_seq
            ws = self.connections.get(client_id)
            events = [
                event.copy()
                for event in self._history
                if int(event.get("server_event_seq") or 0) > effective_seq
            ]
        if not ws:
            return
        for event in events:
            try:
                await ws.send_json(event)
            except Exception:
                await self.disconnect(client_id)
                return

    async def _connection_snapshot(self, exclude: Optional[str] = None):
        async with self._lock:
            return [
                (cid, ws) for cid, ws in self.connections.items()
                if cid != exclude
            ]

    async def _record_event(self, data: dict) -> dict:
        event = data.copy()
        if event.get("type") not in REPLAYABLE_EVENT_TYPES:
            return event
        async with self._lock:
            self._event_seq += 1
            event["server_event_seq"] = self._event_seq
            self._history.append(event.copy())
        return event


manager = ConnectionManager()
