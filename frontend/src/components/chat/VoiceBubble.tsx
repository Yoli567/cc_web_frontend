import { useEffect, useRef, useState } from 'react'
import { getVoiceBlob, putVoice } from '@/utils/voiceCache'

interface VoiceBubbleProps {
  cacheKey: string
  url?: string
  duration: number
  transcript?: string
  isUser: boolean
}

/**
 * WeChat-style voice message bubble.
 * - Plays from the IndexedDB voice cache (falls back to fetching `url` once, then
 *   caches it). When neither is available (cache expired after 3 days, backend
 *   file gone) the bubble shows an "expired" state but the transcript stays.
 * - Width scales with duration. "A" button reveals the transcript.
 */
export default function VoiceBubble({ cacheKey, url, duration, transcript, isUser }: VoiceBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setExpired(false)
    setPlaying(false)

    const resolve = async () => {
      let blob = await getVoiceBlob(cacheKey)
      if (!blob && url) {
        try {
          const resp = await fetch(url, { credentials: 'include' })
          if (resp.ok) {
            blob = await resp.blob()
            void putVoice(cacheKey, blob)
          }
        } catch {
          /* network error / expired */
        }
      }
      if (cancelled) return
      if (!blob) {
        setExpired(true)
        return
      }
      const objectUrl = URL.createObjectURL(blob)
      objectUrlRef.current = objectUrl
      const audio = new Audio(objectUrl)
      audio.addEventListener('ended', () => setPlaying(false))
      audioRef.current = audio
      setReady(true)
    }
    void resolve()

    return () => {
      cancelled = true
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [cacheKey, url])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio || !ready) return
    if (playing) {
      audio.pause()
      audio.currentTime = 0
      setPlaying(false)
    } else {
      void audio.play()
      setPlaying(true)
    }
  }

  // Width scales 70px (1s) → 200px (≥30s)
  const widthPx = Math.round(70 + Math.min(duration, 30) * 4.5)
  const transcriptText = transcript?.trim() || (expired ? '语音已过期，转写不可用' : '暂无转写')

  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-center gap-1.5 ${isUser ? 'flex-row-reverse' : ''}`}>
        <button
          type="button"
          onClick={toggle}
          disabled={expired || !ready}
          aria-label={expired ? '语音已过期' : playing ? 'Stop voice' : 'Play voice'}
          title={expired ? '语音已过期' : undefined}
          className={`cc-voice-bubble flex items-center justify-between gap-2 px-3 py-2 ${
            isUser ? 'cc-voice-bubble-user' : 'cc-voice-bubble-assistant'
          }`}
          style={{ width: `${widthPx}px`, opacity: expired ? 0.5 : ready ? 1 : 0.7 }}
        >
          {isUser ? (
            <>
              <span className="cc-voice-duration shrink-0 text-[12px] tabular-nums">{duration}″</span>
              <VoiceIcon playing={playing} reverse expired={expired} />
            </>
          ) : (
            <>
              <VoiceIcon playing={playing} expired={expired} />
              <span className="cc-voice-duration shrink-0 text-[12px] tabular-nums">{duration}″</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => setTranscriptOpen((v) => !v)}
          aria-label="Toggle transcript"
          title="Show transcript"
          className="cc-voice-transcript-btn shrink-0"
        >
          <span className="text-[10px] font-semibold">A</span>
        </button>
      </div>

      {transcriptOpen && (
        <div className="cc-voice-transcript max-w-[260px] rounded-[14px] px-3 py-2 text-[13px] leading-[1.45]">
          {transcriptText}
        </div>
      )}
    </div>
  )
}

function VoiceIcon({ playing, reverse = false, expired = false }: { playing: boolean; reverse?: boolean; expired?: boolean }) {
  if (expired) {
    return (
      <svg
        className={`h-[18px] w-[18px] shrink-0 ${reverse ? 'scale-x-[-1]' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      >
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.5 1.5" />
      </svg>
    )
  }
  return (
    <svg
      className={`h-[18px] w-[18px] shrink-0 ${reverse ? 'scale-x-[-1]' : ''} ${playing ? 'opacity-80' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.9"
    >
      <path d="M6 12h.01" strokeWidth="3" />
      {playing ? (
        <>
          <path d="M9.2 9.4c1.45 1.45 1.45 3.75 0 5.2" />
          <path d="M12.4 7.1c2.55 2.75 2.55 7.05 0 9.8" />
          <path d="M15.6 4.8c3.85 4.25 3.85 10.15 0 14.4" />
        </>
      ) : (
        <>
          <path d="M9.2 9.4c1.45 1.45 1.45 3.75 0 5.2" />
          <path d="M12.4 7.1c2.55 2.75 2.55 7.05 0 9.8" opacity="0.72" />
          <path d="M15.6 4.8c3.85 4.25 3.85 10.15 0 14.4" opacity="0.48" />
        </>
      )}
    </svg>
  )
}
