import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'

interface ThinkingSheetProps {
  thinking: string
  onClose: () => void
}

export default function ThinkingSheet({ thinking, onClose }: ThinkingSheetProps) {
  const [translateY, setTranslateY] = useState(100)
  const translateYRef = useRef(100)
  const sheetRef = useRef<HTMLDivElement>(null)
  const paragraphs = normalizeThinking(thinking)
  const dragRef = useRef({ startY: 0, startTranslateY: 56, isDragging: false })

  const setSheetY = (value: number) => {
    translateYRef.current = value
    setTranslateY(value)
  }

  useEffect(() => {
    requestAnimationFrame(() => setSheetY(56))
  }, [])

  const close = () => {
    setSheetY(100)
    setTimeout(onClose, 280)
  }

  const onDragStart = (y: number) => {
    dragRef.current = { startY: y, startTranslateY: translateYRef.current, isDragging: true }
  }

  const onDragMove = (y: number) => {
    if (!dragRef.current.isDragging) return
    const delta = y - dragRef.current.startY
    const sheetHeight = sheetRef.current?.getBoundingClientRect().height || window.innerHeight * 0.75
    const nextY = dragRef.current.startTranslateY + (delta / (sheetHeight * 1.05)) * 100
    setSheetY(Math.max(0, Math.min(100, nextY)))
  }

  const onDragEnd = () => {
    dragRef.current.isDragging = false
    if (translateYRef.current > 82) {
      close()
    } else if (translateYRef.current > 32) {
      setSheetY(56)
    } else {
      setSheetY(0)
    }
  }

  const dragTouchHandlers = {
    onTouchStart: (e: ReactTouchEvent) => onDragStart(e.touches[0].clientY),
    onTouchMove: (e: ReactTouchEvent) => onDragMove(e.touches[0].clientY),
    onTouchEnd: onDragEnd,
  }

  const dragMouseHandlers = {
    onMouseDown: (e: ReactMouseEvent) => onDragStart(e.clientY),
    onMouseMove: (e: ReactMouseEvent) => { if (dragRef.current.isDragging) onDragMove(e.clientY) },
    onMouseUp: onDragEnd,
    onMouseLeave: () => { if (dragRef.current.isDragging) onDragEnd() },
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Thinking process">
      <div
        className="absolute inset-0 bg-black/45 transition-opacity duration-300"
        style={{ opacity: translateY < 100 ? 1 : 0 }}
        onClick={close}
      />

      <div
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 rounded-t-[20px] border border-[var(--cc-border)] bg-[var(--cc-card-solid)] transition-transform duration-300 ease-out"
        style={{ transform: `translateY(${translateY}%)`, height: 'min(75dvh, 640px)' }}
      >
        <div
          className="flex justify-center py-3 cursor-grab touch-none active:cursor-grabbing"
          {...dragTouchHandlers}
          {...dragMouseHandlers}
        >
          <div className="h-1 w-10 rounded-full bg-[var(--cc-dim)]/40" />
        </div>

        <div
          className="flex cursor-grab touch-none items-center justify-between px-5 pb-3 active:cursor-grabbing"
          {...dragTouchHandlers}
          {...dragMouseHandlers}
        >
          <h3 className="text-sm font-semibold text-[var(--cc-primary)]">Thinking</h3>
          <button
            onClick={close}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            className="rounded-full px-2 py-1 text-xs text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-sub)]"
          >
            Close
          </button>
        </div>

        <div className="cc-thinking-scroll relative h-[calc(100%-80px)] overflow-y-auto overscroll-contain px-5 pb-12">
          <div
            className="cc-thinking-drag-catcher absolute inset-x-5 top-0 z-10 h-16 cursor-grab touch-none active:cursor-grabbing"
            aria-hidden="true"
            {...dragTouchHandlers}
            {...dragMouseHandlers}
          />
          <div className="cc-thinking-content">
            {paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function normalizeThinking(thinking: string) {
  const normalized = thinking
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((part) => part.trim())
    .filter(Boolean)

  return normalized.length > 0 ? normalized : [thinking.trim()]
}
