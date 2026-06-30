import type { ContentBlock } from '@/types'

export function buildIncomingContent(text: unknown, attachments: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []

  if (Array.isArray(attachments)) {
    attachments.forEach((item) => {
      if (!item || typeof item !== 'object') return
      const raw = item as Record<string, unknown>
      const isSticker = raw.kind === 'sticker'
      const kind = isSticker ? 'image' : raw.kind || raw.type
      const url = typeof raw.url === 'string'
        ? raw.url
        : typeof raw.path === 'string' && raw.path.startsWith('/api/')
          ? raw.path
          : ''
      if (!url) return

      if (kind === 'image') {
        blocks.push({
          type: 'image',
          url,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          variant: isSticker ? 'sticker' : 'image',
          sourcePath: typeof raw.path === 'string' ? raw.path : undefined,
        })
      } else if (kind === 'document') {
        blocks.push({
          type: 'document',
          url,
          name: typeof raw.name === 'string' ? raw.name : 'Attachment',
          size: typeof raw.size === 'number' ? raw.size : 0,
          mimeType: typeof raw.mime_type === 'string'
            ? raw.mime_type
            : typeof raw.mimeType === 'string'
              ? raw.mimeType
              : undefined,
        })
      } else if (kind === 'audio') {
        blocks.push({
          type: 'audio',
          url,
          duration: typeof raw.duration === 'number' ? raw.duration : 0,
          transcript: typeof raw.transcript === 'string' ? raw.transcript : undefined,
        })
      }
    })
  }

  if (typeof text === 'string' && text.trim()) {
    blocks.push({ type: 'text', text })
  }

  return blocks
}
