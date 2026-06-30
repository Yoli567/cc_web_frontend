interface RecordingOverlayProps {
  elapsedMs: number
  liveTranscript: string
  level: number
  cancelHint: boolean
}

/**
 * Floating overlay shown while the user is recording a voice message.
 * Positioned above the composer, anchored to the mic button.
 */
export default function RecordingOverlay({
  elapsedMs,
  liveTranscript,
  level,
  cancelHint,
}: RecordingOverlayProps) {
  const seconds = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(seconds / 60)).padStart(1, '0')
  const ss = String(seconds % 60).padStart(2, '0')

  return (
    <div
      className={`cc-recording-overlay cc-fade-in pointer-events-none absolute bottom-[calc(100%+10px)] right-2 z-30 flex w-[min(20rem,86vw)] flex-col gap-2 rounded-[18px] px-3 py-3 ${
        cancelHint ? 'cc-recording-cancel' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="cc-recording-dot inline-block h-2.5 w-2.5 rounded-full"
            style={{ transform: `scale(${1 + level * 0.5})` }}
            aria-hidden="true"
          />
          <span className="text-[12px] font-medium tabular-nums text-[var(--cc-text)]">
            {mm}:{ss}
          </span>
        </div>
        <span className="text-[11px] text-[var(--cc-dim)]">
          {cancelHint ? '松开取消' : '左滑取消'}
        </span>
      </div>

      <div className="flex items-end gap-[2px]" aria-hidden="true">
        {Array.from({ length: 28 }).map((_, i) => {
          const phase = (i + elapsedMs / 80) * 0.4
          const base = 4 + Math.abs(Math.sin(phase)) * 4
          const dynamic = base + level * 18 * Math.abs(Math.sin(phase + i))
          return (
            <span
              key={i}
              className="cc-recording-wave inline-block w-[3px] rounded-full"
              style={{ height: `${Math.min(28, dynamic)}px` }}
            />
          )
        })}
      </div>

      {liveTranscript ? (
        <p className="cc-recording-transcript max-h-16 overflow-y-auto text-[12px] leading-snug text-[var(--cc-sub)]">
          {liveTranscript}
        </p>
      ) : (
        <p className="text-[11px] italic text-[var(--cc-dim)]">说点什么吧...</p>
      )}
    </div>
  )
}
