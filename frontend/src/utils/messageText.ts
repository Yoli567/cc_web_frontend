import type { ChatMessage } from '@/types'
import { stripUserstyleBlock } from '@/utils/displayText'

export function messagePlainText(message: ChatMessage) {
  const parts = message.content.flatMap((block) => {
    switch (block.type) {
      case 'text':
        return [message.role === 'user' ? stripUserstyleBlock(block.text) : block.text]
      case 'audio':
        return block.transcript ? [block.transcript] : []
      case 'document':
        return [block.name]
      case 'image':
        return block.name ? [block.name] : []
      case 'tool_use':
        return [block.name, JSON.stringify(block.input)]
      case 'tool_result':
        return [block.content]
      case 'thinking':
        return [block.thinking]
      default:
        return []
    }
  })
  return parts.map((part) => part.trim()).filter(Boolean).join('\n')
}

export function messagePreview(message: ChatMessage, maxLength = 180) {
  const text = messagePlainText(message).replace(/\s+/g, ' ').trim()
  if (!text) return '[attachment]'
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text
}

export function messageThinkingText(message: ChatMessage) {
  return message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => ('thinking' in block ? block.thinking.trim() : ''))
    .filter(Boolean)
    .join('\n')
}

export function messageReplyText(message: ChatMessage) {
  const parts = message.content.flatMap((block) => {
    switch (block.type) {
      case 'text':
        return [message.role === 'user' ? stripUserstyleBlock(block.text) : block.text]
      case 'audio':
        return block.transcript ? [block.transcript] : []
      case 'document':
        return [block.name]
      case 'image':
        return block.name ? [block.name] : []
      default:
        return []
    }
  })
  return parts.map((part) => part.trim()).filter(Boolean).join('\n')
}
