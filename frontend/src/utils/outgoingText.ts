import type { ContentBlock } from '@/types'

export function outgoingTextFromContent(content: ContentBlock[]) {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text) return text

  const transcript = content.find((block) => block.type === 'audio')?.transcript?.trim()
  return transcript || '[attachment]'
}
