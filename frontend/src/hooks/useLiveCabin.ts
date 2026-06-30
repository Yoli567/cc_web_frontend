import { useState, useCallback, useRef, useEffect } from 'react'
import { useWebSocket, subscribeLiveStatus } from './useWebSocket'
import type { ChatMessage, ContentBlock } from '@/types'
import { stripConnectionNotices, withConnectionNotice } from '@/utils/connectionNotice'
import { buildUserContent } from '@/utils/buildUserContent'
import {
  allBlocksExistInMessages,
  dedupeCachedMessages,
  dedupeContentBlocks,
  hasDuplicateAssistantContent,
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
  return markStaleSendingMessages(dedupeCachedMessages(messages, { mergeAssistantTextVariants: true }))
}

export function useLiveCabin() {
  const { currentSessionId, setSessionLastMode, touchSession } = useSessions()
  const storageKey = chatStorageKey('cabin', currentSessionId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const messagesRef = useRef<ChatMessage[]>(messages)
  const loadedStorageKeyRef = useRef(storageKey)
  const [isStreaming, setIsStreaming] = useState(false)
  const pendingThinkingRef = useRef<string | null>(null)
  const pendingThinkingByTurnRef = useRef<Map<string, string>>(new Map())
  const pendingToolBlocksRef = useRef<ContentBlock[]>([])
  const pendingToolBlocksByTurnRef = useRef<Map<string, ContentBlock[]>>(new Map())
  const streamingIdRef = useRef<string | null>(null)
  const streamingTurnIdsRef = useRef<Map<string, string>>(new Map())
  const buildingMsgIdRef = useRef<string | null>(null)
  const buildingTurnIdRef = useRef<string | null>(null)
  const buildingHasPreviewRef = useRef(false)
  const buildingPreviewTextRef = useRef('')
  const activeTurnIdRef = useRef<string | null>(null)
  const optimisticIdsRef = useRef<Set<string>>(new Set())
  const outgoingPayloadsRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    let cancelled = false
    retryTimersRef.current.forEach(clearTimeout)
    retryTimersRef.current.clear()
    pendingThinkingRef.current = null
    pendingThinkingByTurnRef.current.clear()
    pendingToolBlocksRef.current = []
    pendingToolBlocksByTurnRef.current.clear()
    streamingIdRef.current = null
    streamingTurnIdsRef.current.clear()
    buildingMsgIdRef.current = null
    buildingTurnIdRef.current = null
    buildingHasPreviewRef.current = false
    buildingPreviewTextRef.current = ''
    activeTurnIdRef.current = null
    optimisticIdsRef.current.clear()
    outgoingPayloadsRef.current.clear()
    loadedStorageKeyRef.current = ''
    messagesRef.current = []
    const clearTimer = window.setTimeout(() => {
      if (!cancelled) setMessages([])
    }, 0)
    void loadChatMessages('cabin', currentSessionId).then((storedMessages) => {
      if (cancelled) return
      loadedStorageKeyRef.current = storageKey
      setIsStreaming(false)
      setMessages((prev) => normalizeCachedMessages(prev.length > 0 ? [...storedMessages, ...prev] : storedMessages))
    }).catch(() => {
      if (cancelled) return
      loadedStorageKeyRef.current = storageKey
      setIsStreaming(false)
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
    void saveChatMessages('cabin', currentSessionId, persistable).catch(() => {})
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
    if (mode && mode !== 'cabin') return
    if (BACKGROUND_SOURCES.has(String(event.source || ''))) return
    const sourceSessionId = sessionIdFromEvent(event)
    if (sourceSessionId && currentSessionId && sourceSessionId !== currentSessionId) return
    const eventTurnId = typeof event.turn_id === 'string' ? event.turn_id : null

    const streamIdForTurn = (turnId: string | null) => {
      if (!turnId) return streamingIdRef.current
      for (const [messageId, streamTurnId] of streamingTurnIdsRef.current) {
        if (streamTurnId === turnId) return messageId
      }
      return null
    }

    const takePendingThinking = (turnId: string | null) => {
      if (turnId && pendingThinkingByTurnRef.current.has(turnId)) {
        const thinking = pendingThinkingByTurnRef.current.get(turnId) ?? null
        pendingThinkingByTurnRef.current.delete(turnId)
        return thinking
      }
      if (!turnId) {
        const thinking = pendingThinkingRef.current
        pendingThinkingRef.current = null
        return thinking
      }
      return null
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

    const buildingMatchesTurn = (turnId: string | null) =>
      !turnId || !buildingTurnIdRef.current || buildingTurnIdRef.current === turnId

    switch (event.type) {
      case 'message': {
        if (event.role === 'user') {
          const incomingId = event.message_id as string
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
            prev.some((message) => message.id === incomingId)
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
          const incomingId = event.message_id as string
          const incomingContent = buildIncomingContent(event.text, event.attachments)
          if (incomingContent.length === 0) break
          // A sticker/image-only bubble can't display thinking, so it must not
          // consume the turn's pending thinking — leave it for the streaming
          // text bubble that follows.
          const hasText = incomingContent.some((b) => b.type === 'text')
          const thinking = (event.thinking as string) || (hasText ? takePendingThinking(eventTurnId) : '')
          const pendingToolBlocks = hasText ? takePendingToolBlocks(eventTurnId) : []
          const content = [
            ...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
            ...pendingToolBlocks,
            ...incomingContent,
          ]
          setMessages((prev) =>
            prev.some((message) => message.id === incomingId)
              ? prev
              : [
                  ...prev,
                  {
                    id: incomingId,
                    role: 'assistant',
                    content,
                    timestamp: (event.timestamp as number) * 1000,
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
          setIsStreaming(false)
          if (activeTurnIdRef.current === messageId) activeTurnIdRef.current = null
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
        const thinking = event.thinking as string
        if (!thinking) break
        if (eventTurnId) {
          pendingThinkingByTurnRef.current.set(eventTurnId, thinking)
        } else {
          pendingThinkingRef.current = thinking
        }
        setIsStreaming(true)

        const streamId = streamIdForTurn(eventTurnId)
        if (streamId) {
          if (eventTurnId) {
            pendingThinkingByTurnRef.current.delete(eventTurnId)
          } else {
            pendingThinkingRef.current = null
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, content: upsertThinkingBlock(m.content, thinking) }
                : m,
            ),
          )
          break
        }

        const settledAssistantId = eventTurnId
          ? findLatestAssistantIdForTurn(messagesRef.current, eventTurnId)
          : null
        if (settledAssistantId) {
          if (eventTurnId) pendingThinkingByTurnRef.current.delete(eventTurnId)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === settledAssistantId
                ? { ...m, content: upsertThinkingBlock(m.content, thinking) }
                : m,
            ),
          )
          break
        }

        const bid = buildingMsgIdRef.current
        if (bid && buildingMatchesTurn(eventTurnId)) {
          if (eventTurnId) buildingTurnIdRef.current = eventTurnId
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== bid) return m
              return { ...m, content: upsertThinkingBlock(m.content, thinking) }
            }),
          )
        } else {
          const id = `building-${Date.now()}`
          buildingMsgIdRef.current = id
          buildingTurnIdRef.current = eventTurnId
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: 'assistant' as const,
              content: [{ type: 'thinking' as const, thinking }],
              timestamp: Date.now(),
              isStreaming: true,
              turnId: eventTurnId ?? undefined,
            },
          ])
        }
        break
      }
      case 'stream_preview': {
        if (streamIdForTurn(eventTurnId)) break
        const delta = typeof event.delta === 'string' ? event.delta : ''
        const absoluteText = typeof event.text === 'string' ? event.text : null
        if (!delta && absoluteText === null) break
        const previewText = absoluteText ?? mergePreviewText(buildingPreviewTextRef.current, delta)
        if (previewText === buildingPreviewTextRef.current) break
        buildingPreviewTextRef.current = previewText

        const bid = buildingMsgIdRef.current
        if (bid && buildingMatchesTurn(eventTurnId)) {
          if (eventTurnId) buildingTurnIdRef.current = eventTurnId
          buildingHasPreviewRef.current = true
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== bid) return m
              return { ...m, content: upsertTextBlock(m.content, previewText) }
            }),
          )
        } else {
          const id = `building-${Date.now()}`
          buildingMsgIdRef.current = id
          buildingTurnIdRef.current = eventTurnId
          buildingHasPreviewRef.current = true
          setIsStreaming(true)
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: previewText }],
              timestamp: Date.now(),
              isStreaming: true,
              turnId: eventTurnId ?? undefined,
            },
          ])
        }
        break
      }
      case 'stream_start': {
        const msgId = event.message_id as string
        streamingIdRef.current = msgId
        if (eventTurnId) streamingTurnIdsRef.current.set(msgId, eventTurnId)
        setIsStreaming(true)

        const thinking = takePendingThinking(eventTurnId)
        const pendingToolBlocks = takePendingToolBlocks(eventTurnId)
        const bid = buildingMsgIdRef.current
        const shouldConsumeBuilding = Boolean(bid && buildingMatchesTurn(eventTurnId))
        if (shouldConsumeBuilding) {
          buildingMsgIdRef.current = null
          buildingTurnIdRef.current = null
        }
        const hadPreview = shouldConsumeBuilding && buildingHasPreviewRef.current
        if (shouldConsumeBuilding) buildingHasPreviewRef.current = false
        const previewText = shouldConsumeBuilding ? buildingPreviewTextRef.current : ''
        if (shouldConsumeBuilding) buildingPreviewTextRef.current = ''

        if (bid && shouldConsumeBuilding) {
          setMessages((prev) => {
            let upserted = false
            const next: ChatMessage[] = []

            for (const m of prev) {
              if (m.id !== bid && m.id !== msgId) {
                next.push(m)
                continue
              }

              const existingText =
                hadPreview
                  ? previewText || (m.content.find((b) => b.type === 'text') as { text: string } | undefined)?.text || ''
                  : ''
              if (upserted) continue
              upserted = true
              next.push({
                ...m,
                id: msgId,
                content: buildStreamContent(m.content, thinking, pendingToolBlocks, existingText),
                timestamp: (event.timestamp as number) * 1000,
                isStreaming: true,
                turnId: eventTurnId ?? m.turnId,
              })
            }

            if (!upserted) {
              next.push({
                id: msgId,
                role: 'assistant',
                content: buildStreamContent([], thinking, pendingToolBlocks, previewText),
                timestamp: (event.timestamp as number) * 1000,
                isStreaming: true,
                turnId: eventTurnId ?? undefined,
              })
            }

            return next
          })
        } else {
          setMessages((prev) => {
            let upserted = false
            const fallbackId = findStreamReplacementId(prev, eventTurnId)
            const next = prev.map((message) => {
              if (message.id !== msgId && message.id !== fallbackId) return message
              upserted = true
              return {
                ...message,
                id: msgId,
                content: buildStreamContent(message.content, thinking, pendingToolBlocks, previewText),
                timestamp: (event.timestamp as number) * 1000,
                isStreaming: true,
                turnId: eventTurnId ?? message.turnId,
              }
            })
            return upserted
              ? next
              : [
                  ...next,
                  {
                    id: msgId,
                    role: 'assistant',
                    content: buildStreamContent([], thinking, pendingToolBlocks, previewText),
                    timestamp: (event.timestamp as number) * 1000,
                    isStreaming: true,
                    turnId: eventTurnId ?? undefined,
                  },
                ]
          })
        }
        break
      }
      case 'stream_chunk': {
        const chunk = event.chunk as string
        const chunkMsgId = event.message_id as string
        setMessages((prev) => {
          let found = false
          const fallbackId = findStreamReplacementId(prev, eventTurnId)
          const next = prev.map((m) => {
            if (m.id !== chunkMsgId && m.id !== fallbackId) return m
            found = true
            return {
              ...m,
              id: chunkMsgId,
              content: upsertTextBlock(m.content, chunk),
              isStreaming: true,
              turnId: eventTurnId ?? m.turnId,
            }
          })

          if (!found) {
            next.push({
              id: chunkMsgId,
              role: 'assistant',
              content: [{ type: 'text' as const, text: chunk }],
              timestamp: Date.now(),
              isStreaming: true,
              turnId: eventTurnId ?? undefined,
            })
          }

          return next.filter((m) => !(found && isBuildingAssistant(m) && m.id !== chunkMsgId))
        })
        break
      }
      case 'stream_end': {
        const endMsgId = event.message_id as string
        if (streamingIdRef.current === endMsgId) streamingIdRef.current = null
        setIsStreaming(false)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === endMsgId ? { ...m, isStreaming: false } : m,
          ),
        )
        break
      }
      case 'tool_use': {
        const block: ContentBlock = {
          type: 'tool_use',
          id: String(event.id || `tool-${Date.now()}`),
          name: String(event.name || 'tool'),
          input: (event.input && typeof event.input === 'object' ? event.input : {}) as Record<string, unknown>,
        }
        const targetId = streamIdForTurn(eventTurnId)
        if (!targetId) {
          addPendingToolBlock(pendingToolBlocksForTurn(eventTurnId), block)
          break
        }
        setMessages((prev) => appendBlock(prev, targetId, block))
        break
      }
      case 'tool_result': {
        const block: ContentBlock = {
          type: 'tool_result',
          tool_use_id: String(event.tool_use_id || ''),
          content: String(event.content || ''),
        }
        const targetId = streamIdForTurn(eventTurnId)
        if (!targetId) {
          addPendingToolBlock(pendingToolBlocksForTurn(eventTurnId), block)
          break
        }
        setMessages((prev) => appendBlock(prev, targetId, block))
        break
      }
      case 'turn_complete': {
        const bid = buildingMsgIdRef.current
        const shouldClearBuilding = Boolean(bid && buildingMatchesTurn(eventTurnId))
        if (shouldClearBuilding) {
          buildingMsgIdRef.current = null
          buildingTurnIdRef.current = null
          buildingHasPreviewRef.current = false
          buildingPreviewTextRef.current = ''
        }
        if (eventTurnId) {
          pendingThinkingByTurnRef.current.delete(eventTurnId)
          if (activeTurnIdRef.current === eventTurnId) activeTurnIdRef.current = null
          for (const [messageId, streamTurnId] of streamingTurnIdsRef.current) {
            if (streamTurnId === eventTurnId) {
              streamingTurnIdsRef.current.delete(messageId)
              if (streamingIdRef.current === messageId) streamingIdRef.current = null
            }
          }
        } else {
          pendingThinkingRef.current = null
          activeTurnIdRef.current = null
        }

        const pendingBlocksForTurn = takePendingToolBlocks(eventTurnId)
        if (pendingBlocksForTurn.length > 0) {
          const pendingToolBlocks = dedupeContentBlocks(pendingBlocksForTurn)
          const timestamp = typeof event.timestamp === 'number'
            ? (event.timestamp as number) * 1000
            : Date.now()

          if (bid && shouldClearBuilding) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === bid
                  ? { ...m, content: [...m.content, ...pendingToolBlocks], isStreaming: false }
                  : m,
              ),
            )
          } else {
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
        } else if (bid && shouldClearBuilding) {
          setMessages((prev) =>
            prev.flatMap((m) => {
              if (m.id !== bid) return [m]
              const next = { ...m, isStreaming: false }
              return hasAnyContent(next) ? [next] : []
            }),
          )
        }
        setIsStreaming(false)
        break
      }
    }
  }, [clearRetryTimer, currentSessionId])

  const { connected, send } = useWebSocket(handleEvent, { ackEvents: isCabinPageEvent })

  useEffect(() => {
    if (!connected) return
    const enabled = localStorage.getItem('cc-streaming-enabled') === 'true'
    fetch('/api/streaming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      credentials: 'include',
    }).catch(() => {})
  }, [connected])

  useEffect(() => {
    if (connected) return
    const timer = setTimeout(() => setIsStreaming(false), 0)
    return () => clearTimeout(timer)
  }, [connected])

  const sendMessage = useCallback(
    (payload: OutgoingPayload) => {
      const content = buildUserContent(payload)
      if (content.length === 0) return

      const messageId = makeUserMessageId(currentSessionId)
      optimisticIdsRef.current.add(messageId)
      activeTurnIdRef.current = messageId
      pendingThinkingByTurnRef.current.delete(messageId)
      pendingToolBlocksByTurnRef.current.delete(messageId)
      buildingMsgIdRef.current = null
      buildingTurnIdRef.current = null
      buildingHasPreviewRef.current = false
      buildingPreviewTextRef.current = ''
      if (payload.audio) {
        void putVoice(voiceCacheKey(messageId), payload.audio.blob)
      }
      const outgoingBase = {
        type: 'send_message',
        mode: 'cabin',
        text: payload.text || (payload.audio ? '[voice]' : '') || '[attachment]',
        userstyle: payload.userstyle,
        message_id: messageId,
        streaming_enabled: localStorage.getItem('cc-streaming-enabled') === 'true',
      }
      outgoingPayloadsRef.current.set(messageId, outgoingBase)
      scheduleRetry(messageId)
      if (currentSessionId) {
        setSessionLastMode(currentSessionId, 'cabin')
        touchSession(currentSessionId)
      }

      setMessages((prev) => [
        ...prev.filter((message) => !isThinkingOnlyAssistant(message)),
        {
          id: messageId,
          role: 'user',
          content,
          timestamp: Date.now(),
          sendStatus: 'sending',
          turnId: messageId,
        },
      ])

      void (async () => {
        try {
          let outgoing: typeof outgoingBase & { attachments?: unknown[] }
          if (payload.audio) {
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
          setIsStreaming(false)
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
              mode: 'cabin',
              text: outgoingTextFromContent(message.content),
              attachments: attachmentsFromContent(message.content),
              message_id: messageId,
              streaming_enabled: localStorage.getItem('cc-streaming-enabled') === 'true',
            }
          : null
      )
      if (!outgoing) return

      optimisticIdsRef.current.add(messageId)
      outgoingPayloadsRef.current.set(messageId, outgoing)
      activeTurnIdRef.current = messageId
      scheduleRetry(messageId)
      if (currentSessionId) {
        setSessionLastMode(currentSessionId, 'cabin')
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

  return { messages, isStreaming, sendMessage, resendMessage, connected }
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

function mergePreviewText(previous: string, delta: string) {
  if (!previous) return delta
  if (delta === previous) return previous
  if (delta.startsWith(previous)) return delta
  if (previous.endsWith(delta)) return previous
  return previous + delta
}

function upsertTextBlock(content: ContentBlock[], text: string) {
  let replaced = false
  const next = content.map((block) => {
    if (block.type !== 'text') return block
    if (replaced) return null
    replaced = true
    return { type: 'text' as const, text }
  }).filter((block): block is ContentBlock => block !== null)

  return replaced ? next : [...next, { type: 'text' as const, text }]
}

function upsertThinkingBlock(content: ContentBlock[], thinking: string) {
  const next = content.filter((block) => block.type !== 'thinking')
  return [{ type: 'thinking' as const, thinking }, ...next]
}

function buildStreamContent(
  existing: ContentBlock[],
  thinking: string | null,
  pendingToolBlocks: ContentBlock[],
  text: string,
) {
  return dedupeContentBlocks([
    ...(thinking
      ? [{ type: 'thinking' as const, thinking }]
      : existing.filter((block) => block.type === 'thinking')),
    ...existing.filter((block) => block.type === 'tool_use' || block.type === 'tool_result'),
    ...pendingToolBlocks,
    { type: 'text' as const, text },
  ])
}

function isBuildingAssistant(message: ChatMessage) {
  return message.role === 'assistant' && message.id.startsWith('building-')
}

function hasAnyContent(message: ChatMessage) {
  return message.content.length > 0
}

function isThinkingOnlyAssistant(message: ChatMessage) {
  return (
    isBuildingAssistant(message) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'thinking')
  )
}

function findLatestThinkingOnlyBuildingId(messages: ChatMessage[], turnId?: string | null) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (
      isThinkingOnlyAssistant(messages[i]) &&
      (!turnId || messages[i].turnId === turnId)
    ) {
      return messages[i].id
    }
  }
  return null
}

function findStreamReplacementId(messages: ChatMessage[], turnId?: string | null) {
  return (
    findLatestThinkingOnlyBuildingId(messages, turnId) ??
    (turnId ? findLatestAssistantIdForTurn(messages, turnId, true) : null)
  )
}

function findLatestAssistantIdForTurn(messages: ChatMessage[], turnId: string, includeBuilding = false) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (
      message.role === 'assistant' &&
      message.turnId === turnId &&
      (includeBuilding || !isBuildingAssistant(message))
    ) {
      return message.id
    }
  }
  return null
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

function isCabinPageEvent(event: Record<string, unknown>) {
  return event.mode === 'cabin'
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
