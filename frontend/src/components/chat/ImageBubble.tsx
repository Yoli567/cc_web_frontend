import { useState, type SyntheticEvent } from 'react'

interface ImageBubbleProps {
  url: string
  name?: string
  variant?: 'image' | 'sticker'
}

export default function ImageBubble({ url, name, variant = 'image' }: ImageBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const [trimmedSticker, setTrimmedSticker] = useState<{
    sourceUrl: string
    displayUrl: string
    displayWidth: number
    displayHeight: number
  } | null>(null)
  const isSticker = variant === 'sticker'
  const hasTrimmedSticker = trimmedSticker?.sourceUrl === url
  const displayUrl = hasTrimmedSticker ? trimmedSticker.displayUrl : url

  const handleStickerLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!isSticker || hasTrimmedSticker) return
    const image = event.currentTarget
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return

    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(0, 0, width, height)

      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const alpha = data[(y * width + x) * 4 + 3]
          if (alpha <= 8) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }

      if (maxX < minX || maxY < minY) return
      const padding = 4
      minX = Math.max(0, minX - padding)
      minY = Math.max(0, minY - padding)
      maxX = Math.min(width - 1, maxX + padding)
      maxY = Math.min(height - 1, maxY + padding)
      const cropWidth = maxX - minX + 1
      const cropHeight = maxY - minY + 1
      if (cropWidth >= width * 0.96 && cropHeight >= height * 0.96) return

      const crop = document.createElement('canvas')
      crop.width = cropWidth
      crop.height = cropHeight
      const cropCtx = crop.getContext('2d')
      if (!cropCtx) return
      cropCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
      // Keep the visible character at the exact size it had inside the original
      // 156px box, so trimming only removes the transparent margin (no gap) and
      // never upscales the sticker.
      const scale = Math.min(1, 156 / Math.max(width, height))
      setTrimmedSticker({
        sourceUrl: url,
        displayUrl: crop.toDataURL('image/png'),
        displayWidth: cropWidth * scale,
        displayHeight: cropHeight * scale,
      })
    } catch {
      // Some remote images cannot be read by canvas; keep the original sticker.
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={isSticker
          ? 'cc-sticker-bubble block overflow-hidden'
          : 'cc-image-bubble block overflow-hidden rounded-[14px]'}
      >
        <img
          src={displayUrl}
          alt={name || 'attachment'}
          onLoad={handleStickerLoad}
          style={hasTrimmedSticker
            ? { width: trimmedSticker.displayWidth, height: trimmedSticker.displayHeight }
            : undefined}
          className={isSticker
            ? hasTrimmedSticker
              ? 'block object-contain'
              : 'block max-h-[156px] max-w-[156px] object-contain'
            : 'block max-h-[240px] w-auto max-w-full object-cover'}
        />
      </button>

      {expanded && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setExpanded(false)}
          role="dialog"
        >
          <img
            src={displayUrl}
            alt={name || 'attachment'}
            className="max-h-full max-w-full select-none object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
