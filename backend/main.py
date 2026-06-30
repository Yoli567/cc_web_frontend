import asyncio
import hmac
import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import re
import shutil
import secrets
import time
import uuid
from types import SimpleNamespace

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from ws_manager import manager
from mock_watcher import generate_mock_reply
from prompt_builder import AttachmentRef, FrontendMessage, ReplyRef, build_cc_prompt
from tmux_bridge import TmuxBridge, TmuxBridgeError
from screen_capturer import ScreenCapturer
from watcher import ClaudeJsonlTranslator, ClaudeJsonlWatcher
from push_service import PushService
from nudge_service import NudgeService
from scheduled_wake_service import ScheduledWakeService
from voice_service import VoiceService, VoiceServiceError

app = FastAPI(title="CC Web Frontend Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=os.getenv("CC_CORS_ORIGIN_REGEX", ".*"),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
CC_HOME_DIR = Path(os.getenv("CC_HOME_DIR") or PROJECT_DIR).expanduser()
UPLOAD_DIR = Path(os.getenv("CC_UPLOAD_DIR") or (CC_HOME_DIR / "uploads")).expanduser()
STICKER_DIR = Path(os.getenv("CC_STICKER_DIR") or (CC_HOME_DIR / "stickers")).expanduser()
STICKER_INDEX_PATH = Path(os.getenv("CC_STICKER_INDEX") or (STICKER_DIR / "index.json")).expanduser()
DATA_DIR = Path(os.getenv("CC_DATA_DIR") or (CC_HOME_DIR / "data")).expanduser()
UPLOAD_RETENTION_DAYS = int(os.getenv("CC_UPLOAD_RETENTION_DAYS", "7"))
MAX_UPLOAD_BYTES = int(os.getenv("CC_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

BACKEND_MODE = os.getenv("CC_BACKEND_MODE", "mock").lower()
AUTH_COOKIE_NAME = "cc_web_session"
AUTH_USERNAME = os.getenv("CC_WEB_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("CC_WEB_PASSWORD")
AUTH_SECRET = os.getenv("CC_WEB_AUTH_SECRET") or AUTH_PASSWORD or secrets.token_urlsafe(32)
AUTH_MAX_AGE = int(os.getenv("CC_WEB_AUTH_MAX_AGE", str(60 * 60 * 24 * 30)))
AUTH_ENABLED = os.getenv("CC_WEB_AUTH_ENABLED", "true").lower() not in {"0", "false", "off", "no"} and bool(AUTH_PASSWORD)
BACKEND_SESSION_ID = str(uuid.uuid4())
tmux_bridge = TmuxBridge()
translator: ClaudeJsonlTranslator | None = None
jsonl_watcher: ClaudeJsonlWatcher | None = None
screen_capturer: ScreenCapturer | None = None
CLIENT_VISIBLE_TTL_SECONDS = 12
client_state = {
    "visible": False,
    "updated_at": 0.0,
}
BACKGROUND_SOURCES = {"nudge", "self_alarm", "diary"}


async def _send_server_nudge(message_id: str, session_id: str | None, text: str):
    await _send_background_prompt("nudge", message_id, session_id, text, None)


async def _send_scheduled_wake(
    source: str,
    message_id: str,
    session_id: str | None,
    text: str,
    scheduled_at: str | None,
):
    await _send_background_prompt(source, message_id, session_id, text, scheduled_at)


async def _send_background_prompt(
    source: str,
    message_id: str,
    session_id: str | None,
    text: str,
    scheduled_at: str | None,
):
    if source not in BACKGROUND_SOURCES:
        source = "nudge"
    client_id = f"server-{source.replace('_', '-')}"
    await manager.send(client_id, {
        "type": "message",
        "role": "user",
        "text": text,
        "message_id": message_id,
        "timestamp": time.time(),
        "mode": "message",
        "source": source,
        "attachments": [],
    })
    await manager.send(client_id, {
        "type": "send_status",
        "message_id": message_id,
        "status": "delivered",
        "timestamp": time.time(),
        "mode": "message",
        "source": source,
    })
    if BACKEND_MODE == "live":
        await handle_live_message(client_id, "message", text, message_id, source=source, scheduled_at=scheduled_at)
        return

    async def send_event(event):
        event["mode"] = "message"
        event["source"] = source
        event["turn_id"] = message_id
        await manager.send(client_id, event)

    asyncio.create_task(generate_mock_reply("message", text, send_event))


push_service = PushService(DATA_DIR / "push_subscriptions.json")
nudge_service = NudgeService(DATA_DIR / "nudge_state.json", push_service, _send_server_nudge)
scheduled_wake_service = ScheduledWakeService(DATA_DIR / "scheduled_wake_state.json", _send_scheduled_wake)
voice_service = VoiceService(DATA_DIR / "voice_settings.json")


def _cookie_secure(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return proto == "https"


def _sign_session(username: str, expires_at: int) -> str:
    payload = f"{username}:{expires_at}"
    sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _valid_session_token(token: str | None) -> bool:
    if not AUTH_ENABLED:
        return True
    if not token:
        return False
    try:
        username, expires_raw, sig = token.rsplit(":", 2)
        expires_at = int(expires_raw)
    except (ValueError, TypeError):
        return False
    payload = f"{username}:{expires_at}"
    expected = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return (
        username == AUTH_USERNAME
        and expires_at > int(time.time())
        and hmac.compare_digest(sig, expected)
    )


def _require_auth(request: Request):
    if not _valid_session_token(request.cookies.get(AUTH_COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="Not authenticated")


def _require_local_mcp(request: Request):
    forwarded_for = request.headers.get("x-forwarded-for")
    client_host = request.client.host if request.client else ""
    if forwarded_for or client_host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="MCP bridge endpoints are local-only")


def _safe_filename(name: str | None) -> str:
    base = Path(name or "attachment").name
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .")
    return cleaned or "attachment"


def _today_upload_dir() -> Path:
    date_dir = datetime.now().strftime("%Y-%m-%d")
    target = UPLOAD_DIR / date_dir
    target.mkdir(parents=True, exist_ok=True)
    return target


def _cleanup_old_uploads() -> None:
    if UPLOAD_RETENTION_DAYS <= 0 or not UPLOAD_DIR.exists():
        return
    cutoff = datetime.now().date() - timedelta(days=UPLOAD_RETENTION_DAYS)
    for child in UPLOAD_DIR.iterdir():
        if not child.is_dir():
            continue
        try:
            folder_date = datetime.strptime(child.name, "%Y-%m-%d").date()
        except ValueError:
            continue
        if folder_date < cutoff:
            shutil.rmtree(child, ignore_errors=True)


def _resolve_inside(root: Path, *parts: str) -> Path:
    root_resolved = root.resolve()
    target = root_resolved.joinpath(*parts).resolve()
    if target != root_resolved and root_resolved not in target.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return target


def _media_url_for_path(path: str | None) -> str | None:
    if not path:
        return None
    if path.startswith(("http://", "https://", "/api/")):
        return path
    try:
        resolved = Path(path).expanduser().resolve()
    except OSError:
        return None

    try:
        relative = resolved.relative_to(UPLOAD_DIR.resolve())
        if len(relative.parts) >= 2:
            return f"/api/uploads/{'/'.join(relative.parts)}"
    except ValueError:
        pass

    try:
        relative = resolved.relative_to(STICKER_DIR.resolve())
        return f"/api/stickers/{'/'.join(relative.parts)}"
    except ValueError:
        return None


def _classify_attachment(mime_type: str | None, requested_kind: str | None = None) -> str:
    if requested_kind in {"image", "document", "audio", "sticker"}:
        return requested_kind
    if mime_type and mime_type.startswith("image/"):
        return "image"
    if mime_type and mime_type.startswith("audio/"):
        return "audio"
    return "document"


def _parse_attachment_refs(value: object) -> list[AttachmentRef]:
    if not isinstance(value, list):
        return []
    attachments: list[AttachmentRef] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind") or item.get("type")
        if kind not in {"image", "document", "audio", "sticker"}:
            continue
        path = item.get("path") or item.get("url")
        if not isinstance(path, str) or not path.strip():
            continue
        name = item.get("name")
        mime_type = item.get("mime_type") or item.get("mimeType")
        transcript = item.get("transcript")
        duration = item.get("duration")
        attachments.append(
            AttachmentRef(
                kind=kind,  # type: ignore[arg-type]
                path=path.strip(),
                name=name if isinstance(name, str) else None,
                mime_type=mime_type if isinstance(mime_type, str) else None,
                transcript=transcript if isinstance(transcript, str) else None,
                duration=duration if isinstance(duration, (int, float)) else None,
            )
        )
    return attachments


def _load_sticker_entries() -> list[dict]:
    if not STICKER_INDEX_PATH.is_file():
        return []
    try:
        raw = json.loads(STICKER_INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(raw, dict):
        if isinstance(raw.get("stickers"), list):
            entries = raw["stickers"]
        elif isinstance(raw.get("items"), list):
            entries = raw["items"]
        else:
            entries = list(raw.values())
    elif isinstance(raw, list):
        entries = raw
    else:
        entries = []
    return [entry for entry in entries if isinstance(entry, dict)]


def _sticker_files() -> list[Path]:
    if not STICKER_DIR.is_dir():
        return []
    return sorted(
        (path for path in STICKER_DIR.iterdir() if path.is_file() and path.suffix.lower() == ".webp"),
        key=lambda path: path.name.lower(),
    )


def _sticker_file_names() -> list[str]:
    return [path.name for path in _sticker_files()]


def _find_sticker_file(filename: str) -> Path | None:
    requested = Path(filename.strip()).name
    if not requested:
        return None
    candidates = [requested]
    if not requested.lower().endswith(".webp"):
        candidates.append(f"{requested}.webp")

    by_name = {path.name.lower(): path for path in _sticker_files()}
    for candidate in candidates:
        sticker_path = by_name.get(candidate.lower())
        if sticker_path:
            return sticker_path
    return None


def _sticker_id(entry: dict) -> str:
    for key in ("id", "file_unique_id", "unique_id"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    local_path = entry.get("local_path")
    if isinstance(local_path, str) and local_path.strip():
        return Path(local_path).stem
    file_name = entry.get("file")
    if isinstance(file_name, str) and file_name.strip():
        return Path(file_name).stem
    return ""


def _sticker_path(entry: dict) -> Path | None:
    sticker_id = _sticker_id(entry)
    if sticker_id:
        target = (STICKER_DIR / f"{sticker_id}.webp").resolve()
        if target.is_file():
            return target
    file_name = entry.get("file")
    if isinstance(file_name, str) and file_name.strip():
        target = (STICKER_DIR / Path(file_name).name).resolve()
        if target.is_file():
            return target
    local_path = entry.get("local_path")
    if isinstance(local_path, str) and local_path.strip():
        target = Path(local_path).expanduser()
        if target.is_file():
            return target
    return None


def _public_stickers(include_media: bool = False) -> list[dict]:
    stickers: list[dict] = []
    for sticker_path in _sticker_files():
        sticker_id = sticker_path.name
        item = {
            "id": sticker_id,
            "tags": [sticker_path.stem],
        }
        if include_media:
            item.update({
                "kind": "sticker",
                "name": sticker_path.name,
                "path": str(sticker_path),
                "url": _media_url_for_path(str(sticker_path)),
            })
        stickers.append(item)
    return stickers


def _split_sticker_query(query: str) -> list[str]:
    return [part.strip() for part in re.split(r"[\s,，、;；|/]+", query) if part.strip()]


def _find_sticker(query: str) -> dict | None:
    query = query.strip()
    if not query:
        return None
    entries = _load_sticker_entries()

    for entry in entries:
        ids = [
            _sticker_id(entry),
            str(entry.get("file_id") or ""),
            str(entry.get("file_unique_id") or ""),
        ]
        if query in ids:
            return entry

    tokens = _split_sticker_query(query)
    best: tuple[int, dict] | None = None
    for entry in entries:
        tags = [str(tag).strip() for tag in entry.get("tags", []) if str(tag).strip()]
        description = str(entry.get("description") or "")
        score = 0
        for token in tokens:
            if token in tags:
                score += 10
            elif any(token in tag or tag in token for tag in tags):
                score += 4
            if token and token in description:
                score += 2
        if tokens and all(token in tags for token in tokens):
            score += 8
        if query and query in description:
            score += 3
        if score > 0 and (best is None or score > best[0]):
            best = (score, entry)
    return best[1] if best else None


async def emit_cc_event(event: dict):
    event_type = event.get("type")
    if event_type in {"stream_end", "turn_complete"} and screen_capturer:
        screen_capturer.stop_turn()
    if translator and translator.active_turn:
        if "mode" not in event:
            event["mode"] = translator.active_turn.mode
        if "turn_id" not in event:
            event["turn_id"] = translator.active_turn.user_message_id
        if "source" not in event and translator.active_turn.source != "manual":
            event["source"] = translator.active_turn.source
        _notify_pushworthy_message(event)
        await manager.send(translator.active_turn.client_id, event)
    else:
        _notify_pushworthy_message(event)
        await manager.broadcast(event)


def _notify_pushworthy_message(event: dict):
    if event.get("mode") != "message":
        return
    if event.get("type") != "message" or event.get("role") != "assistant":
        return
    push_reason = event.get("push_reason")
    # Plain background-source events are archived to the Activity page. Explicit
    # MCP send_message/reply_message events from those turns are Message-page
    # messages and carry push_reason=<source>-message.
    if event.get("source") in BACKGROUND_SOURCES and not _is_background_message_push(push_reason):
        return
    text = event.get("text")
    body = text.strip() if isinstance(text, str) and text.strip() else _attachment_push_body(event.get("attachments"))
    if not body:
        return
    # Suppress server-side using the page's Page Visibility API (reliable across
    # background/lock), not the service worker's Clients API (which falsely
    # reports a backgrounded PWA window as visible on Android).
    if _client_has_visible_page():
        age = time.time() - float(client_state.get("updated_at") or 0)
        print(f"[push] suppressed: visible=True, age={age:.1f}s (ttl={CLIENT_VISIBLE_TTL_SECONDS}s)", flush=True)
        return
    message_id = str(event.get("message_id") or event.get("turn_id") or "message")
    tag_prefix = str(push_reason) if _is_background_message_push(push_reason) else "message-reply"
    asyncio.create_task(push_service.send_notification(
        "Claude",
        body[:180],
        "/message",
        f"{tag_prefix}-{message_id}",
    ))


def _is_background_message_push(push_reason: object) -> bool:
    return isinstance(push_reason, str) and push_reason in {
        "nudge-message",
        "self-alarm-message",
        "diary-message",
    }


def _attachment_push_body(attachments: object) -> str:
    """Fallback push body for caption-less attachment messages (voice/image/
    sticker) so background-turn sends still notify even with empty text."""
    if not isinstance(attachments, list):
        return ""
    kinds = {a.get("kind") for a in attachments if isinstance(a, dict)}
    if "audio" in kinds:
        return "Claude 给你发了一条语音 🎵"
    if "sticker" in kinds:
        return "Claude 发了个表情 🐱"
    if "image" in kinds:
        return "Claude 发来一张图片 🖼️"
    if "document" in kinds:
        return "Claude 发来一个文件 📎"
    return ""


def _client_has_visible_page() -> bool:
    updated_at = float(client_state.get("updated_at") or 0)
    return bool(client_state.get("visible")) and time.time() - updated_at <= CLIENT_VISIBLE_TTL_SECONDS


@app.on_event("startup")
async def startup():
    global translator, jsonl_watcher, screen_capturer
    _cleanup_old_uploads()
    nudge_service.start()
    scheduled_wake_service.start()
    if BACKEND_MODE != "live":
        return
    translator = ClaudeJsonlTranslator(emit_cc_event)
    jsonl_watcher = ClaudeJsonlWatcher(translator)
    jsonl_watcher.start()
    screen_capturer = ScreenCapturer(tmux_bridge, emit_cc_event)


@app.on_event("shutdown")
async def shutdown():
    await nudge_service.stop()
    await scheduled_wake_service.stop()
    if jsonl_watcher:
        await jsonl_watcher.stop()
    if screen_capturer:
        screen_capturer.stop_turn()


@app.get("/api/auth/status")
async def auth_status(request: Request):
    return {
        "auth_required": AUTH_ENABLED,
        "authenticated": _valid_session_token(request.cookies.get(AUTH_COOKIE_NAME)),
        "username": AUTH_USERNAME if AUTH_ENABLED else None,
    }


@app.post("/api/auth/login")
async def auth_login(payload: dict, request: Request, response: Response):
    username = (payload or {}).get("username") or ""
    password = (payload or {}).get("password") or ""

    if AUTH_ENABLED and (
        not hmac.compare_digest(username, AUTH_USERNAME)
        or not hmac.compare_digest(password, AUTH_PASSWORD or "")
    ):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    expires_at = int(time.time()) + AUTH_MAX_AGE
    response.set_cookie(
        AUTH_COOKIE_NAME,
        _sign_session(AUTH_USERNAME, expires_at),
        max_age=AUTH_MAX_AGE,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path="/",
    )
    return {"status": "ok", "expires_at": expires_at}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"status": "ok"}


@app.get("/health")
async def health(request: Request):
    _require_auth(request)
    active = translator.active_turn if translator else None
    return {
        "status": "ok",
        "mode": BACKEND_MODE,
        "connections": len(manager.connections),
        "tmux": {
            "session": tmux_bridge.session_name,
            "available": tmux_bridge.available(),
        },
        "translator": {
            "active_turn_mode": active.mode if active else None,
            "active_turn_id": active.user_message_id if active else None,
            "queued_turns": len(translator._queued_turns) if translator else 0,
            "bridge_pending": translator._bridge_completions_pending_jsonl_end if translator else 0,
            "turn_completed": translator._turn_completed if translator else None,
            "lines_seen": translator.lines_seen if translator else 0,
            "events_emitted": translator.events_emitted if translator else 0,
            "last_line_at": translator.last_line_at if translator else None,
            "last_event_at": translator.last_event_at if translator else None,
        },
        "watcher": jsonl_watcher.status() if jsonl_watcher else None,
        "nudge": await nudge_service.status(),
        "scheduled_wake": await scheduled_wake_service.status(),
        "push": {
            "configured": push_service.configured,
            "subscriptions": len(await push_service.list_subscriptions()),
        },
        "client": {
            "visible": _client_has_visible_page(),
            "last_seen_at": client_state["updated_at"],
        },
    }


@app.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    kind: str | None = Form(None),
):
    _require_auth(request)
    _cleanup_old_uploads()

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")

    upload_dir = _today_upload_dir()
    original_name = _safe_filename(file.filename)
    filename = f"{uuid.uuid4().hex}_{original_name}"
    filepath = upload_dir / filename
    with open(filepath, "wb") as f:
        f.write(content)

    mime_type = file.content_type or None
    attachment_kind = _classify_attachment(mime_type, kind)
    return {
        "kind": attachment_kind,
        "filename": filename,
        "name": file.filename or original_name,
        "path": str(filepath),
        "url": _media_url_for_path(str(filepath)),
        "mime_type": mime_type,
        "size": len(content),
    }


@app.get("/api/uploads/{date_dir}/{filename:path}")
async def get_upload(date_dir: str, filename: str, request: Request):
    _require_auth(request)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_dir):
        raise HTTPException(status_code=404, detail="File not found")
    target = _resolve_inside(UPLOAD_DIR, date_dir, filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(target)


@app.get("/api/stickers/{filename:path}")
async def get_sticker(filename: str, request: Request):
    _require_auth(request)
    target = _resolve_inside(STICKER_DIR, filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Sticker not found")
    return FileResponse(target)


@app.get("/api/stickers")
async def list_stickers(request: Request):
    _require_auth(request)
    return {"stickers": _public_stickers(include_media=True)}


@app.post("/api/streaming")
async def set_streaming(payload: dict, request: Request):
    _require_auth(request)
    enabled = bool((payload or {}).get("enabled", False))
    if screen_capturer:
        screen_capturer.enabled = enabled
    return {"status": "ok", "enabled": enabled}


@app.get("/api/push/public-key")
async def push_public_key(request: Request):
    _require_auth(request)
    return {
        "configured": push_service.configured,
        "public_key": push_service.vapid_public_key,
    }


@app.post("/api/push/subscribe")
async def push_subscribe(payload: dict, request: Request):
    _require_auth(request)
    if not push_service.configured:
        raise HTTPException(status_code=503, detail="Web Push VAPID keys are not configured")
    try:
        subscription = await push_service.save_subscription(payload or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "endpoint": subscription["endpoint"]}


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(payload: dict, request: Request):
    _require_auth(request)
    endpoint = (payload or {}).get("endpoint")
    removed = await push_service.remove_subscription(endpoint if isinstance(endpoint, str) else "")
    return {"status": "ok", "removed": removed}


@app.post("/api/push/test")
async def push_test(request: Request):
    _require_auth(request)
    result = await push_service.send_notification("Claude Code Web", "Web Push is connected.", "/activity", "push-test")
    return {"status": "ok", **result}


@app.post("/api/push/debug")
async def push_debug(payload: dict):
    print(f"[push-debug] SW ping at {time.time():.0f}: {json.dumps(payload, ensure_ascii=False)}", flush=True)
    return {"status": "ok"}


@app.post("/api/push/client-state")
async def push_client_state(payload: dict, request: Request):
    _require_auth(request)
    prev = client_state.get("visible")
    client_state["visible"] = bool((payload or {}).get("visible", False))
    client_state["updated_at"] = time.time()
    if client_state["visible"] != prev:
        print(f"[visibility] HTTP: {prev} -> {client_state['visible']}", flush=True)
    return {"status": "ok", "visible": client_state["visible"], "updated_at": client_state["updated_at"]}


@app.get("/api/nudge/status")
async def nudge_status(request: Request):
    _require_auth(request)
    subscriptions = await push_service.list_subscriptions()
    return {
        **await nudge_service.status(),
        "push": {
            "configured": push_service.configured,
            "public_key": push_service.vapid_public_key,
            "subscriptions": len(subscriptions),
        },
    }


@app.post("/api/nudge/settings")
async def nudge_settings(payload: dict, request: Request):
    _require_auth(request)
    settings = await nudge_service.update_settings(payload or {})
    return {"status": "ok", "settings": settings}


@app.post("/api/nudge/test")
async def nudge_test_trigger(request: Request):
    _require_auth(request)
    return await nudge_service.trigger_now()


@app.post("/api/nudge/interaction")
async def nudge_interaction(payload: dict, request: Request):
    _require_auth(request)
    session_id = (payload or {}).get("session_id")
    await nudge_service.mark_interaction(session_id=session_id if isinstance(session_id, str) else None)
    return {"status": "ok"}


@app.get("/api/diary/status")
async def diary_status(request: Request):
    _require_auth(request)
    status = await scheduled_wake_service.status()
    subscriptions = await push_service.list_subscriptions()
    return {
        "settings": status["diary"],
        "next_diary_at": status["next_diary_at"],
        "push": {
            "configured": push_service.configured,
            "public_key": push_service.vapid_public_key,
            "subscriptions": len(subscriptions),
        },
    }


@app.post("/api/diary/settings")
async def diary_settings(payload: dict, request: Request):
    _require_auth(request)
    settings = await scheduled_wake_service.update_diary_settings(payload or {})
    return {"status": "ok", "settings": settings}


@app.post("/api/diary/test")
async def diary_test_trigger(request: Request):
    _require_auth(request)
    return await scheduled_wake_service.trigger_diary_now()


@app.get("/api/voice/settings")
async def voice_settings_get(request: Request):
    _require_auth(request)
    return {"settings": await voice_service.status()}


@app.post("/api/voice/settings")
async def voice_settings_post(payload: dict, request: Request):
    _require_auth(request)
    settings = await voice_service.update_settings(payload or {})
    return {"status": "ok", "settings": settings}


@app.post("/api/voice/upload")
async def voice_upload(
    request: Request,
    file: UploadFile = File(...),
    duration: float | None = Form(None),
):
    """Receive a recorded voice blob, persist it (3-day retention applies), and
    transcribe it via STT. Transcript failures are non-fatal — stt_ok=False."""
    _require_auth(request)
    _cleanup_old_uploads()

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")

    upload_dir = _today_upload_dir()
    original_name = _safe_filename(file.filename or "voice.webm")
    filename = f"{uuid.uuid4().hex}_{original_name}"
    filepath = upload_dir / filename
    with open(filepath, "wb") as f:
        f.write(content)

    transcript: str | None = None
    stt_ok = False
    if voice_service.stt_enabled:
        try:
            transcript = await voice_service.transcribe(content, original_name)
            stt_ok = True
        except (VoiceServiceError, httpx.HTTPError) as exc:
            print(f"[voice] STT failed: {type(exc).__name__}: {exc}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[voice] STT unexpected error: {type(exc).__name__}: {exc}", flush=True)

    return {
        "kind": "audio",
        "filename": filename,
        "path": str(filepath),
        "url": _media_url_for_path(str(filepath)),
        "duration": duration,
        "transcript": transcript,
        "stt_ok": stt_ok,
    }


# ============================================================================
# Bridge MCP endpoints — called by mcp-server/server.py when CC invokes its
# tools. Bypasses JSONL watcher's tool-use parsing entirely.
# ============================================================================

async def _mcp_emit(event: dict, turn=None):
    """Route MCP-originated events to the active turn's client, or broadcast.

    `turn` may be a captured turn snapshot (for async emits whose originating turn
    may have ended); defaults to the live active turn."""
    event_type = event.get("type")
    if event_type in {"stream_end", "turn_complete"} and screen_capturer:
        screen_capturer.stop_turn()
    active = turn if turn is not None else (translator.active_turn if translator else None)
    if active:
        active_source = active.source
        if "mode" not in event:
            event["mode"] = active.mode
        # MCP-originated events are explicit messages to user. During background
        # turns, don't inherit the background turn_id: it can carry a session id
        # that would make the frontend session-filter the visible message away.
        if "turn_id" not in event and active_source not in BACKGROUND_SOURCES:
            event["turn_id"] = active.user_message_id
        if (
            active_source in BACKGROUND_SOURCES
            and event.get("type") == "message"
            and event.get("role") == "assistant"
            and event.get("mode") == "message"
            and "push_reason" not in event
        ):
            event["push_reason"] = f"{active_source.replace('_', '-')}-message"
        _notify_pushworthy_message(event)
        if _is_background_message_push(event.get("push_reason")):
            await manager.broadcast(event)
            return
        await manager.send(active.client_id, event)
    else:
        _notify_pushworthy_message(event)
        await manager.broadcast(event)


@app.post("/api/mcp/send_message")
async def mcp_send_message(payload: dict, request: Request):
    _require_local_mcp(request)
    text = (payload or {}).get("text") or ""
    if not text:
        return {"status": "noop", "reason": "empty text"}
    mode = translator.active_turn.mode if translator and translator.active_turn else "message"
    if mode == "cabin":
        message_id = str(uuid.uuid4())
        await _mcp_emit({
            "type": "stream_start",
            "message_id": message_id,
            "timestamp": time.time(),
            "mode": "cabin",
        })
        await _mcp_emit({
            "type": "stream_chunk",
            "message_id": message_id,
            "chunk": text,
            "mode": "cabin",
        })
        await _mcp_emit({
            "type": "stream_end",
            "message_id": message_id,
            "timestamp": time.time(),
            "mode": "cabin",
        })
        return {"status": "delivered", "mode": "cabin"}
    # No thinking attachment here — watcher emits `thinking` event separately
    # and the frontend attaches it retroactively to the latest assistant bubble.
    # This avoids the bridge-vs-watcher race (watcher is ~300ms slower than
    # MCP-stdio bridge POST, so spinwaiting here forces unacceptable latency).
    await _mcp_emit({
        "type": "message",
        "role": "assistant",
        "text": text,
        "message_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "mode": "message",
    })
    return {"status": "delivered"}


@app.post("/api/mcp/reply_message")
async def mcp_reply_message(payload: dict, request: Request):
    _require_local_mcp(request)
    payload = payload or {}
    text = payload.get("text") or ""
    quoted_text = payload.get("quoted_text") or ""
    if not text:
        return {"status": "noop", "reason": "empty text"}
    quoted_role = payload.get("quoted_role")
    if quoted_role not in {"user", "assistant"}:
        quoted_role = "user"
    await _mcp_emit({
        "type": "message",
        "role": "assistant",
        "text": text,
        "message_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "mode": "message",
        "reply_to": {
            "messageId": f"quoted-{uuid.uuid4()}",
            "role": quoted_role,
            "text": quoted_text,
            "timestamp": None,
        },
    })
    return {"status": "delivered"}


@app.post("/api/mcp/wait_for_user")
async def mcp_wait_for_user(request: Request, payload: dict | None = None):
    _require_local_mcp(request)
    if translator:
        await translator.wait_for_user()
    else:
        await _mcp_emit({"type": "turn_complete", "timestamp": time.time()})
    return {"status": "waiting"}


@app.post("/api/mcp/send_image")
async def mcp_send_image(payload: dict, request: Request):
    _require_local_mcp(request)
    payload = payload or {}
    path = payload.get("path")
    url = payload.get("url")
    caption = payload.get("caption")
    image_url = url if isinstance(url, str) and url.strip() else None
    image_path = path if isinstance(path, str) and path.strip() else None
    if not image_url:
        image_url = _media_url_for_path(image_path)
    if not image_url:
        return {"status": "noop", "reason": "missing image path or url"}
    name = Path(image_path).name if image_path else None
    await _mcp_emit({
        "type": "message",
        "role": "assistant",
        "text": caption if isinstance(caption, str) else "",
        "message_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "attachments": [{
            "kind": "image",
            "url": image_url,
            "path": image_path or image_url,
            "name": name,
        }],
    })
    return {"status": "delivered"}


@app.post("/api/mcp/load_stickers")
async def mcp_load_stickers(request: Request, payload: dict | None = None):
    _require_local_mcp(request)
    stickers = _sticker_file_names()
    return {"status": "ok", "stickers": stickers, "count": len(stickers)}


@app.post("/api/mcp/send_sticker")
async def mcp_send_sticker(payload: dict, request: Request):
    _require_local_mcp(request)
    payload = payload or {}
    filename = payload.get("sticker") or payload.get("filename") or payload.get("name")
    if not isinstance(filename, str) or not filename.strip():
        return {"status": "noop", "reason": "missing sticker filename"}
    sticker_path = _find_sticker_file(filename)
    if not sticker_path:
        return {
            "status": "missing_file",
            "filename": filename,
            "available": _sticker_file_names(),
        }
    sticker_url = _media_url_for_path(str(sticker_path))
    if not sticker_url:
        return {"status": "missing_file", "filename": filename}
    caption = payload.get("caption")
    await _mcp_emit({
        "type": "message",
        "role": "assistant",
        "text": caption if isinstance(caption, str) else "",
        "message_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "attachments": [{
            "kind": "sticker",
            "url": sticker_url,
            "path": str(sticker_path),
            "name": sticker_path.name,
        }],
    })
    return {
        "status": "delivered",
        "filename": sticker_path.name,
    }


@app.post("/api/mcp/send_voice")
async def mcp_send_voice(payload: dict, request: Request):
    _require_local_mcp(request)
    payload = payload or {}
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return {"status": "noop", "reason": "missing text"}
    text = text.strip()
    voice_id = payload.get("voice_id")
    voice_id = voice_id.strip() if isinstance(voice_id, str) and voice_id.strip() else None

    # Snapshot the originating turn, then synthesize + deliver in the background so
    # CC's tool call returns instantly instead of blocking on (possibly slow or
    # failing) TTS. The snapshot keeps routing correct if the turn ends meanwhile.
    turn = translator.active_turn if translator else None
    snapshot = (
        SimpleNamespace(
            client_id=turn.client_id,
            mode=turn.mode,
            source=turn.source,
            user_message_id=turn.user_message_id,
        )
        if turn
        else None
    )
    asyncio.create_task(_synthesize_voice_and_emit(text, voice_id, snapshot))
    return {"status": "queued"}


async def _synthesize_voice_and_emit(text: str, voice_id: str | None, turn) -> None:
    try:
        audio_bytes, duration_s, fmt = await voice_service.synthesize(text, voice_id)
        _cleanup_old_uploads()
        upload_dir = _today_upload_dir()
        filename = f"{uuid.uuid4().hex}_voice.{fmt}"
        filepath = upload_dir / filename
        with open(filepath, "wb") as f:
            f.write(audio_bytes)
        await _mcp_emit({
            "type": "message",
            "role": "assistant",
            "text": "",
            "message_id": str(uuid.uuid4()),
            "timestamp": time.time(),
            "attachments": [{
                "kind": "audio",
                "url": _media_url_for_path(str(filepath)),
                "path": str(filepath),
                "duration": duration_s,
                "transcript": text,
            }],
        }, turn=turn)
        return
    except (VoiceServiceError, httpx.HTTPError) as exc:
        print(f"[voice] TTS fallback to text: {type(exc).__name__}: {exc}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] TTS unexpected error, fallback to text: {type(exc).__name__}: {exc}", flush=True)

    # Fallback: deliver what CC wanted to say as a plain text bubble.
    await _mcp_emit({
        "type": "message",
        "role": "assistant",
        "text": text,
        "message_id": str(uuid.uuid4()),
        "timestamp": time.time(),
    }, turn=turn)


@app.post("/api/mcp/set_self_alarm")
async def mcp_set_self_alarm(payload: dict, request: Request):
    _require_local_mcp(request)
    payload = payload or {}
    try:
        return await scheduled_wake_service.add_self_alarm(payload.get("wake_at"), payload.get("reason"))
    except OverflowError as exc:
        return {"status": "error", "error": str(exc), "max_pending": 50}
    except ValueError as exc:
        return {"status": "error", "error": str(exc)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    if not _valid_session_token(websocket.cookies.get(AUTH_COOKIE_NAME)):
        await websocket.close(code=1008)
        return

    client_id = str(uuid.uuid4())
    await manager.connect(client_id, websocket)
    try:
        last_event_seq = int(websocket.query_params.get("last_event_seq") or 0)
    except ValueError:
        last_event_seq = 0

    client_session = websocket.query_params.get("session") or ""
    if client_session and client_session != BACKEND_SESSION_ID:
        last_event_seq = 0

    try:
        await websocket.send_json({
            "type": "connected",
            "client_id": client_id,
            "session_id": BACKEND_SESSION_ID,
        })
        await manager.replay_since(client_id, last_event_seq)

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            elif msg_type == "client_state":
                prev = client_state.get("visible")
                client_state["visible"] = bool(data.get("visible", False))
                client_state["updated_at"] = time.time()
                if client_state["visible"] != prev:
                    print(f"[visibility] WS: {prev} -> {client_state['visible']}", flush=True)

            elif msg_type == "send_message":
                mode = data.get("mode", "message")
                text = data.get("text", "")
                userstyle = data.get("userstyle")
                reply_to = data.get("reply_to")
                attachments = data.get("attachments")
                message_id = data.get("message_id", str(uuid.uuid4()))
                source = "nudge" if data.get("source") == "nudge" else "manual"
                if source == "manual":
                    await nudge_service.mark_interaction(session_id=_session_id_from_message_id(str(message_id)))

                # Echo user message back (recorded with seq for replay)
                await manager.send(client_id, {
                    "type": "message",
                    "role": "user",
                    "text": text,
                    "message_id": message_id,
                    "timestamp": time.time(),
                    "mode": mode,
                    "source": source,
                    "attachments": attachments if isinstance(attachments, list) else [],
                })
                if BACKEND_MODE == "live":
                    await handle_live_message(
                        client_id,
                        mode,
                        text,
                        message_id,
                        userstyle,
                        reply_to,
                        attachments,
                        data.get("streaming_enabled"),
                        source,
                    )
                    continue

                await manager.send(client_id, {
                    "type": "send_status",
                    "message_id": message_id,
                    "status": "delivered",
                    "timestamp": time.time(),
                    "mode": mode,
                    "source": source,
                })

                # Generate mock reply
                async def send_event(event):
                    event["mode"] = mode
                    if source != "manual":
                        event["source"] = source
                        event["turn_id"] = message_id
                    await manager.send(client_id, event)

                asyncio.create_task(
                    generate_mock_reply(mode, text, send_event)
                )

    except WebSocketDisconnect:
        await manager.disconnect(client_id)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"[ws] client {client_id} dropped: {type(exc).__name__}: {exc}", flush=True)
        await manager.disconnect(client_id)


async def handle_live_message(
    client_id: str,
    mode: str,
    text: str,
    message_id: str,
    userstyle: object = None,
    reply_to: object = None,
    attachments: object = None,
    streaming_enabled: object = None,
    source: str = "manual",
    scheduled_at: str | None = None,
):
    if mode not in {"message", "cabin"}:
        mode = "message"

    active_now = True
    if translator:
        active_now = translator.start_or_queue_turn(client_id, mode, message_id, source)

    if active_now and screen_capturer and mode == "cabin":
        if isinstance(streaming_enabled, bool):
            screen_capturer.enabled = streaming_enabled
        await screen_capturer.start_turn()

    prompt = build_cc_prompt(
        FrontendMessage(
            mode=mode,  # type: ignore[arg-type]
            text=text,
            message_id=message_id,
            source=source if source in BACKGROUND_SOURCES else "manual",  # type: ignore[arg-type]
            scheduled_at=scheduled_at,
            userstyle=userstyle if isinstance(userstyle, str) else None,
            reply_to=_parse_reply_ref(reply_to),
            attachments=_parse_attachment_refs(attachments),
        ),
    )

    try:
        paste_visible = await tmux_bridge.send_input(prompt)
        if paste_visible:
            await manager.send(client_id, {
                "type": "send_status",
                "message_id": message_id,
                "status": "read",
                "timestamp": time.time(),
                "mode": mode,
                "source": source,
            })
        else:
            print(f"[tmux] paste not visible for message {message_id}", flush=True)
            if translator:
                translator.abandon_turn(message_id)
            await manager.send(client_id, {
                "type": "send_status",
                "message_id": message_id,
                "status": "retry",
                "timestamp": time.time(),
                "mode": mode,
                "source": source,
            })
    except TmuxBridgeError as exc:
        if translator:
            translator.abandon_turn(message_id)
        await manager.send(client_id, {
            "type": "send_status",
            "message_id": message_id,
            "status": "retry",
            "timestamp": time.time(),
            "mode": mode,
            "source": source,
        })
        await manager.send(client_id, {
            "type": "message",
            "role": "assistant",
            "text": f"后端还没连上 Claude Code：{exc}",
            "message_id": str(uuid.uuid4()),
            "timestamp": time.time(),
            "mode": mode,
            "source": source,
        })
        await manager.send(client_id, {"type": "turn_complete", "mode": mode, "source": source})


def _parse_reply_ref(value: object) -> ReplyRef | None:
    if not isinstance(value, dict):
        return None
    message_id = value.get("messageId")
    role = value.get("role")
    text = value.get("text")
    timestamp = value.get("timestamp")
    if not isinstance(message_id, str) or role not in {"user", "assistant"} or not isinstance(text, str):
        return None
    return ReplyRef(
        message_id=message_id,
        role=role,  # type: ignore[arg-type]
        text=text,
        timestamp=timestamp if isinstance(timestamp, (int, float)) else None,
    )


def _session_id_from_message_id(message_id: str) -> str | None:
    if not message_id.startswith("user:"):
        return None
    parts = message_id.split(":")
    if len(parts) < 3:
        return None
    session_id = parts[1]
    return session_id if session_id and session_id != "default" else None
