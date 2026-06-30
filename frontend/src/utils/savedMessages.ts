import type { ChatMessage, ChatMode } from '@/types'
import { messagePlainText, messagePreview, messageReplyText, messageThinkingText } from '@/utils/messageText'
import { markVoiceSaved, voiceCacheKey } from '@/utils/voiceCache'

function audioCacheKeys(messageId: string, content: ChatMessage['content']) {
  return content
    .filter((block) => block.type === 'audio')
    .map((_, index) => voiceCacheKey(messageId, index))
}

export interface SavedMessage {
  id: string
  mode: ChatMode
  sessionId: string | null
  messageId: string
  role: ChatMessage['role']
  content: ChatMessage['content']
  timestamp: number
  savedAt: number
  title?: string
}

const SAVED_MESSAGES_KEY = 'cc-saved-messages'

export function savedMessageId(mode: ChatMode, sessionId: string | null, messageId: string) {
  return `${mode}:${sessionId || 'default'}:${messageId}`
}

export function loadSavedMessages(): SavedMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_MESSAGES_KEY) || '[]') as SavedMessage[]
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === 'string')
      : []
  } catch {
    return []
  }
}

export function saveSavedMessages(messages: SavedMessage[]) {
  localStorage.setItem(SAVED_MESSAGES_KEY, JSON.stringify(messages))
  window.dispatchEvent(new CustomEvent('cc-saved-messages-changed'))
}

export function isMessageSaved(mode: ChatMode, sessionId: string | null, messageId: string, saved = loadSavedMessages()) {
  const id = savedMessageId(mode, sessionId, messageId)
  return saved.some((item) => item.id === id)
}

export function saveMessageSnapshot(mode: ChatMode, sessionId: string | null, message: ChatMessage) {
  const id = savedMessageId(mode, sessionId, message.id)
  const saved = loadSavedMessages()
  if (saved.some((item) => item.id === id)) return saved
  audioCacheKeys(message.id, message.content).forEach((key) => void markVoiceSaved(key, true))
  const next: SavedMessage[] = [
    {
      id,
      mode,
      sessionId,
      messageId: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      savedAt: Date.now(),
      title: mode === 'cabin' ? defaultCabinTitle(message) : undefined,
    },
    ...saved,
  ]
  saveSavedMessages(next)
  return next
}

export function unsaveMessage(mode: ChatMode, sessionId: string | null, messageId: string) {
  const id = savedMessageId(mode, sessionId, messageId)
  const all = loadSavedMessages()
  const removed = all.find((item) => item.id === id)
  if (removed) {
    audioCacheKeys(removed.messageId, removed.content).forEach((key) => void markVoiceSaved(key, false))
  }
  const next = all.filter((item) => item.id !== id)
  saveSavedMessages(next)
  return next
}

export function toggleSavedMessage(mode: ChatMode, sessionId: string | null, message: ChatMessage) {
  return isMessageSaved(mode, sessionId, message.id)
    ? unsaveMessage(mode, sessionId, message.id)
    : saveMessageSnapshot(mode, sessionId, message)
}

export function updateSavedMessageTitle(id: string, title: string) {
  const next = loadSavedMessages().map((item) =>
    item.id === id ? { ...item, title } : item,
  )
  saveSavedMessages(next)
  return next
}

export function savedText(item: SavedMessage) {
  return messagePlainText(savedToMessage(item))
}

export function savedPreview(item: SavedMessage, maxLength = 180) {
  return messagePreview(savedToMessage(item), maxLength)
}

export function savedThinking(item: SavedMessage) {
  return messageThinkingText(savedToMessage(item))
}

export function savedReply(item: SavedMessage) {
  return messageReplyText(savedToMessage(item))
}

export function savedToMessage(item: SavedMessage): ChatMessage {
  return {
    id: item.messageId,
    role: item.role,
    content: item.content,
    timestamp: item.timestamp,
  }
}

function defaultCabinTitle(message: ChatMessage) {
  const reply = messageReplyText(message).replace(/\s+/g, ' ').trim()
  if (!reply) return 'Cabin note'
  const firstSentence = reply.split(/(?<=[。！？!?])\s*/)[0]?.trim() || reply
  return firstSentence.length > 32 ? `${firstSentence.slice(0, 32).trim()}...` : firstSentence
}
