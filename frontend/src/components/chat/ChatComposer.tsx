import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useAudioRecorder, type RecordingResult } from '@/hooks/useAudioRecorder'
import RecordingOverlay from './RecordingOverlay'
import type { ReplyTarget } from '@/types'

const USERSTYLE_STORAGE_KEY = 'cc-userstyle-prompt'
const USERSTYLE_ENABLED_KEY = 'cc-userstyle-enabled'
const USERSTYLES_STORAGE_KEY = 'cc-userstyles'
const RECORD_CANCEL_LEFT_PX = 72
const RECORD_MIN_HOLD_MS = 1000

type ComposerMode = 'message' | 'cabin'

interface UserStyle {
  id: string
  name: string
  prompt: string
  enabledByMode: Record<ComposerMode, boolean>
}

interface StoredUserStyle {
  id: string
  name?: string
  prompt?: string
  enabled?: boolean
  enabledByMode?: Partial<Record<ComposerMode, boolean>>
}

export interface PendingImage {
  id: string
  url: string
  name: string
  file: File
}

export interface PendingSticker {
  id: string
  url: string
  path: string
  name: string
  tags: string[]
}

export interface PendingDocument {
  id: string
  url: string
  name: string
  size: number
  mimeType: string
  file: File
}

export interface OutgoingPayload {
  text: string
  userstyle?: string
  stickers?: PendingSticker[]
  images?: PendingImage[]
  documents?: PendingDocument[]
  audio?: RecordingResult
  replyTo?: ReplyTarget
}

interface ChatComposerProps {
  mode: ComposerMode
  value: string
  onChange: (value: string) => void
  onSend: (payload: OutgoingPayload) => void
  placeholder: string
  disabled?: boolean
  multiline?: boolean
  keepFocusAfterSend?: boolean
  replyTo?: ReplyTarget | null
  onCancelReply?: () => void
}

export default function ChatComposer({
  mode,
  value,
  onChange,
  onSend,
  placeholder,
  disabled = false,
  multiline = false,
  keepFocusAfterSend = false,
  replyTo = null,
  onCancelReply,
}: ChatComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [userstyleOpen, setUserstyleOpen] = useState(false)
  const [editingStyleId, setEditingStyleId] = useState<string | null>(null)
  const [userStyles, setUserStyles] = useState<UserStyle[]>(loadUserStyles)
  const [styleEditorOpen, setStyleEditorOpen] = useState(false)
  const [draftStyleName, setDraftStyleName] = useState('')
  const [draftStylePrompt, setDraftStylePrompt] = useState('')
  const [stickerPanelOpen, setStickerPanelOpen] = useState(false)
  const [stickers, setStickers] = useState<PendingSticker[]>([])
  const [stickersLoading, setStickersLoading] = useState(false)
  const [stickersError, setStickersError] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([])
  const [fieldTall, setFieldTall] = useState(false)
  const [cancelHint, setCancelHint] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pointerStart = useRef<{ x: number; y: number; at: number } | null>(null)
  const cancelHintRef = useRef(false)
  const recordingStartPendingRef = useRef(false)
  const queuedFinishRef = useRef<boolean | null>(null)
  const recorder = useAudioRecorder()

  useEffect(() => {
    localStorage.setItem(USERSTYLES_STORAGE_KEY, JSON.stringify(userStyles))
  }, [userStyles])

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    const nextHeight = Math.min(field.scrollHeight, 112)
    field.style.height = `${nextHeight}px`
    setFieldTall(nextHeight > 46)
  }, [value, multiline])

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.url))
      pendingDocuments.forEach((doc) => URL.revokeObjectURL(doc.url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasText = value.trim().length > 0
  const hasImages = pendingImages.length > 0
  const hasDocuments = pendingDocuments.length > 0
  const hasSendableContent = hasText || hasImages || hasDocuments
  const canSend = hasSendableContent && !disabled
  const currentUserstyle = () => buildUserstyleInstructions(userStyles, mode)

  const handleSend = () => {
    const text = value.trim()
    if (!canSend) return
    onSend({
      text,
      userstyle: currentUserstyle(),
      images: hasImages ? pendingImages : undefined,
      documents: hasDocuments ? pendingDocuments : undefined,
      replyTo: replyTo ?? undefined,
    })
    setPendingImages([])
    setPendingDocuments([])
    setMenuOpen(false)
    setStickerPanelOpen(false)
    if (keepFocusAfterSend) {
      window.requestAnimationFrame(() => fieldRef.current?.focus({ preventScroll: true }))
    }
  }

  const loadStickers = async () => {
    if (stickers.length > 0 || stickersLoading) return
    setStickersLoading(true)
    setStickersError('')
    try {
      const response = await fetch('/api/stickers', { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { stickers?: Array<Record<string, unknown>> }
      const parsed = (data.stickers ?? []).flatMap((item): PendingSticker[] => {
        const id = typeof item.id === 'string' ? item.id : ''
        const url = typeof item.url === 'string' ? item.url : ''
        const path = typeof item.path === 'string' ? item.path : ''
        if (!id || !url || !path) return []
        const tags = Array.isArray(item.tags)
          ? item.tags.map((tag) => String(tag)).filter(Boolean)
          : []
        return [{
          id,
          url,
          path,
          name: typeof item.name === 'string' ? item.name : `${id}.webp`,
          tags,
        }]
      })
      setStickers(parsed)
      if (parsed.length === 0) setStickersError('No stickers yet')
    } catch {
      setStickersError('Could not load stickers')
    } finally {
      setStickersLoading(false)
    }
  }

  const toggleStickerPanel = () => {
    setStickerPanelOpen((open) => {
      const next = !open
      if (next) void loadStickers()
      return next
    })
    setUserstyleOpen(false)
  }

  const addSticker = (sticker: PendingSticker) => {
    onSend({
      text: '',
      userstyle: currentUserstyle(),
      stickers: [sticker],
      replyTo: replyTo ?? undefined,
    })
    setMenuOpen(false)
    setStickerPanelOpen(false)
  }

  const handleImageFile = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return
    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const url = URL.createObjectURL(file)
    setPendingImages((current) => [...current, { id, url, name: file.name, file }])
    setMenuOpen(false)
  }

  const handleDocumentFile = (file: File | undefined) => {
    if (!file) return
    // If user picks an image through the File button, route it as an image instead.
    if (file.type.startsWith('image/')) {
      handleImageFile(file)
      return
    }
    const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const url = URL.createObjectURL(file)
    setPendingDocuments((current) => [
      ...current,
      { id, url, name: file.name, size: file.size, mimeType: file.type, file },
    ])
    setMenuOpen(false)
  }

  const removeImage = (id: string) => {
    setPendingImages((current) => {
      const target = current.find((img) => img.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return current.filter((img) => img.id !== id)
    })
  }

  const removeDocument = (id: string) => {
    setPendingDocuments((current) => {
      const target = current.find((doc) => doc.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return current.filter((doc) => doc.id !== id)
    })
  }

  const enabledStyleCount = userStyles.filter((style) => isStyleEnabledForMode(style, mode) && style.prompt.trim()).length

  const openAddUserStyle = () => {
    setEditingStyleId(null)
    setDraftStyleName(`Style ${userStyles.length + 1}`)
    setDraftStylePrompt('')
    setStyleEditorOpen(true)
  }

  const openEditUserStyle = (style: UserStyle) => {
    setEditingStyleId(style.id)
    setDraftStyleName(style.name)
    setDraftStylePrompt(style.prompt)
    setStyleEditorOpen(true)
  }

  const saveUserStyle = () => {
    const name = draftStyleName.trim() || `Style ${userStyles.length + 1}`
    const prompt = draftStylePrompt.trim()

    if (editingStyleId) {
      updateUserStyle(editingStyleId, { name, prompt })
    } else {
      setUserStyles((current) => [...current, createUserStyle(name, prompt, mode)])
    }

    setStyleEditorOpen(false)
    setEditingStyleId(null)
  }

  const updateUserStyle = (id: string, patch: Partial<Pick<UserStyle, 'name' | 'prompt'>>) => {
    setUserStyles((current) =>
      current.map((style) => (style.id === id ? { ...style, ...patch } : style)),
    )
  }

  const setUserStyleEnabled = (id: string, enabled: boolean) => {
    setUserStyles((current) =>
      current.map((style) =>
        style.id === id
          ? { ...style, enabledByMode: { ...style.enabledByMode, [mode]: enabled } }
          : style,
      ),
    )
  }

  const deleteUserStyle = (id: string) => {
    setUserStyles((current) => current.filter((style) => style.id !== id))
    setEditingStyleId((current) => (current === id ? null : current))
    setStyleEditorOpen(false)
  }

  // Voice recording handlers
  const handleMicPointerDown = async (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || hasSendableContent) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    pointerStart.current = { x: e.clientX, y: e.clientY, at: e.timeStamp }
    cancelHintRef.current = false
    setCancelHint(false)
    recordingStartPendingRef.current = true
    await recorder.start()
    recordingStartPendingRef.current = false

    if (queuedFinishRef.current !== null) {
      const cancel = queuedFinishRef.current
      queuedFinishRef.current = null
      void finishRecording(cancel)
    }
  }

  const handleMicPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if ((!recorder.isRecording && !recordingStartPendingRef.current) || pointerStart.current == null) return
    const dx = pointerStart.current.x - e.clientX
    const dy = pointerStart.current.y - e.clientY
    const shouldCancel = dx > RECORD_CANCEL_LEFT_PX && dx > Math.abs(dy) * 1.15
    cancelHintRef.current = shouldCancel
    setCancelHint(shouldCancel)
  }

  const finishRecording = async (cancel: boolean) => {
    if (recordingStartPendingRef.current) {
      queuedFinishRef.current = cancel
      return
    }
    const heldMs = pointerStart.current ? window.performance.now() - pointerStart.current.at : recorder.elapsedMs
    if (cancel || heldMs < RECORD_MIN_HOLD_MS) {
      recorder.cancel()
      pointerStart.current = null
      cancelHintRef.current = false
      setCancelHint(false)
      return
    }
    const result = await recorder.stop()
    pointerStart.current = null
    cancelHintRef.current = false
    setCancelHint(false)
    if (result && result.duration >= 1) {
      onSend({ text: '', userstyle: currentUserstyle(), audio: result })
    }
  }

  const handleMicPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    void finishRecording(cancelHintRef.current)
  }

  const handleMicPointerCancel = () => {
    if (!recorder.isRecording && !recordingStartPendingRef.current) return
    void finishRecording(true)
  }

  return (
    <div className="cc-composer-wrap px-3 pt-2">
      <div className="relative">
        {recorder.isRecording && (
          <RecordingOverlay
            elapsedMs={recorder.elapsedMs}
            liveTranscript={recorder.liveTranscript}
            level={recorder.level}
            cancelHint={cancelHint}
          />
        )}

        {menuOpen && !recorder.isRecording && (
          <div className="cc-composer-menu cc-fade-in absolute bottom-[calc(100%+8px)] left-0 right-0 z-10 p-2">
            <div className="grid grid-cols-4 gap-1.5">
              <ComposerMenuButton label="Sticker" active={stickerPanelOpen} onClick={toggleStickerPanel}>
                <StickerIcon />
              </ComposerMenuButton>
              <ComposerMenuButton label="Image" onClick={() => imageInputRef.current?.click()}>
                <ImageIcon />
              </ComposerMenuButton>
              <ComposerMenuButton label="File" onClick={() => {
                fileInputRef.current?.click()
                setMenuOpen(false)
              }}>
                <FileIcon />
              </ComposerMenuButton>
              <ComposerMenuButton
                label="Style"
                active={enabledStyleCount > 0 || userstyleOpen}
                onClick={() => {
                  setStickerPanelOpen(false)
                  setUserstyleOpen((open) => !open)
                }}
              >
                <StyleIcon />
              </ComposerMenuButton>
            </div>

            {stickerPanelOpen && (
              <div className="cc-sticker-panel mt-2">
                {stickersLoading ? (
                  <div className="px-3 py-3 text-center text-[12px] text-[var(--cc-dim)]">Loading...</div>
                ) : stickersError ? (
                  <div className="px-3 py-3 text-center text-[12px] text-[var(--cc-dim)]">{stickersError}</div>
                ) : (
                  <div className="cc-sticker-grid">
                    {stickers.map((sticker) => (
                      <button
                        key={sticker.id}
                        type="button"
                        className="cc-sticker-choice"
                        title={sticker.tags.join(' ')}
                        aria-label={sticker.tags.join(' ') || sticker.name}
                        onClick={() => addSticker(sticker)}
                      >
                        <img src={sticker.url} alt={sticker.tags[0] || sticker.name} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {userstyleOpen && (
              <div className="cc-userstyle-panel mt-2">
                <div className="cc-userstyle-header flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <span className="block text-[12px] font-medium text-[var(--cc-text)]">Userstyle</span>
                    <span className="block text-[10px] text-[var(--cc-dim)]">
                      {mode === 'message' ? 'Message' : 'Cabin'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={openAddUserStyle}
                    className="cc-userstyle-add px-2 py-1 text-[11px] font-medium text-[var(--cc-primary)]"
                  >
                    Add
                  </button>
                </div>

                <div className="cc-userstyle-list">
                  {userStyles.length === 0 && (
                    <button
                      type="button"
                      onClick={openAddUserStyle}
                      className="cc-userstyle-empty w-full px-3 py-2.5 text-left text-[12px] text-[var(--cc-dim)]"
                    >
                      Add a style prompt...
                    </button>
                  )}

                  {userStyles.map((style) => (
                    <div key={style.id} className="cc-userstyle-row flex items-center gap-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-[var(--cc-text)]">
                          {style.name || 'Untitled style'}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--cc-dim)]">
                          {style.prompt || 'No prompt yet'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => openEditUserStyle(style)}
                        aria-label="Edit style"
                        title="Edit"
                        className="cc-userstyle-icon"
                      >
                        <EditIcon />
                      </button>
                      <label className="cc-userstyle-switch">
                        <input
                          type="checkbox"
                          checked={isStyleEnabledForMode(style, mode)}
                          onChange={(e) => setUserStyleEnabled(style.id, e.target.checked)}
                        />
                        <span />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {replyTo && (
          <div className="cc-reply-preview mb-2 flex items-center gap-2 rounded-2xl px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase text-[var(--cc-primary)]">
                Replying to {replyTo.role === 'user' ? 'you' : 'Claude'}
              </p>
              <p className="truncate text-xs text-[var(--cc-sub)]">{replyTo.text}</p>
            </div>
            <button
              type="button"
              aria-label="Cancel reply"
              className="cc-session-icon-btn shrink-0"
              onClick={onCancelReply}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {(pendingImages.length > 0 || pendingDocuments.length > 0) && (
          <div className="cc-attachment-tray mb-2 flex flex-wrap justify-end gap-1.5">
            {pendingImages.map((img) => (
              <div key={img.id} className="cc-attachment-thumb relative">
                <img src={img.url} alt={img.name} className="h-14 w-14 rounded-lg object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  aria-label="Remove image"
                  className="cc-attachment-remove absolute -right-1 -top-1"
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
            {pendingDocuments.map((doc) => (
              <div key={doc.id} className="cc-attachment-doc-chip relative flex items-center gap-2 px-2.5 py-1.5">
                <FileIcon />
                <span className="max-w-[120px] truncate text-[12px] text-[var(--cc-text)]">{doc.name}</span>
                <button
                  type="button"
                  onClick={() => removeDocument(doc.id)}
                  aria-label="Remove file"
                  className="cc-attachment-remove absolute -right-1 -top-1"
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="cc-composer-row flex items-end gap-2">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Open message tools"
            title="Tools"
            disabled={recorder.isRecording}
            className={`cc-composer-plus shrink-0 ${menuOpen ? 'is-active' : ''}`}
          >
            <PlusIcon open={menuOpen} />
          </button>

          <div className={`cc-composer flex min-w-0 flex-1 items-end gap-1 ${fieldTall ? 'is-tall' : ''}`}>
            <textarea
              ref={fieldRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={recorder.isRecording ? '正在录音...' : placeholder}
              rows={1}
              disabled={recorder.isRecording}
              className="cc-composer-field max-h-28 min-h-9 flex-1 resize-none bg-transparent py-2.5 text-sm leading-[1.35] text-[var(--cc-text)] outline-none placeholder:text-[var(--cc-dim)]"
            />
            <button
              type="button"
              onClick={hasSendableContent ? handleSend : undefined}
              onPointerDown={
                hasSendableContent
                  ? keepFocusAfterSend
                    ? (e) => e.preventDefault()
                    : undefined
                  : handleMicPointerDown
              }
              onPointerMove={hasSendableContent ? undefined : handleMicPointerMove}
              onPointerUp={hasSendableContent ? undefined : handleMicPointerUp}
              onPointerCancel={hasSendableContent ? undefined : handleMicPointerCancel}
              disabled={disabled}
              aria-label={hasSendableContent ? 'Send' : 'Hold to record'}
              title={hasSendableContent ? 'Send' : 'Hold to record'}
              className={`cc-composer-action shrink-0 ${hasSendableContent ? 'can-send' : ''} ${recorder.isRecording ? 'is-recording' : ''}`}
            >
              {hasSendableContent ? <SendIcon /> : <MicIcon />}
            </button>
          </div>
        </div>

        {recorder.error && (
          <div className="cc-recording-error mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--cc-primary)]">
            {recorder.error}
          </div>
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          files.forEach(handleImageFile)
          e.target.value = ''
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          files.forEach(handleDocumentFile)
          e.target.value = ''
        }}
      />

      {styleEditorOpen && (
        <div className="cc-settings-modal-root" role="dialog" aria-modal="true" aria-label="Edit userstyle">
          <button
            type="button"
            className="cc-settings-modal-backdrop"
            aria-label="Close"
            onClick={() => setStyleEditorOpen(false)}
          />
          <div className="cc-settings-modal-panel">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-[var(--cc-text)]">
                {editingStyleId ? 'Edit Style' : 'Add Style'}
              </h2>
              <button
                type="button"
                className="cc-session-icon-btn"
                aria-label="Close"
                onClick={() => setStyleEditorOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="space-y-3">
              <label className="cc-settings-field">
                Name
                <input
                  value={draftStyleName}
                  onChange={(e) => setDraftStyleName(e.target.value)}
                  placeholder="Style name"
                />
              </label>
              <label className="cc-settings-field">
                Prompt
                <textarea
                  value={draftStylePrompt}
                  onChange={(e) => setDraftStylePrompt(e.target.value)}
                  placeholder="Write the style here..."
                  className="cc-settings-textarea"
                />
              </label>
            </div>
            <div className="mt-4 flex items-center gap-2">
              {editingStyleId && (
                <button
                  type="button"
                  className="cc-modal-secondary-btn mr-auto"
                  onClick={() => deleteUserStyle(editingStyleId)}
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                className="cc-modal-secondary-btn"
                onClick={() => setStyleEditorOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveUserStyle}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function loadUserStyles(): UserStyle[] {
  const stored = localStorage.getItem(USERSTYLES_STORAGE_KEY)
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredUserStyle[]
      if (Array.isArray(parsed)) {
        return parsed
          .filter((style) => typeof style.id === 'string')
          .map(normalizeUserStyle)
      }
    } catch {
      // Fall through to legacy migration.
    }
  }

  const legacyPrompt = localStorage.getItem(USERSTYLE_STORAGE_KEY)?.trim() ?? ''
  if (!legacyPrompt) return []

  return [
    createLegacyUserStyle('Default style', legacyPrompt, localStorage.getItem(USERSTYLE_ENABLED_KEY) === 'true'),
  ]
}

function normalizeUserStyle(style: StoredUserStyle): UserStyle {
  const legacyEnabled = Boolean(style.enabled)

  return {
    id: style.id,
    name: style.name ?? '',
    prompt: style.prompt ?? '',
    enabledByMode: {
      message: style.enabledByMode?.message ?? legacyEnabled,
      cabin: style.enabledByMode?.cabin ?? legacyEnabled,
    },
  }
}

function createUserStyle(name: string, prompt: string, mode: ComposerMode): UserStyle {
  return {
    id: `style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    prompt,
    enabledByMode: {
      message: mode === 'message',
      cabin: mode === 'cabin',
    },
  }
}

function createLegacyUserStyle(name: string, prompt: string, enabled: boolean): UserStyle {
  return {
    id: `style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    prompt,
    enabledByMode: {
      message: enabled,
      cabin: enabled,
    },
  }
}

function isStyleEnabledForMode(style: UserStyle, mode: ComposerMode) {
  return style.enabledByMode[mode]
}

function buildUserstyleInstructions(userStyles: UserStyle[], mode: ComposerMode) {
  const enabledPrompts = userStyles
    .filter((style) => isStyleEnabledForMode(style, mode) && style.prompt.trim())
    .map((style) => {
      const name = style.name.trim()
      const prompt = style.prompt.trim()
      return name ? `[${name}]\n${prompt}` : prompt
    })

  return enabledPrompts.length > 0 ? enabledPrompts.join('\n\n') : undefined
}

function ComposerMenuButton({
  children,
  label,
  active = false,
  onClick,
}: {
  children: ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`cc-composer-menu-button flex h-12 flex-col items-center justify-center gap-1 text-[10px] ${
        active ? 'is-active' : ''
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

function PlusIcon({ open }: { open: boolean }) {
  return (
    <svg className={`h-4 w-4 transition-transform ${open ? 'rotate-45' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

function StickerIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 4h7l5 5v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4v3a2 2 0 0 0 2 2h3M9 13h.01M15 13h.01M9 16c1.6 1 4.4 1 6 0" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m4 16 4-4 3 3 3-4 6 6M8 9h.01" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M8 13h8M8 17h5" />
    </svg>
  )
}

function StyleIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19 16 8l3 3L8 22H5v-3ZM14 10l3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h8M4 9h5" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19 16 8l3 3L8 22H5v-3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 10l3 3" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
