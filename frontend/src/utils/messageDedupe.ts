import type { ChatMessage, ContentBlock } from '@/types'

const DUPLICATE_ASSISTANT_WINDOW_MS = 60_000

interface DedupeCachedMessagesOptions {
  mergeAssistantTextVariants?: boolean
}

export function dedupeCachedMessages(
  messages: ChatMessage[],
  options: DedupeCachedMessagesOptions = {},
) {
  const seenIds = new Set<string>()
  const seenAssistantText = new Map<string, number>()
  const result: ChatMessage[] = []

  for (const message of messages) {
    if (seenIds.has(message.id)) continue
    seenIds.add(message.id)
    const dedupedMessage = { ...message, content: dedupeContentBlocks(message.content) }

    if (dedupedMessage.role === 'assistant') {
      if (options.mergeAssistantTextVariants) {
        const duplicateIndex = result.findIndex((existing) =>
          canMergeAssistantTextVariants(existing, dedupedMessage),
        )
        if (duplicateIndex >= 0) {
          result[duplicateIndex] = mergeAssistantTextVariants(result[duplicateIndex], dedupedMessage)
          continue
        }
      }

      const signature = messageContentSignature(dedupedMessage)
      const previousTimestamp = signature ? seenAssistantText.get(signature) : undefined
      if (
        previousTimestamp !== undefined &&
        Math.abs(dedupedMessage.timestamp - previousTimestamp) <= DUPLICATE_ASSISTANT_WINDOW_MS
      ) {
        continue
      }
      if (signature) seenAssistantText.set(signature, dedupedMessage.timestamp)
    }

    result.push(dedupedMessage)
  }

  return result
}

function canMergeAssistantTextVariants(a: ChatMessage, b: ChatMessage) {
  if (a.role !== 'assistant' || b.role !== 'assistant') return false
  if (Math.abs(a.timestamp - b.timestamp) > DUPLICATE_ASSISTANT_WINDOW_MS) return false
  if (a.turnId && b.turnId && a.turnId === b.turnId) return true

  const aText = messageTextSignature(a)
  const bText = messageTextSignature(b)
  if (!aText || !bText) return false
  return aText === bText || aText.includes(bText) || bText.includes(aText)
}

function mergeAssistantTextVariants(a: ChatMessage, b: ChatMessage): ChatMessage {
  const preferredText = longerTextBlock(a.content, b.content)
  const mergedContent = dedupeContentBlocks([
    ...a.content.filter((block) => block.type === 'thinking'),
    ...b.content.filter((block) => block.type === 'thinking'),
    ...a.content.filter((block) => block.type === 'tool_use' || block.type === 'tool_result'),
    ...b.content.filter((block) => block.type === 'tool_use' || block.type === 'tool_result'),
    ...(preferredText ? [preferredText] : []),
  ])
  const keepB = messageScore(b) > messageScore(a)

  return {
    ...(keepB ? b : a),
    content: mergedContent,
    timestamp: Math.min(a.timestamp, b.timestamp),
    isStreaming: Boolean(a.isStreaming || b.isStreaming) || undefined,
    turnId: a.turnId ?? b.turnId,
  }
}

function longerTextBlock(a: ContentBlock[], b: ContentBlock[]) {
  const aText = textFromContent(a)
  const bText = textFromContent(b)
  const text = bText.length > aText.length ? bText : aText
  return text ? { type: 'text' as const, text } : null
}

function messageScore(message: ChatMessage) {
  return (
    (isBuildingMessage(message) ? 0 : 4) +
    (message.content.some((block) => block.type === 'thinking') ? 2 : 0) +
    (message.turnId ? 1 : 0) +
    messageTextSignature(message).length / 100_000
  )
}

function isBuildingMessage(message: ChatMessage) {
  return message.id.startsWith('building-')
}

export function hasDuplicateAssistantText(
  messages: ChatMessage[],
  text: string,
  timestamp: number,
) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  return messages.some((message) => (
    message.role === 'assistant' &&
    Math.abs(message.timestamp - timestamp) <= DUPLICATE_ASSISTANT_WINDOW_MS &&
    messageTextSignature(message) === normalized
  ))
}

export function hasDuplicateAssistantContent(
  messages: ChatMessage[],
  content: ContentBlock[],
  timestamp: number,
) {
  const signature = contentSignature(content)
  if (!signature) return false
  return messages.some((message) => (
    message.role === 'assistant' &&
    Math.abs(message.timestamp - timestamp) <= DUPLICATE_ASSISTANT_WINDOW_MS &&
    messageContentSignature(message) === signature
  ))
}

export function allBlocksExistInMessages(messages: ChatMessage[], blocks: ContentBlock[]) {
  return blocks.every((block) => {
    const sig = blockSignature(block)
    return messages.some((m) =>
      m.role === 'assistant' && m.content.some((b) => blockSignature(b) === sig),
    )
  })
}

export function hasDuplicateContentBlock(blocks: ContentBlock[], nextBlock: ContentBlock) {
  const nextSignature = blockSignature(nextBlock)
  return blocks.some((block) => blockSignature(block) === nextSignature)
}

export function dedupeContentBlocks(blocks: ContentBlock[]) {
  const seen = new Set<string>()
  return blocks.filter((block) => {
    const signature = blockSignature(block)
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}

function messageTextSignature(message: ChatMessage) {
  return normalizeText(textFromContent(message.content))
}

function messageContentSignature(message: ChatMessage) {
  return contentSignature(message.content)
}

function contentSignature(content: ContentBlock[]) {
  return content
    .map(blockSignature)
    .filter(Boolean)
    .join('|')
}

function textFromContent(content: ContentBlock[]) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function blockSignature(block: ContentBlock) {
  switch (block.type) {
    case 'thinking':
      return `thinking:${normalizeText(block.thinking)}`
    case 'text':
      return `text:${normalizeText(block.text)}`
    case 'tool_use':
      return `tool_use:${block.name}:${stableStringify(block.input)}`
    case 'tool_result':
      return `tool_result:${normalizeText(block.content)}`
    case 'image':
      return `image:${block.url}:${block.name || ''}`
    case 'audio':
      return `audio:${block.url}:${block.duration}:${block.transcript || ''}`
    case 'document':
      return `document:${block.url}:${block.name}:${block.size}:${block.mimeType || ''}`
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, ' ')
}
