import type { OutgoingPayload } from '@/components/chat/ChatComposer'
import type { ContentBlock } from '@/types'

export interface UploadedAttachment {
  kind: 'image' | 'document' | 'audio' | 'sticker'
  path: string
  url: string
  name?: string
  mime_type?: string
  size?: number
}

export interface VoiceUploadResult {
  url?: string
  transcript: string | null
  ok: boolean
}

/** Upload a recorded voice blob to the backend, which stores it and runs STT. */
export async function uploadVoice(blob: Blob, duration: number): Promise<VoiceUploadResult> {
  const form = new FormData()
  form.append('file', blob, 'voice.webm')
  form.append('duration', String(duration))
  const response = await fetch('/api/voice/upload', {
    method: 'POST',
    body: form,
    credentials: 'include',
  })
  if (!response.ok) throw new Error(`Voice upload failed: ${response.status}`)
  const data = (await response.json()) as { url?: string; transcript?: unknown; stt_ok?: unknown }
  const transcript = typeof data.transcript === 'string' && data.transcript.trim() ? data.transcript.trim() : null
  return {
    url: typeof data.url === 'string' ? data.url : undefined,
    transcript,
    ok: Boolean(data.stt_ok) && transcript !== null,
  }
}

export async function uploadOutgoingAttachments(payload: OutgoingPayload): Promise<UploadedAttachment[]> {
  const uploads: UploadedAttachment[] = []

  for (const sticker of payload.stickers ?? []) {
    uploads.push({
      kind: 'sticker',
      path: sticker.path,
      url: sticker.url,
      name: sticker.name,
      mime_type: 'image/webp',
    })
  }

  for (const image of payload.images ?? []) {
    uploads.push(await uploadFile(image.file, 'image'))
  }

  for (const document of payload.documents ?? []) {
    uploads.push(await uploadFile(document.file, 'document'))
  }

  return uploads
}

export function buildUserContentWithUploads(
  payload: OutgoingPayload,
  uploads: UploadedAttachment[],
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  let uploadIndex = 0

  for (const sticker of payload.stickers ?? []) {
    const uploaded = uploads[uploadIndex++]
    blocks.push({
      type: 'image',
      url: uploaded?.url || sticker.url,
      name: uploaded?.name || sticker.name,
      variant: 'sticker',
      sourcePath: uploaded?.path || sticker.path,
    })
  }

  for (const image of payload.images ?? []) {
    const uploaded = uploads[uploadIndex++]
    blocks.push({
      type: 'image',
      url: uploaded?.url || image.url,
      name: uploaded?.name || image.name,
    })
  }

  for (const document of payload.documents ?? []) {
    const uploaded = uploads[uploadIndex++]
    blocks.push({
      type: 'document',
      url: uploaded?.url || document.url,
      name: uploaded?.name || document.name,
      size: uploaded?.size ?? document.size,
      mimeType: uploaded?.mime_type || document.mimeType,
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

export function attachmentsFromContent(content: ContentBlock[]): UploadedAttachment[] {
  const attachments: UploadedAttachment[] = []

  content.forEach((block) => {
    if (block.type === 'image') {
      attachments.push({
        kind: block.variant === 'sticker' ? 'sticker' : 'image',
        path: block.sourcePath || block.url,
        url: block.url,
        name: block.name,
        mime_type: block.variant === 'sticker' ? 'image/webp' : undefined,
      })
      return
    }
    if (block.type === 'document') {
      attachments.push({
        kind: 'document',
        path: block.url,
        url: block.url,
        name: block.name,
        mime_type: block.mimeType,
        size: block.size,
      })
    }
  })

  return attachments
}

async function uploadFile(file: File, kind: UploadedAttachment['kind']) {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)

  const response = await fetch('/upload', {
    method: 'POST',
    body: form,
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`)
  }

  const data = await response.json() as Partial<UploadedAttachment>
  if (!data.path || !data.url) {
    throw new Error('Upload response is missing attachment fields')
  }

  return {
    kind,
    path: data.path,
    url: data.url,
    name: data.name || file.name,
    mime_type: data.mime_type || file.type,
    size: data.size ?? file.size,
  }
}
