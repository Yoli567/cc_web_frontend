import { useState, useCallback, useRef, useEffect } from 'react'
import { useWebSocket, subscribeLiveStatus } from './useWebSocket'
import type { ChatMessage, ContentBlock, ReplyTarget } from '@/types'
import { stripConnectionNotices, withConnectionNotice } from '@/utils/connectionNotice'
import { buildUserContent } from '@/utils/buildUserContent'
import {
  allBlocksExistInMessages,
  dedupeCachedMessages,
  dedupeContentBlocks,
  hasDuplicateAssistantContent,
  hasDuplicateAssistantText,
  hasDuplicateContentBlock,
} from '@/utils/messageDedupe'
import { outgoingTextFromContent } from '@/utils/outgoingText'
import type { OutgoingPayload } from '@/components/chat/ChatComposer'
import { useSessions } from '@/sessions/SessionsContext'
import { chatStorageKey, loadChatMessages, saveChatMessages } from '@/utils/chatStorage'
import { buildIncomingContent } from '@/utils/incomingContent'
import {
  attachmentsFromContent,
  buildUserContentWithUploads,
  uploadOutgoingAttachments,
  uploadVoice,
} from '@/utils/uploadAttachments'
import { putVoice, voiceCacheKey } from '@/utils/voiceCache'

const SEND_RETRY_DELAY_MS = 5000
const BACKGROUND_SOURCES = new Set(['nudge', 'self_alarm', 'diary'])

function normalizeCachedMessages(messages: ChatMessage[]): ChatMessage[] {
  return markStaleSendingMessages(dedupeCachedMessages(messages))
}

export function useLiveChat() {
  const { currentSessionId, setSessionLastMode, touchSession } = useSessions()
  const storageKey = chatStorageKey('message', currentSessionId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isTyping, setIsTyping] = useState(false)
  const messagesRef = useRef<ChatMessage[]>(messages)
  const loadedStorageKeyRef = useRef(storageKey)
  // Per-turn FIFO pairing of thinking <-> assistant text bubbles. CC thinks
  // once per send_message, so each bubble shows its own thinking. Thinkings
  // waiting for a bubble queue in pendingThinking; bubbles waiting for a
  // thinking (the watcher lags the MCP bubble by ~300ms) queue in unfilled.
  const pendingThinkingByTurnRef = useRef<Map<string, string[]>>(new Map())
  const unfilledMsgIdsByTurnRef = useRef<Map<string, string[]>>(new Map())
  const pendingToolBlocksRef = useRef<ContentBlock[]>([])
  const pendingToolBlocksByTurnRef = useRef<Map<string, ContentBlock[]>>(new Map())
  // ID of the first assistant message for a fallback turn without turn_id.
  const firstAsstMsgIdOfTurnRef = useRef<string | null>(null)
  const firstAsstMsgIdsByTurnRef = useRef<Map<string, string>>(new Map())
  const optimisticIdsRef = useRef<Set<string>>(new Set())
  const outgoingPayloadsRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    let cancelled = false
    retryTimersRef.current.forEach(clearTimeout)
    retryTimersRef.current.clear()
    firstAsstMsgIdOfTurnRef.current = null
    firstAsstMsgIdsByTurnRef.current.clear()
    pendingThinkingByTurnRef.current.clear()
    unfilledMsgIdsByTurnRef.current.clear()
    pendingToolBlocksRef.current = []
    pendingToolBlocksByTurnRef.current.clear()
    optimisticIdsRef.current.clear()
    outgoingPayloadsRef.current.clear()
    loadedStorageKeyRef.current = ''
    messagesRef.current = []
    const clearTimer = window.setTimeout(() => {
      if (!cancelled) setMessages([])
    }, 0)
    void loadChatMessages('message', currentSessionId).then((storedMessages) => {
      if (cancelled) return
      loadedStorageKeyRef.current = storageKey
      setIsTyping(false)
      setMessages((prev) => normalizeCachedMessages(prev.length > 0 ? [...storedMessages, ...prev] : storedMessages))
    }).catch(() => {
      if (cancelled) return
      loadedStorageKeyRef.current = storageKey
      setIsTyping(false)
      setMessages([])
    })
    return () => {
      cancelled = true
      window.clearTimeout(clearTimer)
    }
  }, [currentSessionId, storageKey])

  useEffect(() => {
    messagesRef.current = messages
    if (loadedStorageKeyRef.current !== storageKey) return
    const persistable = stripConnectionNotices(messages)
    if (persistable.length === 0) return
    void saveChatMessages('message', currentSessionId, persistable).catch(() => {})
  }, [currentSessionId, messages, storageKey])

  useEffect(() => subscribeLiveStatus((live) => {
    setMessages((prev) => withConnectionNotice(prev, live ? 'reconnected' : 'disconnected'))
  }), [])

  const clearRetryTimer = useCallback((messageId: string) => {
    const timer = retryTimersRef.current.get(messageId)
    if (timer) clearTimeout(timer)
    retryTimersRef.current.delete(messageId)
  }, [])

  const scheduleRetry = useCallback((messageId: string) => {
    clearRetryTimer(messageId)
    const timer = setTimeout(() => {
      retryTimersRef.current.delete(messageId)
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId && (message.sendStatus === 'sending' || message.sendStatus === 'delivered')
            ? { ...message, sendStatus: 'retry' }
            : message,
        ),
      )
    }, SEND_RETRY_DELAY_MS)
    retryTimersRef.current.set(messageId, timer)
  }, [clearRetryTimer])

  useEffect(() => () => {
    retryTimersRef.current.forEach(clearTimeout)
    retryTimersRef.current.clear()
  }, [])

  const handleEvent = useCallback((event: Record<string, unknown>) => {
    const mode = event.mode as string | undefined
    if (mode && mode !== 'message') return
    // Background turns are archived to Activity only. Explicit send_message
    // replies during those turns arrive without the background source.
    if (BACKGROUND_SOURCES.has(String(event.source || ''))) return
    const eventSessionId = sessionIdFromEvent(event)
    if (eventSessionId && currentSessionId && eventSessionId !== currentSessionId) return
    const eventTurnId = typeof event.turn_id === 'string' ? event.turn_id : null

    const firstAssistantIdForTurn = (turnId: string | null) =>
      turnId ? firstAsstMsgIdsByTurnRef.current.get(turnId) ?? null : firstAsstMsgIdOfTurnRef.current

    const setFirstAssistantIdForTurn = (turnId: string | null, messageId: string) => {
      if (turnId) {
        if (!firstAsstMsgIdsByTurnRef.current.has(turnId)) {
          firstAsstMsgIdsByTurnRef.current.set(turnId, messageId)
        }
        return
      }
      if (!firstAsstMsgIdOfTurnRef.current) {
        firstAsstMsgIdOfTurnRef.current = messageId
      }
    }

    const turnKey = (turnId: string | null) => turnId ?? ''

    const pushPendingThinking = (turnId: string | null, text: string) => {
      const k = turnKey(turnId)
      const q = pendingThinkingByTurnRef.current.get(k) ?? []
      q.push(text)
      pendingThinkingByTurnRef.current.set(k, q)
    }
    const shiftPendingThinking = (turnId: string | null) => {
      const q = pendingThinkingByTurnRef.current.get(turnKey(turnId))
      if (!q || q.length === 0) return null
      const text = q.shift() ?? null
      if (q.length === 0) pendingThinkingByTurnRef.current.delete(turnKey(turnId))
      return text
    }
    const pushUnfilledMsg = (turnId: string | null, id: string) => {
      const k = turnKey(turnId)
      const q = unfilledMsgIdsByTurnRef.current.get(k) ?? []
      q.push(id)
      unfilledMsgIdsByTurnRef.current.set(k, q)
    }
    const shiftUnfilledMsg = (turnId: string | null) => {
      const q = unfilledMsgIdsByTurnRef.current.get(turnKey(turnId))
      if (!q || q.length === 0) return null
      const id = q.shift() ?? null
      if (q.length === 0) unfilledMsgIdsByTurnRef.current.delete(turnKey(turnId))
      return id
    }

    const pendingToolBlocksForTurn = (turnId: string | null) => {
      if (!turnId) return pendingToolBlocksRef.current
      const blocks = pendingToolBlocksByTurnRef.current.get(turnId) ?? []
      pendingToolBlocksByTurnRef.current.set(turnId, blocks)
      return blocks
    }

    const takePendingToolBlocks = (turnId: string | null) => {
      if (turnId && pendingToolBlocksByTurnRef.current.has(turnId)) {
        const blocks = pendingToolBlocksByTurnRef.current.get(turnId) ?? []
        pendingToolBlocksByTurnRef.current.delete(turnId)
        return blocks
      }
      if (!turnId) {
        const blocks = pendingToolBlocksRef.current
        pendingToolBlocksRef.current = []
        return blocks
      }
      return []
    }

    const clearTurnState = (turnId: string | null) => {
      pendingThinkingByTurnRef.current.delete(turnKey(turnId))
      unfilledMsgIdsByTurnRef.current.delete(turnKey(turnId))
      if (turnId) {
        firstAsstMsgIdsByTurnRef.current.delete(turnId)
        pendingToolBlocksByTurnRef.current.delete(turnId)
        return
      }
      firstAsstMsgIdOfTurnRef.current = null
      pendingToolBlocksRef.current = []
    }

    switch (event.type) {
      case 'message': {
        if (event.role === 'user') {
          const incomingId = event.message_id as string
          if (incomingId) clearTurnState(incomingId)
          if (!eventTurnId) clearTurnState(null)
          if (optimisticIdsRef.current.has(incomingId)) {
            optimisticIdsRef.current.delete(incomingId)
            setMessages((prev) =>
              prev.map((message) =>
                message.id === incomingId
                  ? { ...message, sendStatus: 'delivered' }
                  : message,
              ),
            )
            return
          }
          setMessages((prev) =>
            prev.some((message) => message.id === incomingId) ||
            hasDuplicateAssistantText(prev, event.text as string, (event.timestamp as number) * 1000)
              ? prev
              : (() => {
                  const content = buildIncomingContent(event.text, event.attachments)
                  return content.length === 0
                    ? prev
                    : [
                        ...prev,
                        {
                          id: incomingId,
                          role: 'user' as const,
                          content,
                          timestamp: (event.timestamp as number) * 1000,
                          sendStatus: 'delivered' as const,
                          turnId: incomingId,
                        },
                      ]
                })(),
          )
        } else {
          setIsTyping(true)
          const incomingId = event.message_id as string
          const incomingContent = buildIncomingContent(event.text, event.attachments)
          if (incomingContent.length === 0) break
          // Thinking and stashed tool blocks render only on a text bubble, so
          // anchor them to the turn's first TEXT-bearing assistant message. A
          // sticker/image-only bubble must not become the anchor — otherwise it
          // silently swallows the turn's thinking (it has nowhere to show it).
          const hasText = incomingContent.some((b) => b.type === 'text')
          const isNewMessage = !messagesRef.current.some((m) => m.id === incomingId)
          if (hasText) setFirstAssistantIdForTurn(eventTurnId, incomingId)
          // Pair this text bubble with a thinking: prefer one inlined on the
          // event, else the oldest thinking already waiting for a bubble; if
          // none is waiting yet, register this bubble to receive the next
          // thinking event (the watcher lags the bubble by ~300ms).
          let thinking = (event.thinking as string) || ''
          if (hasText && isNewMessage && !thinking) {
            thinking = shiftPendingThinking(eventTurnId) ?? ''
            if (!thinking) pushUnfilledMsg(eventTurnId, incomingId)
          }
          const pendingToolBlocks = hasText ? takePendingToolBlocks(eventTurnId) : []

          setMessages((prev) =>
            prev.some((message) => message.id === incomingId)
              ? prev
              : [
                  ...prev,
                  {
                    id: incomingId,
                    role: 'assistant',
                    content: [
                      ...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
                      ...pendingToolBlocks,
                      ...incomingContent,
                    ],
                    timestamp: (event.timestamp as number) * 1000,
                    replyTo: parseReplyTarget(event.reply_to),
                    turnId: eventTurnId ?? undefined,
                  },
                ],
          )
        }
        break
      }
      case 'send_status': {
        const messageId = event.message_id as string
        const status =
          event.status === 'read' ? 'read'
            : event.status === 'delivered' ? 'delivered'
              : event.status === 'retry' ? 'retry'
                : null
        if (!messageId || !status) break
        clearRetryTimer(messageId)
        optimisticIdsRef.current.delete(messageId)
        if (status !== 'retry') {
          outgoingPayloadsRef.current.delete(messageId)
        } else {
          setIsTyping(false)
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, sendStatus: status }
              : message,
          ),
        )
        break
      }
      case 'thinking': {
        const thinkingText = event.thinking as string
        if (!thinkingText) break
        setIsTyping(true)
        const targetId = shiftUnfilledMsg(eventTurnId)
        if (!targetId) {
          pushPendingThinking(eventTurnId, thinkingText)
          break
        }
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== targetId) return m
            if (m.content.some((b) => b.type === 'thinking')) return m
            return {
              ...m,
              content: [{ type: 'thinking', thinking: thinkingText }, ...m.content],
            }
          }),
        )
        break
      }
      case 'tool_use': {
        setIsTyping(true)
        const block: ContentBlock = {
          type: 'tool_use',
          id: String(event.id || `tool-${Date.now()}`),
          name: String(event.name || 'tool'),
          input: (event.input && typeof event.input === 'object' ? event.input : {}) as Record<string, unknown>,
        }
        const targetId = firstAssistantIdForTurn(eventTurnId)
        if (!targetId) {
          addPendingToolBlock(pendingToolBlocksForTurn(eventTurnId), block)
          break
        }
        setMessages((prev) => appendBlock(prev, targetId, block))
        break
      }
      case 'tool_result': {
        setIsTyping(true)
        const block: ContentBlock = {
          type: 'tool_result',
          tool_use_id: String(event.tool_use_id || ''),
          content: String(event.content || ''),
        }
        const targetId = firstAssistantIdForTurn(eventTurnId)
        if (!targetId) {
          addPendingToolBlock(pendingToolBlocksForTurn(eventTurnId), block)
          break
        }
        setMessages((prev) => appendBlock(prev, targetId, block))
        break
      }
      case 'typing':
        setIsTyping(event.is_typing as boolean)
        break
      case 'turn_complete': {
        const pendingBlocksForTurn = takePendingToolBlocks(eventTurnId)
        if (pendingBlocksForTurn.length > 0) {
          const pendingToolBlocks = dedupeContentBlocks(pendingBlocksForTurn)
          const timestamp = typeof event.timestamp === 'number'
            ? (event.timestamp as number) * 1000
            : Date.now()
          setMessages((prev) =>
            allBlocksExistInMessages(prev, pendingToolBlocks) ||
            hasDuplicateAssistantContent(prev, pendingToolBlocks, timestamp)
              ? prev
              : [
                  ...prev,
                  {
                    id: `tool-${timestamp}`,
                    role: 'assistant',
                    content: pendingToolBlocks,
                    timestamp,
                    turnId: eventTurnId ?? undefined,
                  },
                ],
          )
        }
        setIsTyping(false)
        clearTurnState(eventTurnId)
        break
      }
    }
  }, [clearRetryTimer, currentSessionId])

  const { connected, send } = useWebSocket(handleEvent, { ackEvents: isMessagePageEvent })

  useEffect(() => {
    if (connected) return
    const timer = setTimeout(() => setIsTyping(false), 0)
    return () => clearTimeout(timer)
  }, [connected])

  const sendMessage = useCallback(
    (payload: OutgoingPayload) => {
      const content = buildUserContent(payload)
      if (content.length === 0) return

      send({ type: 'client_state', visible: true })
      const messageId = makeUserMessageId(currentSessionId)
      optimisticIdsRef.current.add(messageId)
      if (payload.audio) {
        // Cache the recording immediately so the bubble can play even before
        // upload finishes and after the backend file expires.
        void putVoice(voiceCacheKey(messageId), payload.audio.blob)
      }
      const outgoingBase = {
        type: 'send_message',
        mode: 'message',
        text: payload.text || (payload.audio ? '[voice]' : '') || '[attachment]',
        userstyle: payload.userstyle,
        reply_to: payload.replyTo,
        message_id: messageId,
      }
      outgoingPayloadsRef.current.set(messageId, outgoingBase)
      scheduleRetry(messageId)
      setIsTyping(true)
      if (currentSessionId) {
        setSessionLastMode(currentSessionId, 'message')
        touchSession(currentSessionId)
      }

      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          role: 'user',
          content,
          timestamp: Date.now(),
          sendStatus: 'sending',
          replyTo: payload.replyTo,
          turnId: messageId,
        },
      ])

      void (async () => {
        try {
          let outgoing: typeof outgoingBase & { attachments?: unknown[] }
          if (payload.audio) {
            // Voice: upload + STT on the backend, send CC a [voice: …] tag.
            // The audio itself is not attached — CC only reads the transcript.
            let voiceText = '[voice: 语音转写失败]'
            try {
              const result = await uploadVoice(payload.audio.blob, payload.audio.duration)
              if (result.ok && result.transcript) {
                voiceText = `[voice: ${result.transcript}]`
              }
              const transcriptForBubble = result.ok ? result.transcript ?? undefined : undefined
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === messageId
                    ? {
                        ...message,
                        content: message.content.map((block) =>
                          block.type === 'audio'
                            ? { ...block, url: result.url ?? block.url, transcript: transcriptForBubble }
                            : block,
                        ),
                      }
                    : message,
                ),
              )
            } catch {
              // Upload/STT failed — keep [voice: 语音转写失败]; audio is still cached locally.
            }
            outgoing = { ...outgoingBase, text: voiceText }
          } else {
            const uploaded = await uploadOutgoingAttachments(payload)
            outgoing = { ...outgoingBase, attachments: uploaded }
            if (uploaded.length > 0) {
              const uploadedContent = buildUserContentWithUploads(payload, uploaded)
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === messageId ? { ...message, content: uploadedContent } : message,
                ),
              )
            }
          }
          outgoingPayloadsRef.current.set(messageId, outgoing)
          send(outgoing)
        } catch {
          clearRetryTimer(messageId)
          setIsTyping(false)
          setMessages((prev) =>
            prev.map((message) =>
              message.id === messageId ? { ...message, sendStatus: 'retry' } : message,
            ),
          )
        }
      })()
    },
    [clearRetryTimer, currentSessionId, scheduleRetry, send, setSessionLastMode, touchSession],
  )

  const resendMessage = useCallback(
    (messageId: string) => {
      const message = messagesRef.current.find((item) => item.id === messageId && item.role === 'user')
      const outgoing = outgoingPayloadsRef.current.get(messageId) ?? (
        message
          ? {
              type: 'send_message',
              mode: 'message',
              text: outgoingTextFromContent(message.content),
              reply_to: message.replyTo,
              attachments: attachmentsFromContent(message.content),
              message_id: messageId,
            }
          : null
      )
      if (!outgoing) return

      send({ type: 'client_state', visible: true })
      optimisticIdsRef.current.add(messageId)
      outgoingPayloadsRef.current.set(messageId, outgoing)
      scheduleRetry(messageId)
      setIsTyping(true)
      if (currentSessionId) {
        setSessionLastMode(currentSessionId, 'message')
        touchSession(currentSessionId)
      }
      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageId ? { ...item, sendStatus: 'sending' } : item,
        ),
      )
      send(outgoing)
    },
    [currentSessionId, scheduleRetry, send, setSessionLastMode, touchSession],
  )

  const deleteMessages = useCallback((messageIds: string[]) => {
    if (messageIds.length === 0) return
    const ids = new Set(messageIds)
    setMessages((prev) => {
      const next = prev.filter((message) => !ids.has(message.id))
      void saveChatMessages('message', currentSessionId, stripConnectionNotices(next)).catch(() => {})
      return next
    })
  }, [currentSessionId])

  return { messages, isTyping, sendMessage, resendMessage, deleteMessages, connected }
}

function parseReplyTarget(value: unknown): ReplyTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!role || !text.trim()) return undefined
  return {
    messageId: typeof raw.messageId === 'string' ? raw.messageId : `quoted-${Date.now()}`,
    role,
    text,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
  }
}

function appendBlock(messages: ChatMessage[], messageId: string, block: ContentBlock) {
  return messages.map((message) =>
    message.id === messageId
      ? hasDuplicateContentBlock(message.content, block)
        ? message
        : { ...message, content: [...message.content, block] }
      : message,
  )
}

function addPendingToolBlock(blocks: ContentBlock[], block: ContentBlock) {
  if (!hasDuplicateContentBlock(blocks, block)) {
    blocks.push(block)
  }
}

function makeUserMessageId(sessionId: string | null) {
  return `user:${sessionId || 'default'}:${Date.now()}`
}

function sessionIdFromEvent(event: Record<string, unknown>) {
  const id =
    typeof event.turn_id === 'string'
      ? event.turn_id
      : typeof event.message_id === 'string'
        ? event.message_id
        : ''
  if (!id.startsWith('user:')) return null
  const parts = id.split(':')
  return parts.length >= 3 ? parts[1] : null
}

function isMessagePageEvent(event: Record<string, unknown>) {
  const mode = typeof event.mode === 'string' ? event.mode : ''
  return !mode || mode === 'message'
}

function markStaleSendingMessages(messages: ChatMessage[]) {
  const now = Date.now()
  return messages.map((message) =>
    message.role === 'user' &&
    message.sendStatus === 'sending' &&
    now - message.timestamp >= SEND_RETRY_DELAY_MS
      ? { ...message, sendStatus: 'retry' as const }
      : message,
  )
}
