import { useCallback, useEffect, useRef, useState } from 'react'

export interface RecordingResult {
  blob: Blob
  url: string
  duration: number
  /** Always empty: transcription happens on the backend (STT) after upload. */
  transcript: string
}

interface AudioRecorderState {
  isRecording: boolean
  elapsedMs: number
  liveTranscript: string
  level: number
  error: string | null
}

interface UseAudioRecorderApi extends AudioRecorderState {
  start: () => Promise<void>
  stop: () => Promise<RecordingResult | null>
  cancel: () => void
  supported: boolean
}

const isMediaRecorderSupported = () =>
  typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined'

const hasGetUserMedia = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices !== 'undefined' &&
  typeof navigator.mediaDevices.getUserMedia === 'function'

export function useAudioRecorder(): UseAudioRecorderApi {
  const [state, setState] = useState<AudioRecorderState>({
    isRecording: false,
    elapsedMs: 0,
    liveTranscript: '',
    level: 0,
    error: null,
  })

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startedAtRef = useRef<number>(0)
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const cancelledRef = useRef<boolean>(false)

  const supported = isMediaRecorderSupported()

  const cleanupMedia = useCallback(() => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current)
      tickTimerRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    analyserRef.current = null
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  useEffect(() => cleanupMedia, [cleanupMedia])

  const start = useCallback(async () => {
    if (!supported) {
      setState((s) => ({ ...s, error: '当前浏览器不支持录音' }))
      return
    }

    if (!hasGetUserMedia()) {
      // Secure context guard: getUserMedia is only available on HTTPS or localhost
      const isLocalhost =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1')
      const message = isLocalhost
        ? '麦克风API不可用，请使用最新浏览器'
        : '录音需要HTTPS或localhost。当前是HTTP局域网访问，浏览器禁用了麦克风。'
      setState((s) => ({ ...s, error: message }))
      return
    }

    cancelledRef.current = false
    chunksRef.current = []

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.start()
      startedAtRef.current = Date.now()

      // Tick elapsed time
      tickTimerRef.current = setInterval(() => {
        setState((s) => ({ ...s, elapsedMs: Date.now() - startedAtRef.current }))
      }, 100)

      // Audio level meter
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (Ctor) {
        const ctx = new Ctor()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        analyserRef.current = analyser
        const buffer = new Uint8Array(analyser.frequencyBinCount)
        const measure = () => {
          if (!analyserRef.current) return
          analyserRef.current.getByteTimeDomainData(buffer)
          let sum = 0
          for (let i = 0; i < buffer.length; i++) {
            const v = (buffer[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buffer.length)
          setState((s) => ({ ...s, level: Math.min(1, rms * 3) }))
          rafRef.current = requestAnimationFrame(measure)
        }
        rafRef.current = requestAnimationFrame(measure)
      }

      setState({ isRecording: true, elapsedMs: 0, liveTranscript: '', level: 0, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : '无法访问麦克风'
      setState((s) => ({ ...s, error: message, isRecording: false }))
      cleanupMedia()
    }
  }, [cleanupMedia, supported])

  const stop = useCallback((): Promise<RecordingResult | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current
      if (!recorder || recorder.state === 'inactive') {
        cleanupMedia()
        setState({ isRecording: false, elapsedMs: 0, liveTranscript: '', level: 0, error: null })
        resolve(null)
        return
      }

      const elapsed = Date.now() - startedAtRef.current
      const wasCancelled = cancelledRef.current

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        cleanupMedia()
        setState({ isRecording: false, elapsedMs: 0, liveTranscript: '', level: 0, error: null })

        if (wasCancelled) {
          URL.revokeObjectURL(url)
          resolve(null)
          return
        }

        resolve({
          blob,
          url,
          duration: Math.max(1, Math.round(elapsed / 1000)),
          transcript: '',
        })
      }
      recorder.stop()
    })
  }, [cleanupMedia])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    void stop()
  }, [stop])

  return { ...state, start, stop, cancel, supported }
}
