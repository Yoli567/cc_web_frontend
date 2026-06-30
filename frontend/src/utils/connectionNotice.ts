import type { ChatMessage, ConnectionNoticeType } from '@/types'

export function isConnectionNotice(message: ChatMessage): boolean {
  return Boolean(message.notice)
}

export function stripConnectionNotices(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !message.notice)
}

// Appends a disconnect/reconnect notice, collapsing redundant transitions: a
// "disconnected" right after another "disconnected" is dropped, and a
// "reconnected" only lands if the most recent notice was a "disconnected".
export function withConnectionNotice(
  messages: ChatMessage[],
  type: ConnectionNoticeType,
): ChatMessage[] {
  let lastNotice: ConnectionNoticeType | undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].notice) {
      lastNotice = messages[i].notice
      break
    }
  }
  if (type === 'disconnected' && lastNotice === 'disconnected') return messages
  if (type === 'reconnected' && lastNotice !== 'disconnected') return messages

  return [
    ...messages,
    {
      id: `notice-${type}-${Date.now()}`,
      role: 'assistant' as const,
      content: [],
      timestamp: Date.now(),
      notice: type,
    },
  ]
}
