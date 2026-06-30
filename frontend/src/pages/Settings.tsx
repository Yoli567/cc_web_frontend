import { useState, useEffect, useCallback, type ChangeEvent, type ReactNode } from 'react'
import { useTheme, type CustomFont, type FontTarget, type ThemeMode, type ThemePalette } from '@/theme/ThemeContext'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import { useWebSocket, getWsLog, subscribeWsLog, type WsLogEntry } from '@/hooks/useWebSocket'
import { useSessions } from '@/sessions/SessionsContext'
import {
  exportAllData,
  formatBytes,
  getStorageSnapshot,
  importAllData,
  type BackupImportMode,
  type StorageSnapshot,
} from '@/utils/dataBackup'
import {
  DEFAULT_NUDGE_MESSAGE,
  dispatchNudgeSettingsChanged,
  NUDGE_ACTIVE_END_KEY,
  NUDGE_ACTIVE_START_KEY,
  NUDGE_ENABLED_KEY,
  NUDGE_INTERVAL_UNIT_KEY,
  NUDGE_INTERVAL_VALUE_KEY,
  NUDGE_MESSAGE_KEY,
  syncNudgeSettingsToBackend,
  type NudgeIntervalUnit,
} from '@/utils/nudgeSettings'
import {
  DEFAULT_DIARY_PROMPT,
  DIARY_ENABLED_KEY,
  DIARY_PROMPT_KEY,
  DIARY_TIME_KEY,
  dispatchDiarySettingsChanged,
  syncDiarySettingsToBackend,
} from '@/utils/diarySettings'
import { getDetailedNotificationStatus, subscribeToWebPush, type NotificationStatus } from '@/utils/pwaNotifications'
import VoiceSettings from '@/components/settings/VoiceSettings'

const paletteOrder: ThemePalette[] = ['orange', 'pink', 'purple', 'green', 'brown']
const MAX_FONT_SIZE = 12_000_000
const STREAMING_ENABLED_KEY = 'cc-streaming-enabled'

export default function Settings() {
  const { openSidebar } = useAppLayout()
  const { currentSessionId } = useSessions()
  // Subscribe to the real WS state — useWebSocket returns sticky-connected
  // so this reflects "is the backend reachable" not just "is this hook's
  // socket open right now".
  const wsHandler = useCallback(() => {}, [])
  const { connected: wsConnected } = useWebSocket(wsHandler)
  const {
    mode,
    palette,
    palettes,
    backgrounds,
    selectedFonts,
    customFonts,
    liquidGlass,
    surfaceOpacity,
    cabinBubble,
    cabinBackground,
    setMode,
    setPalette,
    setBackground,
    clearBackground,
    setSelectedFont,
    addCustomFont,
    deleteCustomFont,
    setLiquidGlass,
    setSurfaceOpacity,
    setCabinBubble,
    setCabinBackground,
  } = useTheme()
  const [uploadError, setUploadError] = useState('')
  const [streamingEnabled, setStreamingEnabledState] = useState(
    () => localStorage.getItem(STREAMING_ENABLED_KEY) === 'true',
  )
  const [nudgeEnabled, setNudgeEnabledState] = useState(() => localStorage.getItem(NUDGE_ENABLED_KEY) !== 'false')
  const [nudgeMessage, setNudgeMessage] = useState(() => localStorage.getItem(NUDGE_MESSAGE_KEY) ?? DEFAULT_NUDGE_MESSAGE)
  const [activeStart, setActiveStart] = useState(() => localStorage.getItem(NUDGE_ACTIVE_START_KEY) ?? '09:00')
  const [activeEnd, setActiveEnd] = useState(() => localStorage.getItem(NUDGE_ACTIVE_END_KEY) ?? '23:00')
  const [intervalValue, setIntervalValue] = useState(() => localStorage.getItem(NUDGE_INTERVAL_VALUE_KEY) ?? '2')
  const [intervalUnit, setIntervalUnit] = useState<NudgeIntervalUnit>(
    () => (localStorage.getItem(NUDGE_INTERVAL_UNIT_KEY) as NudgeIntervalUnit | null) ?? 'hours',
  )
  const [diaryEnabled, setDiaryEnabledState] = useState(() => localStorage.getItem(DIARY_ENABLED_KEY) !== 'false')
  const [diaryTime, setDiaryTime] = useState(() => localStorage.getItem(DIARY_TIME_KEY) ?? '22:30')
  const [diaryPrompt, setDiaryPrompt] = useState(() => localStorage.getItem(DIARY_PROMPT_KEY) ?? DEFAULT_DIARY_PROMPT)
  const [nudgeDraft, setNudgeDraft] = useState(nudgeMessage)
  const [activeStartDraft, setActiveStartDraft] = useState(activeStart)
  const [activeEndDraft, setActiveEndDraft] = useState(activeEnd)
  const [intervalValueDraft, setIntervalValueDraft] = useState(intervalValue)
  const [intervalUnitDraft, setIntervalUnitDraft] = useState<NudgeIntervalUnit>(intervalUnit)
  const [diaryTimeDraft, setDiaryTimeDraft] = useState(diaryTime)
  const [diaryPromptDraft, setDiaryPromptDraft] = useState(diaryPrompt)
  const [activeModal, setActiveModal] = useState<'nudge' | 'hours' | 'interval' | 'diaryTime' | 'diaryPrompt' | 'logs' | null>(null)
  const [fontModalTarget, setFontModalTarget] = useState<FontTarget | null>(null)
  const [backupMode, setBackupMode] = useState<BackupImportMode>('merge')
  const [storageSnapshot, setStorageSnapshot] = useState<StorageSnapshot | null>(null)
  const [dataStatus, setDataStatus] = useState('')
  const [debugLogs, setDebugLogs] = useState<WsLogEntry[]>(() => getWsLog())
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('default')

  useEffect(() => subscribeWsLog(setDebugLogs), [])

  useEffect(() => {
    let cancelled = false
    const refreshNotificationStatus = () => {
      void getDetailedNotificationStatus().then((status) => {
        if (!cancelled) setNotificationStatus(status)
      })
    }
    refreshNotificationStatus()
    document.addEventListener('visibilitychange', refreshNotificationStatus)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', refreshNotificationStatus)
    }
  }, [])

  const refreshStorageSnapshot = useCallback(() => {
    void getStorageSnapshot()
      .then(setStorageSnapshot)
      .catch(() => setStorageSnapshot(null))
  }, [])

  useEffect(() => {
    refreshStorageSnapshot()
  }, [refreshStorageSnapshot])

  useEffect(() => {
    void syncNudgeSettingsToBackend(currentSessionId).catch(() => {})
  }, [activeEnd, activeStart, currentSessionId, intervalUnit, intervalValue, nudgeEnabled, nudgeMessage])

  useEffect(() => {
    void syncDiarySettingsToBackend(currentSessionId).catch(() => {})
  }, [currentSessionId, diaryEnabled, diaryPrompt, diaryTime])

  const handleBackgroundUpload = (targetMode: ThemeMode, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file.')
      return
    }

    if (file.size > 2_000_000) {
      setUploadError('Please choose an image under 2 MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        setBackground(targetMode, String(reader.result))
        setUploadError('')
      } catch {
        setUploadError('This image is too large to save locally.')
      }
    }
    reader.onerror = () => setUploadError('Could not read this image.')
    reader.readAsDataURL(file)
  }

  const handleFontUpload = async (target: FontTarget, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    const fontLike = file.type.startsWith('font/') || /\.(woff2?|ttf|otf|ttc)$/i.test(file.name)
    if (!fontLike) {
      setUploadError('Please choose a font file: woff, woff2, ttf, otf, or ttc.')
      return
    }

    if (file.size > MAX_FONT_SIZE) {
      setUploadError('Please choose a font under 12 MB.')
      return
    }

    try {
      await addCustomFont(target, file)
      setUploadError('')
    } catch {
      setUploadError('This font could not be saved locally.')
    }
  }

  const setStreamingEnabled = (value: boolean) => {
    setStreamingEnabledState(value)
    localStorage.setItem(STREAMING_ENABLED_KEY, String(value))
    fetch('/api/streaming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: value }),
      credentials: 'include',
    }).catch(() => {})
  }

  const setNudgeEnabled = (value: boolean) => {
    setNudgeEnabledState(value)
    localStorage.setItem(NUDGE_ENABLED_KEY, String(value))
    dispatchNudgeSettingsChanged()
  }

  const setDiaryEnabled = (value: boolean) => {
    setDiaryEnabledState(value)
    localStorage.setItem(DIARY_ENABLED_KEY, String(value))
    dispatchDiarySettingsChanged()
  }

  const openNudgeModal = () => {
    setNudgeDraft(nudgeMessage)
    setActiveModal('nudge')
  }

  const openHoursModal = () => {
    setActiveStartDraft(activeStart)
    setActiveEndDraft(activeEnd)
    setActiveModal('hours')
  }

  const openIntervalModal = () => {
    setIntervalValueDraft(intervalValue)
    setIntervalUnitDraft(intervalUnit)
    setActiveModal('interval')
  }

  const openDiaryTimeModal = () => {
    setDiaryTimeDraft(diaryTime)
    setActiveModal('diaryTime')
  }

  const openDiaryPromptModal = () => {
    setDiaryPromptDraft(diaryPrompt)
    setActiveModal('diaryPrompt')
  }

  const saveNudgeMessage = () => {
    const next = nudgeDraft.trim() || DEFAULT_NUDGE_MESSAGE
    setNudgeMessage(next)
    localStorage.setItem(NUDGE_MESSAGE_KEY, next)
    dispatchNudgeSettingsChanged()
    setActiveModal(null)
  }

  const saveActiveHours = () => {
    setActiveStart(activeStartDraft)
    setActiveEnd(activeEndDraft)
    localStorage.setItem(NUDGE_ACTIVE_START_KEY, activeStartDraft)
    localStorage.setItem(NUDGE_ACTIVE_END_KEY, activeEndDraft)
    dispatchNudgeSettingsChanged()
    setActiveModal(null)
  }

  const saveInterval = () => {
    const nextValue = Math.max(1, Number(intervalValueDraft) || 1)
    const normalizedValue = String(nextValue)
    setIntervalValue(normalizedValue)
    setIntervalUnit(intervalUnitDraft)
    localStorage.setItem(NUDGE_INTERVAL_VALUE_KEY, normalizedValue)
    localStorage.setItem(NUDGE_INTERVAL_UNIT_KEY, intervalUnitDraft)
    dispatchNudgeSettingsChanged()
    setActiveModal(null)
  }

  const saveDiaryTime = () => {
    setDiaryTime(diaryTimeDraft)
    localStorage.setItem(DIARY_TIME_KEY, diaryTimeDraft)
    dispatchDiarySettingsChanged()
    setActiveModal(null)
  }

  const saveDiaryPrompt = () => {
    const next = diaryPromptDraft.trim() || DEFAULT_DIARY_PROMPT
    setDiaryPrompt(next)
    localStorage.setItem(DIARY_PROMPT_KEY, next)
    dispatchDiarySettingsChanged()
    setActiveModal(null)
  }

  const enableNotifications = async () => {
    setNotificationStatus(await subscribeToWebPush())
  }

  const [nudgeTestStatus, setNudgeTestStatus] = useState('')
  const triggerTestNudge = async () => {
    setNudgeTestStatus('Firing…')
    try {
      const response = await fetch('/api/nudge/test', { method: 'POST', credentials: 'include' })
      setNudgeTestStatus(response.ok ? 'Nudge fired ✓' : 'Failed to fire')
    } catch {
      setNudgeTestStatus('Failed to fire')
    }
    window.setTimeout(() => setNudgeTestStatus(''), 4000)
  }

  const handleExportAllData = async () => {
    try {
      setDataStatus('Preparing backup...')
      await exportAllData()
      setDataStatus('Backup exported.')
      refreshStorageSnapshot()
    } catch {
      setDataStatus('Could not export this backup.')
    }
  }

  const handleImportBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      setDataStatus(backupMode === 'replace' ? 'Replacing local data...' : 'Merging backup...')
      await importAllData(file, backupMode)
      setDataStatus('Import complete. Reloading...')
      window.setTimeout(() => window.location.reload(), 600)
    } catch {
      setDataStatus('Could not import this backup.')
    }
  }

  return (
    <div className="cc-page h-full overflow-y-auto">
      <header className="cc-header px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open navigation"
            title="Navigation"
            className="cc-header-nav-button"
          >
            <SidebarOpenIcon />
          </button>
          <h1 className="text-lg font-semibold text-[var(--cc-text)]">Settings</h1>
        </div>
      </header>

      <div className="space-y-4 p-4">
        <SettingsSection title="Appearance">
          <SettingsControl label="Mode">
            <div className="grid grid-cols-2 rounded-full bg-[var(--cc-input)] p-1">
              <ModeButton label="Dark" value="dark" current={mode} onChange={setMode} />
              <ModeButton label="Light" value="light" current={mode} onChange={setMode} />
            </div>
          </SettingsControl>

          <SettingsControl label="Palette">
            <div className="flex flex-wrap justify-end gap-2">
              {paletteOrder.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={`${palettes[key].label} palette`}
                  onClick={() => setPalette(key)}
                  className={`h-8 w-8 rounded-full border transition-transform active:scale-95 ${
                    palette === key
                      ? 'scale-105 border-[var(--cc-text)]'
                      : 'border-[var(--cc-border-soft)]'
                  }`}
                  style={{ background: palettes[key].primary }}
                />
              ))}
            </div>
          </SettingsControl>

          <SettingsControl label="Liquid Glass">
            <ToggleSwitch checked={liquidGlass} onChange={setLiquidGlass} />
          </SettingsControl>

          <SettingsControl label="Surface Opacity">
            <div className="flex min-w-40 items-center gap-2">
              <input
                type="range"
                min="25"
                max="100"
                value={surfaceOpacity}
                onChange={(event) => setSurfaceOpacity(Number(event.target.value))}
                className="cc-settings-range"
              />
              <span className="w-9 text-right text-xs text-[var(--cc-dim)]">{surfaceOpacity}%</span>
            </div>
          </SettingsControl>

          <BackgroundControl
            label="Dark Background"
            targetMode="dark"
            hasImage={backgrounds.dark.length > 0}
            onUpload={handleBackgroundUpload}
            onClear={clearBackground}
          />

          <BackgroundControl
            label="Light Background"
            targetMode="light"
            hasImage={backgrounds.light.length > 0}
            onUpload={handleBackgroundUpload}
            onClear={clearBackground}
          />

          <FontUploadControl
            label="English Font"
            target="english"
            onUpload={handleFontUpload}
            onOpenSelect={setFontModalTarget}
          />

          <FontUploadControl
            label="Chinese Font"
            target="chinese"
            onUpload={handleFontUpload}
            onOpenSelect={setFontModalTarget}
          />

          {uploadError && (
            <div className="px-4 py-2 text-xs text-[var(--cc-primary)]">
              {uploadError}
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Cabin">
          <SettingsControl label="Assistant Bubble">
            <ToggleSwitch checked={cabinBubble} onChange={setCabinBubble} />
          </SettingsControl>
          <SettingsControl label="Background Image">
            <ToggleSwitch checked={cabinBackground} onChange={setCabinBackground} />
          </SettingsControl>
          <SettingsControl label="Streaming">
            <ToggleSwitch checked={streamingEnabled} onChange={setStreamingEnabled} />
          </SettingsControl>
        </SettingsSection>

        <SettingsSection title="Nudge">
          <SettingsControl label="Enabled">
            <ToggleSwitch checked={nudgeEnabled} onChange={setNudgeEnabled} />
          </SettingsControl>
          <SettingsAction
            label="Nudge Message"
            value={nudgeMessage}
            onClick={openNudgeModal}
          />
          <SettingsAction
            label="Active Hours"
            value={`${activeStart} - ${activeEnd}`}
            onClick={openHoursModal}
          />
          <SettingsAction
            label="Idle For"
            value={`${intervalValue} ${intervalUnit}`}
            onClick={openIntervalModal}
          />
          <SettingsAction
            label="Notifications"
            value={notificationLabel(notificationStatus)}
            onClick={enableNotifications}
          />
          <SettingsAction
            label="Test Nudge"
            value={nudgeTestStatus || 'Send now'}
            onClick={triggerTestNudge}
          />
        </SettingsSection>

        <SettingsSection title="Evening Diary">
          <SettingsControl label="Enabled">
            <ToggleSwitch checked={diaryEnabled} onChange={setDiaryEnabled} />
          </SettingsControl>
          <SettingsAction
            label="Time"
            value={diaryTime}
            onClick={openDiaryTimeModal}
          />
          <SettingsAction
            label="Prompt"
            value={diaryPrompt}
            onClick={openDiaryPromptModal}
          />
        </SettingsSection>

        <VoiceSettings />

        <SettingsSection title="Data">
          <SettingsControl label="Backup">
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="cc-settings-pill-btn" onClick={handleExportAllData}>
                Export
              </button>
              <input
                id="cc-data-import"
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={handleImportBackup}
              />
              <label htmlFor="cc-data-import" className="cc-settings-pill-btn cursor-pointer">
                Import
              </label>
            </div>
          </SettingsControl>
          <SettingsControl label="Import Mode">
            <div className="grid grid-cols-2 rounded-full bg-[var(--cc-input)] p-1">
              <ModeChoiceButton label="Merge" value="merge" current={backupMode} onChange={setBackupMode} />
              <ModeChoiceButton label="Replace" value="replace" current={backupMode} onChange={setBackupMode} />
            </div>
          </SettingsControl>
          <StorageStatus snapshot={storageSnapshot} onRefresh={refreshStorageSnapshot} />
          {dataStatus && (
            <div className="px-4 py-2 text-xs text-[var(--cc-primary)]">
              {dataStatus}
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Debug">
          <SettingsAction label="Error Logs" value="View" onClick={() => setActiveModal('logs')} />
          <SettingsItem label="WebSocket Status" value={wsConnected ? 'Connected' : 'Disconnected'} />
        </SettingsSection>
      </div>

      {activeModal === 'nudge' && (
        <SettingsModal
          title="Nudge Message"
          onClose={() => setActiveModal(null)}
          footer={(
            <>
              <button type="button" className="cc-modal-secondary-btn" onClick={() => setActiveModal(null)}>
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveNudgeMessage}>
                Save
              </button>
            </>
          )}
        >
          <textarea
            value={nudgeDraft}
            onChange={(event) => setNudgeDraft(event.target.value)}
            className="cc-settings-textarea"
            rows={6}
            placeholder="Write a nudge message..."
            autoFocus
          />
        </SettingsModal>
      )}

      {activeModal === 'logs' && (
        <SettingsModal title="Error Logs" onClose={() => setActiveModal(null)}>
          <div className="cc-settings-log-box">
            {debugLogs.length === 0 ? (
              <p>No WebSocket events logged yet.</p>
            ) : (
              debugLogs
                .slice()
                .reverse()
                .map((entry, index) => (
                  <p key={`${entry.time}-${index}`}>
                    <span className="opacity-60">{formatLogTime(entry.time)}</span>{' '}
                    {entry.text}
                  </p>
                ))
            )}
          </div>
        </SettingsModal>
      )}

      {activeModal === 'hours' && (
        <SettingsModal
          title="Active Hours"
          onClose={() => setActiveModal(null)}
          footer={(
            <>
              <button type="button" className="cc-modal-secondary-btn" onClick={() => setActiveModal(null)}>
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveActiveHours}>
                Save
              </button>
            </>
          )}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="cc-settings-field">
              <span>Start</span>
              <input
                type="time"
                value={activeStartDraft}
                onChange={(event) => setActiveStartDraft(event.target.value)}
              />
            </label>
            <label className="cc-settings-field">
              <span>End</span>
              <input
                type="time"
                value={activeEndDraft}
                onChange={(event) => setActiveEndDraft(event.target.value)}
              />
            </label>
          </div>
        </SettingsModal>
      )}

      {activeModal === 'interval' && (
        <SettingsModal
          title="Nudge Idle Time"
          onClose={() => setActiveModal(null)}
          footer={(
            <>
              <button type="button" className="cc-modal-secondary-btn" onClick={() => setActiveModal(null)}>
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveInterval}>
                Save
              </button>
            </>
          )}
        >
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <label className="cc-settings-field">
              <span>Every</span>
              <input
                type="number"
                min="1"
                inputMode="numeric"
                value={intervalValueDraft}
                onChange={(event) => setIntervalValueDraft(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
            <label className="cc-settings-field min-w-28">
              <span>Unit</span>
              <select
                value={intervalUnitDraft}
                onChange={(event) => setIntervalUnitDraft(event.target.value as NudgeIntervalUnit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </label>
          </div>
        </SettingsModal>
      )}

      {activeModal === 'diaryTime' && (
        <SettingsModal
          title="Diary Time"
          onClose={() => setActiveModal(null)}
          footer={(
            <>
              <button type="button" className="cc-modal-secondary-btn" onClick={() => setActiveModal(null)}>
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveDiaryTime}>
                Save
              </button>
            </>
          )}
        >
          <label className="cc-settings-field">
            <span>Every evening</span>
            <input
              type="time"
              value={diaryTimeDraft}
              onChange={(event) => setDiaryTimeDraft(event.target.value)}
              autoFocus
            />
          </label>
        </SettingsModal>
      )}

      {activeModal === 'diaryPrompt' && (
        <SettingsModal
          title="Diary Prompt"
          onClose={() => setActiveModal(null)}
          footer={(
            <>
              <button type="button" className="cc-modal-secondary-btn" onClick={() => setActiveModal(null)}>
                Cancel
              </button>
              <button type="button" className="cc-modal-primary-btn" onClick={saveDiaryPrompt}>
                Save
              </button>
            </>
          )}
        >
          <textarea
            value={diaryPromptDraft}
            onChange={(event) => setDiaryPromptDraft(event.target.value)}
            className="cc-settings-textarea"
            rows={7}
            placeholder="Write an evening diary prompt..."
            autoFocus
          />
        </SettingsModal>
      )}

      {fontModalTarget && (
        <FontSelectModal
          label={fontModalTarget === 'english' ? 'English Font' : 'Chinese Font'}
          target={fontModalTarget}
          selectedFont={selectedFonts[fontModalTarget]}
          fonts={customFonts[fontModalTarget]}
          onSelect={setSelectedFont}
          onDelete={deleteCustomFont}
          onClose={() => setFontModalTarget(null)}
        />
      )}
    </div>
  )
}

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function notificationLabel(status: NotificationStatus) {
  if (status === 'subscribed') return 'Enabled'
  if (status === 'unconfigured') return 'Needs Keys'
  if (status === 'granted') return 'Tap to subscribe'
  if (status === 'denied') return 'Blocked'
  if (status === 'unsupported') return 'Unsupported'
  return 'Enable'
}

function FontUploadControl({
  label,
  target,
  onUpload,
  onOpenSelect,
}: {
  label: string
  target: FontTarget
  onUpload: (target: FontTarget, event: ChangeEvent<HTMLInputElement>) => void | Promise<void>
  onOpenSelect: (target: FontTarget) => void
}) {
  const inputId = `${target}-font-upload`

  return (
    <SettingsControl label={label}>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <input
          id={inputId}
          type="file"
          accept=".woff,.woff2,.ttf,.otf,.ttc,font/*"
          className="sr-only"
          onChange={(event) => onUpload(target, event)}
        />
        <label htmlFor={inputId} className="cc-settings-pill-btn cursor-pointer">
          Upload
        </label>
        <button type="button" className="cc-settings-pill-btn" onClick={() => onOpenSelect(target)}>
          Select
        </button>
      </div>
    </SettingsControl>
  )
}

function FontSelectModal({
  label,
  target,
  selectedFont,
  fonts,
  onSelect,
  onDelete,
  onClose,
}: {
  label: string
  target: FontTarget
  selectedFont: string
  fonts: CustomFont[]
  onSelect: (target: FontTarget, fontId: string) => void
  onDelete: (target: FontTarget, fontId: string) => void
  onClose: () => void
}) {
  const selectFont = (fontId: string) => {
    onSelect(target, fontId)
    onClose()
  }

  return (
    <SettingsModal title={`Select ${label}`} onClose={onClose}>
      <div className="cc-font-modal-list">
        <button
          type="button"
          onClick={() => selectFont('system')}
          className={`cc-font-modal-row ${selectedFont === 'system' ? 'is-selected' : ''}`}
        >
          <span className="min-w-0 truncate">System</span>
        </button>
        {fonts.map((font, index) => {
          const name = font.name || `Custom ${index + 1}`
          return (
            <div key={font.id} className={`cc-font-modal-row ${selectedFont === font.id ? 'is-selected' : ''}`}>
              <button
                type="button"
                onClick={() => selectFont(font.id)}
                className="min-w-0 flex-1 truncate text-left"
              >
                {name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(target, font.id)}
                aria-label={`Delete ${name}`}
                title="Delete"
                className="cc-font-delete-btn"
              >
                <TrashIcon />
              </button>
            </div>
          )
        })}
      </div>
    </SettingsModal>
  )
}

function StorageStatus({
  snapshot,
  onRefresh,
}: {
  snapshot: StorageSnapshot | null
  onRefresh: () => void
}) {
  const quotaText = snapshot?.quotaBytes
    ? `${formatBytes(snapshot.quotaUsageBytes ?? null)} / ${formatBytes(snapshot.quotaBytes)}`
    : 'Unknown'

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-[var(--cc-text)]">Storage</span>
        <button type="button" className="cc-settings-link-btn" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className="cc-storage-grid">
        <StorageMetric label="LocalStorage" value={formatBytes(snapshot?.localStorageBytes ?? null)} />
        <StorageMetric label="Chats IDB" value={formatBytes(snapshot?.chatBytes ?? null)} />
        <StorageMetric label="Fonts IDB" value={formatBytes(snapshot?.fontBytes ?? null)} />
        <StorageMetric label="Browser" value={quotaText} />
      </div>
    </div>
  )
}

function StorageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="cc-storage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function BackgroundControl({
  label,
  targetMode,
  hasImage,
  onUpload,
  onClear,
}: {
  label: string
  targetMode: ThemeMode
  hasImage: boolean
  onUpload: (mode: ThemeMode, event: ChangeEvent<HTMLInputElement>) => void
  onClear: (mode: ThemeMode) => void
}) {
  const inputId = `${targetMode}-background-upload`

  return (
    <SettingsControl label={label}>
      <div className="flex items-center justify-end gap-2">
        <input
          id={inputId}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => onUpload(targetMode, event)}
        />
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-full bg-[var(--cc-input)] px-3 py-1.5 text-xs font-medium text-[var(--cc-text)] transition-colors hover:text-[var(--cc-primary)]"
        >
          Upload
        </label>
        {hasImage && (
          <button
            type="button"
            onClick={() => onClear(targetMode)}
            className="rounded-full px-3 py-1.5 text-xs text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-text)]"
          >
            Clear
          </button>
        )}
      </div>
    </SettingsControl>
  )
}

function ModeChoiceButton<T extends string>({
  label,
  value,
  current,
  onChange,
}: {
  label: string
  value: T
  current: T
  onChange: (value: T) => void
}) {
  const active = value === current

  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-[var(--cc-primary)] text-white'
          : 'text-[var(--cc-dim)] hover:text-[var(--cc-text)]'
      }`}
    >
      {label}
    </button>
  )
}

function ModeButton({
  label,
  value,
  current,
  onChange,
}: {
  label: string
  value: ThemeMode
  current: ThemeMode
  onChange: (value: ThemeMode) => void
}) {
  const active = value === current

  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-[var(--cc-primary)] text-white'
          : 'text-[var(--cc-dim)] hover:text-[var(--cc-text)]'
      }`}
    >
      {label}
    </button>
  )
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">{title}</h2>
      <div className="cc-card divide-y divide-[var(--cc-border-soft)] overflow-hidden rounded-[16px]">
        {children}
      </div>
    </section>
  )
}

function SettingsControl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-[var(--cc-text)]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function SettingsItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-[var(--cc-text)]">{label}</span>
      <span className="text-sm text-[var(--cc-dim)]">{value}</span>
    </div>
  )
}

function SettingsAction({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[rgba(var(--cc-primary-rgb),0.05)]"
    >
      <span className="shrink-0 text-sm text-[var(--cc-text)]">{label}</span>
      <span className="min-w-0 truncate text-right text-sm text-[var(--cc-dim)]">{value}</span>
    </button>
  )
}

function SettingsModal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  return (
    <div className="cc-settings-modal-root" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="cc-settings-modal-backdrop"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="cc-settings-modal-panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--cc-text)]">{title}</h2>
          <button type="button" className="cc-session-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {children}
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full transition-colors ${
        checked ? 'bg-[var(--cc-primary)]' : 'bg-[var(--cc-input)]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function CloseIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6M14 11v6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l1 13h10l1-13" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7V4h6v3" />
    </svg>
  )
}
