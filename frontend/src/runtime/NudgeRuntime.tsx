import { useCallback, useEffect, useRef } from 'react'
import { sendWebSocketEvent, useWebSocket } from '@/hooks/useWebSocket'
import { useSessions } from '@/sessions/SessionsContext'
import {
  activityDateKey,
  activityTitle,
  appendActivityReply,
  appendActivityThinking,
  appendActivityTool,
  appendActivityToolResult,
  loadActivityEntries,
  markActivityComplete,
  upsertActivityEntry,
} from '@/utils/activityStorage'
import {
  markNudgeInteraction,
  NUDGE_RUNTIME_LAST_SEEN_KEY,
  NUDGE_SETTINGS_CHANGED_EVENT,
  syncNudgeSettingsToBackend,
} from '@/utils/nudgeSettings'
import { DIARY_SETTINGS_CHANGED_EVENT, syncDiarySettingsToBackend } from '@/utils/diarySettings'
import { registerAppServiceWorker } from '@/utils/pwaNotifications'
import { appendChatMessage } from '@/utils/chatStorage'
import { buildIncomingContent } from '@/utils/incomingContent'
import type { ActivityEntry, ChatMessage } from '@/types'

const NUDGE_CHECK_INTERVAL_MS = 30_000
// Keep client_state fresh well within the backend's visibility TTL so an active
// page is never mistaken for "away" (which would let pushes through while user
// is reading), while a backgrounded page lapses fast (so pushes resume).
const VISIBILITY_HEARTBEAT_MS = 8_000
const HIDDEN_COOLDOWN_MS = 3_000
const BACKGROUND_SOURCES = new Set(['nudge', 'self_alarm', 'diary'])
const BACKGROUND_PUSH_REASONS = new Set(['nudge-message', 'self-alarm-message', 'diary-message'])
let lastHiddenReportAt = 0

export default function NudgeRuntime() {
  const { currentSessionId } = useSessions()
  const mountedRef = useRef(true)

  useEffect(() => {
    void registerAppServiceWorker()
    const tick = () => {
      localStorage.setItem(NUDGE_RUNTIME_LAST_SEEN_KEY, String(Date.now()))
      reportClientVisibility()
    }
    tick()
    const timer = window.setInterval(tick, NUDGE_CHECK_INTERVAL_MS)
    const heartbeat = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !document.hidden &&
        Date.now() - lastHiddenReportAt > HIDDEN_COOLDOWN_MS
      ) {
        sendWebSocketEvent({ type: 'client_state', visible: true })
      }
    }, VISIBILITY_HEARTBEAT_MS)
    const reportVisible = () => reportClientVisibility(true)
    const reportHidden = () => reportClientVisibility(false)
    const reportVisibility = () => {
      if (document.hidden || document.visibilityState === 'hidden') {
        reportHidden()
      } else {
        reportVisible()
      }
    }
    document.addEventListener('visibilitychange', reportVisibility)
    window.addEventListener('focus', reportVisible)
    window.addEventListener('blur', reportHidden)
    window.addEventListener('pageshow', reportVisible)
    window.addEventListener('pagehide', reportHidden)
    return () => {
      mountedRef.current = false
      reportClientVisibility(false)
      window.clearInterval(timer)
      window.clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', reportVisibility)
      window.removeEventListener('focus', reportVisible)
      window.removeEventListener('blur', reportHidden)
      window.removeEventListener('pageshow', reportVisible)
      window.removeEventListener('pagehide', reportHidden)
    }
  }, [])

  useEffect(() => {
    const sync = () => {
      void syncNudgeSettingsToBackend(currentSessionId).catch(() => {})
    }
    sync()
    window.addEventListener(NUDGE_SETTINGS_CHANGED_EVENT, sync)
    return () => window.removeEventListener(NUDGE_SETTINGS_CHANGED_EVENT, sync)
  }, [currentSessionId])

  useEffect(() => {
    const sync = () => {
      void syncDiarySettingsToBackend(currentSessionId).catch(() => {})
    }
    sync()
    window.addEventListener(DIARY_SETTINGS_CHANGED_EVENT, sync)
    return () => window.removeEventListener(DIARY_SETTINGS_CHANGED_EVENT, sync)
  }, [currentSessionId])

  const handleEvent = useCallback((event: Record<string, unknown>) => {
    const timestamp = typeof event.timestamp === 'number' ? event.timestamp * 1000 : Date.now()
    if (BACKGROUND_PUSH_REASONS.has(String(event.push_reason || '')) && event.type === 'message' && event.role === 'assistant') {
      void cacheMessagePageAssistantEvent(event, currentSessionId, timestamp)
      return
    }

    if (
      event.type === 'message' &&
      event.role === 'user' &&
      !BACKGROUND_SOURCES.has(String(event.source || ''))
    ) {
      markNudgeInteraction(timestamp)
      return
    }

    const source = String(event.source || '')
    if (!BACKGROUND_SOURCES.has(source)) return
    const turnId = typeof event.turn_id === 'string'
      ? event.turn_id
      : typeof event.message_id === 'string'
        ? event.message_id
        : ''
    if (!turnId) return

    if (event.type === 'message' && event.role === 'user') {
      const prompt = typeof event.text === 'string' ? event.text : ''
      const existing = loadActivityEntries().find((entry) => entry.turnId === turnId)
      upsertActivityEntry(makeActivityEntry(turnId, existing?.prompt || firstPromptLine(prompt), timestamp, source))
      return
    }

    if (!loadActivityEntries().some((entry) => entry.turnId === turnId)) return

    if (event.type === 'thinking' && typeof event.thinking === 'string') {
      appendActivityThinking(turnId, event.thinking)
      return
    }

    if (event.type === 'message' && event.role === 'assistant' && typeof event.text === 'string') {
      const messageId = typeof event.message_id === 'string' ? event.message_id : `reply-${timestamp}`
      appendActivityReply(turnId, { id: messageId, text: event.text, timestamp })
      return
    }

    if (event.type === 'tool_use') {
      appendActivityTool(turnId, {
        id: String(event.id || `tool-${timestamp}`),
        name: String(event.name || 'tool'),
        input: (event.input && typeof event.input === 'object' ? event.input : {}) as Record<string, unknown>,
        timestamp,
      })
      return
    }

    if (event.type === 'tool_result') {
      appendActivityToolResult(turnId, String(event.tool_use_id || ''), String(event.content || ''), timestamp)
      return
    }

    if (event.type === 'turn_complete') {
      markActivityComplete(turnId, timestamp)
    }
  }, [currentSessionId])

  useWebSocket(handleEvent, { ackEvents: isRuntimeAckEvent })

  return null
}

function makeActivityEntry(
  turnId: string,
  prompt: string,
  timestamp: number,
  source: string,
  sessionId = sessionIdFromTurnId(turnId),
): ActivityEntry {
  return {
    id: turnId,
    turnId,
    sessionId,
    source: source as ActivityEntry['source'],
    timestamp,
    dateKey: activityDateKey(timestamp),
    title: activityTitle(timestamp),
    prompt,
    thinking: [],
    replies: [],
    tools: [],
  }
}

function sessionIdFromTurnId(turnId: string) {
  if (!turnId.startsWith('user:')) return null
  const parts = turnId.split(':')
  const sessionId = parts.length >= 3 ? parts[1] : ''
  return sessionId && sessionId !== 'default' ? sessionId : null
}

function firstPromptLine(prompt: string) {
  return prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || prompt
}

async function cacheMessagePageAssistantEvent(event: Record<string, unknown>, sessionId: string | null, timestamp: number) {
  const messageId = typeof event.message_id === 'string' ? event.message_id : `nudge-message-${timestamp}`
  const content = buildIncomingContent(event.text, event.attachments)
  if (content.length === 0) return

  const message: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content,
    timestamp,
  }
  await appendChatMessage('message', sessionId, message)
}

function isRuntimeAckEvent(event: Record<string, unknown>) {
  if (BACKGROUND_PUSH_REASONS.has(String(event.push_reason || ''))) return true
  return BACKGROUND_SOURCES.has(String(event.source || ''))
}

function reportClientVisibility(visible = document.visibilityState === 'visible' && !document.hidden) {
  if (!visible) lastHiddenReportAt = Date.now()
  const payload = JSON.stringify({ visible })
  sendWebSocketEvent({ type: 'client_state', visible })
  if (!visible && navigator.sendBeacon) {
    const body = new Blob([payload], { type: 'application/json' })
    navigator.sendBeacon('/api/push/client-state', body)
    return
  }
  fetch('/api/push/client-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    credentials: 'include',
    keepalive: true,
  }).catch(() => {})
}
