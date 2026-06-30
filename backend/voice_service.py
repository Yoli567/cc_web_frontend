from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any

import httpx


HTTP_TIMEOUT = 60.0

DEFAULT_STT_BASE_URL = "https://api.siliconflow.cn/v1"
DEFAULT_STT_MODEL = "FunAudioLLM/SenseVoiceSmall"
DEFAULT_STT_LANGUAGE = "zh"

DEFAULT_TTS_BASE_URL = "https://api.minimaxi.com"
DEFAULT_TTS_MODEL = "speech-02-hd"
DEFAULT_TTS_FORMAT = "mp3"
DEFAULT_TTS_SPEED = 1.0

_API_KEY_FIELDS = {"stt_api_key", "tts_api_key"}


class VoiceServiceError(Exception):
    pass


# SenseVoice returns rich transcription: <|zh|><|SAD|> ... style tags plus a
# trailing emotion/event emoji. A voice→text result should never legitimately
# contain emoji, so we strip both the <|...|> tags and emoji entirely.
_RICH_TAG_RE = re.compile(r"<\|[^|>]*\|>")
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F\U00002190-\U000021FF]"
)


def _clean_transcript(text: str) -> str:
    text = _RICH_TAG_RE.sub("", text)
    text = _EMOJI_RE.sub("", text)
    return text.strip()


@dataclass(slots=True)
class VoiceSettings:
    stt_enabled: bool = False
    stt_base_url: str = DEFAULT_STT_BASE_URL
    stt_api_key: str = ""
    stt_model: str = DEFAULT_STT_MODEL
    stt_language: str = DEFAULT_STT_LANGUAGE
    tts_enabled: bool = False
    tts_base_url: str = DEFAULT_TTS_BASE_URL
    tts_api_key: str = ""
    tts_group_id: str = ""
    tts_model: str = DEFAULT_TTS_MODEL
    tts_voice_id: str = ""
    tts_speed: float = DEFAULT_TTS_SPEED
    tts_format: str = DEFAULT_TTS_FORMAT


def _coerce(current: Any, raw: Any) -> Any:
    if isinstance(current, bool):
        return bool(raw)
    if isinstance(current, float):
        try:
            return float(raw)
        except (TypeError, ValueError):
            return current
    if isinstance(current, str):
        return raw.strip() if isinstance(raw, str) else current
    return current


class VoiceService:
    """STT (Whisper / OpenAI-compatible) + TTS (MiniMax T2A v2) with JSON-persisted
    settings. Mirrors the persistence pattern of NudgeService."""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._lock = asyncio.Lock()
        self._settings = self._load_settings()

    # ---- persistence ----
    def _load_settings(self) -> VoiceSettings:
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return VoiceSettings()
        data = raw.get("settings") if isinstance(raw, dict) and isinstance(raw.get("settings"), dict) else raw
        settings = VoiceSettings()
        if isinstance(data, dict):
            for field in fields(VoiceSettings):
                if field.name in data:
                    setattr(settings, field.name, _coerce(getattr(settings, field.name), data[field.name]))
        return settings

    def _save_settings(self) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.storage_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"settings": asdict(self._settings)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(self.storage_path)

    # ---- settings api (key fields masked) ----
    @staticmethod
    def _public_dict(settings: VoiceSettings) -> dict[str, Any]:
        data = asdict(settings)
        for key in _API_KEY_FIELDS:
            data.pop(key, None)
            data[f"{key}_set"] = bool(getattr(settings, key))
        return data

    async def status(self) -> dict[str, Any]:
        async with self._lock:
            return self._public_dict(self._settings)

    async def update_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            settings = self._settings
            for field in fields(VoiceSettings):
                if field.name not in values:
                    continue
                raw = values[field.name]
                if field.name in _API_KEY_FIELDS:
                    # Empty string means "keep existing key" so the masked UI
                    # doesn't wipe a stored secret on save.
                    if isinstance(raw, str) and raw.strip():
                        setattr(settings, field.name, raw.strip())
                    continue
                setattr(settings, field.name, _coerce(getattr(settings, field.name), raw))
            self._save_settings()
            return self._public_dict(settings)

    @property
    def stt_enabled(self) -> bool:
        return self._settings.stt_enabled

    @property
    def tts_enabled(self) -> bool:
        return self._settings.tts_enabled

    # ---- STT: OpenRouter (JSON base64) or Whisper-style multipart ----
    async def transcribe(self, audio_bytes: bytes, filename: str | None) -> str:
        settings = self._settings
        if not settings.stt_enabled:
            raise VoiceServiceError("STT 未启用")
        base = settings.stt_base_url.strip().rstrip("/")
        if not base:
            raise VoiceServiceError("STT base_url 未配置")
        model = settings.stt_model or DEFAULT_STT_MODEL
        headers: dict[str, str] = {}
        if settings.stt_api_key:
            headers["Authorization"] = f"Bearer {settings.stt_api_key}"
        url = f"{base}/audio/transcriptions"

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, trust_env=True) as client:
            if "openrouter" in base:
                # OpenRouter takes JSON with base64 audio, not multipart file upload.
                fmt = (Path(filename or "audio.webm").suffix.lstrip(".") or "webm").lower()
                payload: dict[str, Any] = {
                    "model": model,
                    "input_audio": {"data": base64.b64encode(audio_bytes).decode("ascii"), "format": fmt},
                }
                if settings.stt_language:
                    payload["language"] = settings.stt_language
                headers["Content-Type"] = "application/json"
                resp = await client.post(url, headers=headers, json=payload)
            else:
                files = {"file": (filename or "audio.webm", audio_bytes, "application/octet-stream")}
                data = {"model": model}
                if settings.stt_language:
                    data["language"] = settings.stt_language
                resp = await client.post(url, headers=headers, files=files, data=data)
            resp.raise_for_status()
            body = resp.json()

        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise VoiceServiceError("STT 返回空结果")
        cleaned = _clean_transcript(text)
        if not cleaned:
            raise VoiceServiceError("STT 返回空结果")
        return cleaned

    # ---- TTS: MiniMax T2A v2 ----
    async def synthesize(self, text: str, voice_id: str | None = None) -> tuple[bytes, int, str]:
        settings = self._settings
        if not settings.tts_enabled:
            raise VoiceServiceError("TTS 未启用")
        if not settings.tts_api_key:
            raise VoiceServiceError("TTS api_key 未配置")
        base = settings.tts_base_url.strip().rstrip("/") or DEFAULT_TTS_BASE_URL
        # Accept either a bare host (we append /v1/t2a_v2) or a full endpoint URL.
        url = base if base.endswith("/t2a_v2") else f"{base}/v1/t2a_v2"
        params = {}
        if settings.tts_group_id:
            params["GroupId"] = settings.tts_group_id
        headers = {
            "Authorization": f"Bearer {settings.tts_api_key}",
            "Content-Type": "application/json",
        }
        voice_setting: dict[str, Any] = {"speed": settings.tts_speed}
        chosen_voice = (voice_id or settings.tts_voice_id or "").strip()
        if chosen_voice:
            voice_setting["voice_id"] = chosen_voice
        fmt = settings.tts_format or DEFAULT_TTS_FORMAT
        payload = {
            "model": settings.tts_model or DEFAULT_TTS_MODEL,
            "text": text,
            "stream": False,
            "output_format": "hex",
            "voice_setting": voice_setting,
            "audio_setting": {"format": fmt},
        }
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, trust_env=True) as client:
            resp = await client.post(url, params=params, headers=headers, json=payload)
            resp.raise_for_status()
            body = resp.json()

        base_resp = body.get("base_resp") if isinstance(body, dict) else None
        status_code = base_resp.get("status_code") if isinstance(base_resp, dict) else None
        if status_code not in (0, None):
            status_msg = base_resp.get("status_msg") if isinstance(base_resp, dict) else ""
            raise VoiceServiceError(f"MiniMax TTS 失败 [{status_code}] {status_msg}")

        data = body.get("data") if isinstance(body, dict) else None
        audio_hex = data.get("audio") if isinstance(data, dict) else None
        if not isinstance(audio_hex, str) or not audio_hex:
            raise VoiceServiceError("MiniMax TTS 返回空音频")
        try:
            audio_bytes = binascii.unhexlify(audio_hex)
        except (binascii.Error, ValueError) as exc:
            raise VoiceServiceError(f"音频解码失败: {exc}")

        extra = body.get("extra_info") if isinstance(body, dict) else None
        audio_length_ms = extra.get("audio_length") if isinstance(extra, dict) else None
        duration_s = (
            max(1, round(audio_length_ms / 1000))
            if isinstance(audio_length_ms, (int, float)) and audio_length_ms
            else 1
        )
        return audio_bytes, duration_s, fmt
