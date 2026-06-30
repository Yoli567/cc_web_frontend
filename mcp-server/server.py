"""Bridge MCP server.

Each tool POSTs directly to the cc-web-frontend backend, which then pushes
to the active WebSocket client. Bypasses JSONL watcher tool-use parsing
entirely — so we are immune to MCP tool name format changes
(e.g. `mcp__cc-frontend__send_message` prefix).

Backend address from env CC_FRONTEND_BACKEND_URL (default http://127.0.0.1:8001).
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


BACKEND_URL = os.getenv("CC_FRONTEND_BACKEND_URL", "http://127.0.0.1:8001").rstrip("/")
HTTP_TIMEOUT = 3.0


mcp = FastMCP("cc-frontend")


def _post(path: str, payload: dict[str, Any], timeout: float = HTTP_TIMEOUT) -> dict[str, Any]:
    """POST to backend; return delivery status. Never raise — MCP tools should
    return a serializable result so CC can keep going even if backend is down."""
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.post(f"{BACKEND_URL}{path}", json=payload)
            r.raise_for_status()
            try:
                data = r.json()
                return data if isinstance(data, dict) else {"status": "delivered", "data": data}
            except ValueError:
                return {"status": "delivered"}
    except httpx.HTTPError as exc:
        return {"status": "error", "error": f"backend unreachable: {exc}"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": str(exc)}


@mcp.tool()
def send_message(text: str) -> dict[str, Any]:
    """Send one short Message-page bubble to the web frontend."""
    return _post("/api/mcp/send_message", {"text": text})


@mcp.tool()
def reply_message(quoted_text: str, text: str, quoted_role: str = "user") -> dict[str, Any]:
    """Reply in Message page with a visible quoted message above the reply.

    Use this when responding directly to a specific thing the user said. Put the
    original message text in quoted_text and the new reply bubble in text.
    quoted_role should usually be "user".
    """
    return _post(
        "/api/mcp/reply_message",
        {"quoted_text": quoted_text, "text": text, "quoted_role": quoted_role},
    )


@mcp.tool()
def wait_for_user(reason: str | None = None) -> dict[str, Any]:
    """Do not send a reply bubble yet; quietly wait for the user's next message.

    Use this when the user clearly has more to say, or when staying silent is the
    more natural response. The optional reason is only for backend diagnostics
    and is not shown in the chat.
    """
    return _post("/api/mcp/wait_for_user", {"reason": reason})


@mcp.tool()
def send_image(
    path: str | None = None,
    url: str | None = None,
    caption: str | None = None,
) -> dict[str, Any]:
    """Send an image to the web frontend from a local path or remote URL."""
    return _post("/api/mcp/send_image", {"path": path, "url": url, "caption": caption})


@mcp.tool()
def load_stickers() -> dict[str, Any]:
    """Load available WebP sticker filenames from the stickers folder."""
    return _post("/api/mcp/load_stickers", {})


@mcp.tool()
def send_sticker(filename: str, caption: str | None = None) -> dict[str, Any]:
    """Send one WebP sticker by filename returned from load_stickers."""
    return _post("/api/mcp/send_sticker", {"filename": filename, "caption": caption})


@mcp.tool()
def send_voice(text: str, voice_id: str | None = None) -> dict[str, Any]:
    """Send a voice message: write what you want to say, the backend synthesizes
    it with TTS and the user hears your voice (with the text available too).

    Just put your spoken words in text. voice_id optionally overrides the default
    voice configured in Settings. If TTS is unconfigured or fails, the backend
    automatically falls back to delivering your text as a normal message.
    """
    # TTS synthesis is synchronous on the backend (can take ~10s+), so allow more
    # time than the default 3s before treating it as unreachable.
    return _post("/api/mcp/send_voice", {"text": text, "voice_id": voice_id}, timeout=65.0)


@mcp.tool()
def set_self_alarm(wake_at: str, reason: str) -> dict[str, Any]:
    """Schedule a future wake-up for yourself.

    Use this when you want future-you to wake up at a chosen time for a specific
    reason. wake_at may be ISO format or YYYY-MM-DD HH:MM in Asia/Shanghai.
    This only adds a new alarm; it does not list or cancel existing alarms.
    """
    return _post("/api/mcp/set_self_alarm", {"wake_at": wake_at, "reason": reason})


if __name__ == "__main__":
    mcp.run()
