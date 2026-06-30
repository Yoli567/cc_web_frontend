import type { ContentBlock } from '@/types'
import type { OutgoingPayload } from '@/components/chat/ChatComposer'

/**
 * Convert a composer payload into the ContentBlock array used by ChatMessage.
 * Order: images first, then audio, then text — this is how the user typed it.
 */
export function buildUserContent(payload: OutgoingPayload): ContentBlock[] {
  const blocks: ContentBlock[] = []

  if (payload.stickers && payload.stickers.length > 0) {
    payload.stickers.forEach((sticker) => {
      blocks.push({
        type: 'image',
        url: sticker.url,
        name: sticker.name,
        variant: 'sticker',
        sourcePath: sticker.path,
      })
    })
  }

  if (payload.images && payload.images.length > 0) {
    payload.images.forEach((img) => {
      blocks.push({ type: 'image', url: img.url, name: img.name })
    })
  }

  if (payload.documents && payload.documents.length > 0) {
    payload.documents.forEach((doc) => {
      blocks.push({
        type: 'document',
        url: doc.url,
        name: doc.name,
        size: doc.size,
        mimeType: doc.mimeType,
      })
    })
  }

  if (payload.audio) {
    blocks.push({
      type: 'audio',
      url: payload.audio.url,
      duration: payload.audio.duration,
      transcript: payload.audio.transcript || undefined,
    })
  }

  if (payload.text && payload.text.trim()) {
    blocks.push({ type: 'text', text: payload.text })
  }

  return blocks
}
