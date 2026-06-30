import { useEffect, useRef, useCallback, useState } from 'react'

type WSEvent = Record<string, unknown>
type EventHandler = (event: WSEvent) => void
type AckPredicate = boolean | ((event: WSEvent) => boolean)
interface HandlerOptions {
  ackEvents: AckPredicate
}

// Dev: 直连本地后端 8000。Prod: 走 nginx 代理（相对路径 + 协议自适应）
const WS_URL = import.meta.env.DEV
  ? `ws://${window.location.hostname}:8000/ws`
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000
const PING_INTERVAL = 30000
const PONG_TIMEOUT = 10000
const MAX_PENDING_SENDS = 20
const EVENT_SEQ_STORAGE_KEY = 'cc-ws-last-event-seq'
const SEEN_EVENT_SEQS_STORAGE_KEY = 'cc-ws-seen-event-seqs'
const BACKEND_SESSION_STORAGE_KEY = 'cc-ws-backend-session'
const WS_LOG_STORAGE_KEY = 'cc-ws-debug-log'
const MAX_SEEN_EVENT_SEQS = 1000
const MAX_WS_LOG_ENTRIES = 200
const MAX_UNACKED_EVENTS = 200

const STICKY_STORAGE_KEY = 'cc-ws-ever-connected'
let stickyConnected = (() => {
  try {
    return localStorage.getItem(STICKY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
})()
const seenEventSeqs = loadSeenEventSeqs()

// ── Module-level singleton WebSocket ─────────────────────────────────
// Connection lives here, not inside any React component. Page/route
// transitions add and remove listeners but never tear down the socket.

type ConnectHandler = (connected: boolean) => void
type LiveStatusHandler = (live: boolean) => void

const eventHandlers = new Map<EventHandler, HandlerOptions>()
const connectHandlers = new Set<ConnectHandler>()
const liveStatusHandlers = new Set<LiveStatusHandler>()
let ws: WebSocket | null = null
let wsConnected = stickyConnected
let liveConnected = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let pingTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null
const pendingSends: Record<string, unknown>[] = []
const unackedEvents: WSEvent[] = []

function clearHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

function openConnection() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const lastEventSeq = readLastEventSeq()
  const storedSession = readBackendSession()
  const separator = WS_URL.includes('?') ? '&' : '?'
  const sessionParam = storedSession ? `&session=${encodeURIComponent(storedSession)}` : ''
  logWs(`connecting (last_event_seq=${lastEventSeq})`)
  const socket = new WebSocket(`${WS_URL}${separator}last_event_seq=${lastEventSeq}${sessionParam}`)
  ws = socket

  socket.onopen = () => {
    stickyConnected = true
    reconnectAttempts = 0
    try {
      localStorage.setItem(STICKY_STORAGE_KEY, '1')
    } catch { /* ignore */ }
    logWs('connected')
    broadcastConnected(true)
    broadcastLiveStatus(true)
    const pending = pendingSends.splice(0)
    pending.forEach((data) => socket.send(JSON.stringify(data)))
    clearHeartbeat()
    pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'ping' }))
      // No pong within PONG_TIMEOUT means a half-open (dead) socket — force a
      // close so onclose fires and the backoff reconnect kicks in.
      if (!pongTimer) {
        pongTimer = setTimeout(() => {
          pongTimer = null
          logWs('pong timeout — connection appears dead, reconnecting')
          socket.close()
        }, PONG_TIMEOUT)
      }
    }, PING_INTERVAL)
  }

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.type === 'pong') {
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
        return
      }
      if (data.type === 'connected') {
        handleBackendSession(data.session_id as string | undefined)
        return
      }
      const seq = typeof data.server_event_seq === 'number' ? data.server_event_seq : null
      if (seq !== null && seenEventSeqs.has(seq)) return
      let shouldAck = false
      eventHandlers.forEach((options, handler) => {
        handler(data)
        if (shouldAckEvent(options.ackEvents, data)) shouldAck = true
      })
      if (seq !== null && shouldAck) {
        rememberEventSeq(seq)
        writeLastEventSeq(seq)
        forgetUnackedEvent(seq)
      } else if (seq !== null) {
        rememberUnackedEvent(data)
      }
    } catch { /* ignore malformed */ }
  }

  socket.onclose = (event) => {
    clearHeartbeat()
    broadcastConnected(stickyConnected)
    broadcastLiveStatus(false)
    logWs(`disconnected (code=${event.code}${event.reason ? `, reason=${event.reason}` : ''})`)
    if (eventHandlers.size > 0) scheduleReconnect()
  }

  socket.onerror = () => {
    logWs('socket error')
    socket.close()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (eventHandlers.size === 0) return
  const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * 2 ** reconnectAttempts)
  const wait = Math.round(delay + Math.random() * delay * 0.3)
  reconnectAttempts += 1
  logWs(`reconnect in ${wait}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openConnection()
  }, wait)
}

// Network came back / tab refocused: drop the backoff and retry immediately
// instead of waiting out a (possibly long) scheduled delay.
function reconnectNow() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (eventHandlers.size === 0) return
  reconnectAttempts = 0
  openConnection()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    logWs('network online')
    reconnectNow()
  })
  window.addEventListener('offline', () => logWs('network offline'))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reconnectNow()
  })
}

function broadcastConnected(value: boolean) {
  wsConnected = value
  connectHandlers.forEach((handler) => handler(value))
}

function broadcastLiveStatus(value: boolean) {
  if (liveConnected === value) return
  liveConnected = value
  liveStatusHandlers.forEach((handler) => handler(value))
}

function sharedSend(data: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
    return
  }

  const messageId = typeof data.message_id === 'string' ? data.message_id : ''
  if (messageId) {
    const existingIndex = pendingSends.findIndex((item) => item.message_id === messageId)
    if (existingIndex >= 0) pendingSends.splice(existingIndex, 1)
  }
  pendingSends.push(data)
  if (pendingSends.length > MAX_PENDING_SENDS) {
    pendingSends.splice(0, pendingSends.length - MAX_PENDING_SENDS)
  }
}

// ── React hook ───────────────────────────────────────────────────────

export function useWebSocket(onEvent: EventHandler, options: { ackEvents?: AckPredicate } = {}) {
  const [connected, setConnected] = useState(wsConnected)
  const onEventRef = useRef(onEvent)
  const handlerOptionsRef = useRef<HandlerOptions>({ ackEvents: options.ackEvents ?? true })

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    handlerOptionsRef.current.ackEvents = options.ackEvents ?? true
  }, [options.ackEvents])

  useEffect(() => {
    const handler: EventHandler = (event) => onEventRef.current(event)
    const connHandler: ConnectHandler = (c) => setConnected(c)

    eventHandlers.set(handler, handlerOptionsRef.current)
    connectHandlers.add(connHandler)
    replayUnackedEvents(handler, handlerOptionsRef.current.ackEvents)
    openConnection()

    return () => {
      eventHandlers.delete(handler)
      connectHandlers.delete(connHandler)
    }
  }, [])

  const send = useCallback((data: Record<string, unknown>) => {
    sharedSend(data)
  }, [])

  return { connected, send }
}

export function sendWebSocketEvent(data: Record<string, unknown>) {
  sharedSend(data)
}

// Real-time socket state (NOT sticky): fires on every open/close transition.
// Used to surface disconnect/reconnect notices in the chat timeline.
export function subscribeLiveStatus(handler: LiveStatusHandler): () => void {
  liveStatusHandlers.add(handler)
  return () => {
    liveStatusHandlers.delete(handler)
  }
}

// ── WebSocket debug log ──────────────────────────────────────────────
// Lightweight ring buffer of connection-lifecycle events, surfaced in the
// Settings → Debug → Error Logs view.

export interface WsLogEntry {
  time: number
  text: string
}

type WsLogHandler = (entries: WsLogEntry[]) => void

const wsLog: WsLogEntry[] = loadWsLog()
const wsLogHandlers = new Set<WsLogHandler>()

export function logWs(text: string) {
  wsLog.push({ time: Date.now(), text })
  if (wsLog.length > MAX_WS_LOG_ENTRIES) {
    wsLog.splice(0, wsLog.length - MAX_WS_LOG_ENTRIES)
  }
  try {
    localStorage.setItem(WS_LOG_STORAGE_KEY, JSON.stringify(wsLog))
  } catch { /* ignore */ }
  const snapshot = wsLog.slice()
  wsLogHandlers.forEach((handler) => handler(snapshot))
}

export function getWsLog(): WsLogEntry[] {
  return wsLog.slice()
}

export function subscribeWsLog(handler: WsLogHandler): () => void {
  wsLogHandlers.add(handler)
  return () => {
    wsLogHandlers.delete(handler)
  }
}

function loadWsLog(): WsLogEntry[] {
  try {
    const raw = localStorage.getItem(WS_LOG_STORAGE_KEY)
    const values = raw ? (JSON.parse(raw) as WsLogEntry[]) : []
    return Array.isArray(values)
      ? values.filter((v) => v && typeof v.time === 'number' && typeof v.text === 'string').slice(-MAX_WS_LOG_ENTRIES)
      : []
  } catch {
    return []
  }
}

// ── localStorage helpers ─────────────────────────────────────────────

function readLastEventSeq() {
  try {
    const value = Number(localStorage.getItem(EVENT_SEQ_STORAGE_KEY) || '0')
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

function writeLastEventSeq(seq: number) {
  try {
    localStorage.setItem(EVENT_SEQ_STORAGE_KEY, String(Math.max(readLastEventSeq(), Math.floor(seq))))
  } catch {
    /* ignore */
  }
}

function loadSeenEventSeqs() {
  try {
    const raw = localStorage.getItem(SEEN_EVENT_SEQS_STORAGE_KEY)
    const values = raw ? (JSON.parse(raw) as number[]) : []
    return new Set(values.filter((value) => Number.isFinite(value) && value > 0))
  } catch {
    return new Set<number>()
  }
}

function rememberEventSeq(seq: number) {
  seenEventSeqs.add(seq)
  const compact = Array.from(seenEventSeqs).sort((a, b) => b - a).slice(0, MAX_SEEN_EVENT_SEQS)
  seenEventSeqs.clear()
  compact.forEach((value) => seenEventSeqs.add(value))
  try {
    localStorage.setItem(SEEN_EVENT_SEQS_STORAGE_KEY, JSON.stringify(compact))
  } catch {
    /* ignore */
  }
}

function shouldAckEvent(ackEvents: AckPredicate, event: WSEvent) {
  return typeof ackEvents === 'function' ? ackEvents(event) : ackEvents
}

function rememberUnackedEvent(event: WSEvent) {
  const seq = typeof event.server_event_seq === 'number' ? event.server_event_seq : null
  if (seq === null || seenEventSeqs.has(seq)) return
  const existingIndex = unackedEvents.findIndex((item) => item.server_event_seq === seq)
  if (existingIndex >= 0) unackedEvents.splice(existingIndex, 1)
  unackedEvents.push(event)
  if (unackedEvents.length > MAX_UNACKED_EVENTS) {
    unackedEvents.splice(0, unackedEvents.length - MAX_UNACKED_EVENTS)
  }
}

function forgetUnackedEvent(seq: number) {
  const index = unackedEvents.findIndex((event) => event.server_event_seq === seq)
  if (index >= 0) unackedEvents.splice(index, 1)
}

function replayUnackedEvents(handler: EventHandler, ackEvents: AckPredicate) {
  unackedEvents.slice().forEach((event) => {
    const seq = typeof event.server_event_seq === 'number' ? event.server_event_seq : null
    if (seq === null || seenEventSeqs.has(seq)) {
      if (seq !== null) forgetUnackedEvent(seq)
      return
    }
    if (!shouldAckEvent(ackEvents, event)) return
    handler(event)
    rememberEventSeq(seq)
    writeLastEventSeq(seq)
    forgetUnackedEvent(seq)
  })
}

function readBackendSession() {
  try {
    return localStorage.getItem(BACKEND_SESSION_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function handleBackendSession(sessionId: string | undefined) {
  if (!sessionId) return
  const stored = readBackendSession()
  if (stored && stored !== sessionId) {
    logWs('backend restarted — replaying full history')
    seenEventSeqs.clear()
    try {
      localStorage.removeItem(SEEN_EVENT_SEQS_STORAGE_KEY)
      localStorage.setItem(EVENT_SEQ_STORAGE_KEY, '0')
    } catch { /* ignore */ }
  }
  try {
    localStorage.setItem(BACKEND_SESSION_STORAGE_KEY, sessionId)
  } catch { /* ignore */ }
}
