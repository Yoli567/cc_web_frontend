from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo


ChatMode = Literal["message", "cabin"]
MessageSource = Literal["manual", "nudge", "self_alarm", "diary"]


@dataclass(slots=True)
class AttachmentRef:
    kind: Literal["image", "document", "audio", "sticker"]
    path: str
    name: str | None = None
    mime_type: str | None = None
    transcript: str | None = None
    duration: float | None = None


@dataclass(slots=True)
class ReplyRef:
    message_id: str
    role: Literal["user", "assistant"]
    text: str
    timestamp: float | None = None


@dataclass(slots=True)
class FrontendMessage:
    mode: ChatMode
    text: str
    message_id: str
    source: MessageSource = "manual"
    scheduled_at: str | None = None
    userstyle: str | None = None
    reply_to: ReplyRef | None = None
    attachments: list[AttachmentRef] = field(default_factory=list)


BEIJING_TZ = ZoneInfo("Asia/Shanghai")


def build_cc_prompt(message: FrontendMessage) -> str:
    """Build the exact prompt pasted into Claude Code for one frontend message."""
    if message.source == "nudge":
        return _build_nudge_prompt(message)
    if message.source == "self_alarm":
        return _build_self_alarm_prompt(message)
    if message.source == "diary":
        return _build_diary_prompt(message)

    parts = [
        "<cc-web-frontend>",
        "<source>",
        message.mode,
        "</source>",
        "<current_time timezone=\"Asia/Shanghai\">",
        datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "</current_time>",
    ]

    if message.userstyle and message.userstyle.strip():
        parts.extend([
            "<userstyle>",
            message.userstyle.strip(),
            "</userstyle>",
        ])

    if message.attachments:
        parts.extend(["<attachments>", *_format_attachments(message.attachments), "</attachments>"])

    if message.reply_to and message.reply_to.text.strip():
        parts.extend([
            "<reply_to>",
            f"<message_id>{message.reply_to.message_id}</message_id>",
            f"<role>{message.reply_to.role}</role>",
            "<quoted_text>",
            message.reply_to.text.strip(),
            "</quoted_text>",
            "</reply_to>",
        ])

    parts.extend([
        "<user_message>",
        message.text.strip() or "[empty message]",
        "</user_message>",
        "</cc-web-frontend>",
    ])
    return "\n".join(parts)


def _build_nudge_prompt(message: FrontendMessage) -> str:
    """Nudge turns carry only the user's configured instruction. No user_message:
    the normal reply this turn is archived to the Activity page, and the
    cc-frontend MCP send_message/reply_message tools are what reach the user."""
    return "\n".join([
        "<cc-web-frontend>",
        "<origin>nudge</origin>",
        "<current_time timezone=\"Asia/Shanghai\">",
        datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "</current_time>",
        "<nudge_instructions>",
        message.text.strip() or "[empty nudge]",
        "</nudge_instructions>",
        "</cc-web-frontend>",
    ])


def _build_self_alarm_prompt(message: FrontendMessage) -> str:
    return "\n".join([
        "<cc-web-frontend>",
        "<origin>self_alarm</origin>",
        "<current_time timezone=\"Asia/Shanghai\">",
        datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "</current_time>",
        "<scheduled_wake_time timezone=\"Asia/Shanghai\">",
        message.scheduled_at or datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "</scheduled_wake_time>",
        "<self_alarm_reason>",
        message.text.strip() or "[empty self alarm reason]",
        "</self_alarm_reason>",
        "<instructions>",
        "This is not a message from the user. This is a time you previously chose to wake up. "
        "Remember why you set this wake-up, think about what you wanted future-you to do, "
        "then decide whether to work quietly, write to the Activity archive, or call send_message/reply_message to reach the user.",
        "</instructions>",
        "</cc-web-frontend>",
    ])


def _build_diary_prompt(message: FrontendMessage) -> str:
    return "\n".join([
        "<cc-web-frontend>",
        "<origin>diary</origin>",
        "<current_time timezone=\"Asia/Shanghai\">",
        datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "</current_time>",
        "<diary_prompt>",
        message.text.strip() or "[empty diary prompt]",
        "</diary_prompt>",
        "<instructions>",
        "This is an automatic evening diary wake-up, not a message from the user. "
        "Use your judgment: prepare the diary reflection, write quiet notes for Activity, "
        "or call send_message/reply_message if the user should be invited into the diary.",
        "</instructions>",
        "</cc-web-frontend>",
    ])


def _format_attachments(attachments: list[AttachmentRef]) -> list[str]:
    lines: list[str] = []
    for index, item in enumerate(attachments, start=1):
        label = item.name or item.path
        lines.append(f"{index}. type={item.kind}; name={label}; path={item.path}")
        if item.mime_type:
            lines.append(f"   mime_type={item.mime_type}")
        if item.duration is not None:
            lines.append(f"   duration={item.duration:.1f}s")
        if item.transcript:
            lines.append(f"   transcript={item.transcript}")
    return lines
