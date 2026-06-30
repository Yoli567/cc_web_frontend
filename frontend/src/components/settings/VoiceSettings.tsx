import { useEffect, useState, type ReactNode } from 'react'

interface VoiceSettingsData {
  stt_enabled: boolean
  stt_base_url: string
  stt_model: string
  stt_language: string
  stt_api_key_set: boolean
  tts_enabled: boolean
  tts_base_url: string
  tts_group_id: string
  tts_model: string
  tts_voice_id: string
  tts_speed: number
  tts_api_key_set: boolean
}

const DEFAULTS: VoiceSettingsData = {
  stt_enabled: false,
  stt_base_url: 'https://api.siliconflow.cn/v1',
  stt_model: 'FunAudioLLM/SenseVoiceSmall',
  stt_language: 'zh',
  stt_api_key_set: false,
  tts_enabled: false,
  tts_base_url: 'https://api.minimaxi.com',
  tts_group_id: '',
  tts_model: 'speech-02-hd',
  tts_voice_id: '',
  tts_speed: 1.0,
  tts_api_key_set: false,
}

type OpenModal = 'stt' | 'tts' | null

export default function VoiceSettings() {
  const [data, setData] = useState<VoiceSettingsData | null>(null)
  const [open, setOpen] = useState<OpenModal>(null)
  const [draft, setDraft] = useState<VoiceSettingsData | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [speedDraft, setSpeedDraft] = useState('1')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const resp = await fetch('/api/voice/settings', { credentials: 'include' })
        const body = resp.ok ? ((await resp.json()) as { settings?: Partial<VoiceSettingsData> }) : {}
        setData({ ...DEFAULTS, ...(body.settings ?? {}) })
      } catch {
        setData({ ...DEFAULTS })
      }
    })()
  }, [])

  const openModal = (which: Exclude<OpenModal, null>) => {
    if (!data) return
    setDraft({ ...data })
    setKeyDraft('')
    setSpeedDraft(String(data.tts_speed))
    setStatus('')
    setOpen(which)
  }

  const closeModal = () => {
    setOpen(null)
    setDraft(null)
    setKeyDraft('')
  }

  const patchDraft = (patch: Partial<VoiceSettingsData>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!draft || !open) return
    setSaving(true)
    setStatus('')
    const payload: Record<string, unknown> = {
      stt_enabled: draft.stt_enabled,
      stt_base_url: draft.stt_base_url,
      stt_model: draft.stt_model,
      stt_language: draft.stt_language,
      tts_enabled: draft.tts_enabled,
      tts_base_url: draft.tts_base_url,
      tts_group_id: draft.tts_group_id,
      tts_model: draft.tts_model,
      tts_voice_id: draft.tts_voice_id,
      tts_speed: (() => {
        const parsed = parseFloat(speedDraft)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : draft.tts_speed
      })(),
    }
    if (keyDraft.trim()) {
      payload[open === 'stt' ? 'stt_api_key' : 'tts_api_key'] = keyDraft.trim()
    }
    try {
      const resp = await fetch('/api/voice/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const body = (await resp.json()) as { settings?: Partial<VoiceSettingsData> }
      setData({ ...DEFAULTS, ...(body.settings ?? {}) })
      closeModal()
    } catch {
      setStatus('保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!data) return null

  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">Voice</h2>
      <div className="cc-card divide-y divide-[var(--cc-border-soft)] overflow-hidden rounded-[16px]">
        <Action label="语音转文字 STT" value={data.stt_enabled ? '已开启' : '已关闭'} onClick={() => openModal('stt')} />
        <Action label="文字转语音 TTS" value={data.tts_enabled ? '已开启' : '已关闭'} onClick={() => openModal('tts')} />
      </div>

      {open === 'stt' && draft && (
        <Modal title="语音转文字 STT" onClose={closeModal} status={status} saving={saving} onSave={save}>
          <ToggleRow label="启用" checked={draft.stt_enabled} onChange={(v) => patchDraft({ stt_enabled: v })} />
          <Field label="Base URL" value={draft.stt_base_url} onChange={(v) => patchDraft({ stt_base_url: v })} placeholder="https://api.siliconflow.cn/v1" />
          <Field
            label="API Key"
            type="password"
            value={keyDraft}
            onChange={setKeyDraft}
            placeholder={draft.stt_api_key_set ? '已设置（留空不变）' : '未设置'}
          />
          <Field label="Model" value={draft.stt_model} onChange={(v) => patchDraft({ stt_model: v })} placeholder="FunAudioLLM/SenseVoiceSmall" />
          <Field label="语言" value={draft.stt_language} onChange={(v) => patchDraft({ stt_language: v })} placeholder="zh" />
          <p className="px-1 pt-1 text-[11px] leading-[1.5] text-[var(--cc-dim)]">
            默认硅基流动 <code>FunAudioLLM/SenseVoiceSmall</code>（免费）。也支持 OpenRouter（<code>https://openrouter.ai/api/v1</code> + <code>openai/whisper-1</code>）或任意 OpenAI 兼容服务。
          </p>
        </Modal>
      )}

      {open === 'tts' && draft && (
        <Modal title="文字转语音 TTS · MiniMax" onClose={closeModal} status={status} saving={saving} onSave={save}>
          <ToggleRow label="启用" checked={draft.tts_enabled} onChange={(v) => patchDraft({ tts_enabled: v })} />
          <Field label="Base URL" value={draft.tts_base_url} onChange={(v) => patchDraft({ tts_base_url: v })} placeholder="https://api.minimax.io" />
          <Field
            label="API Key"
            type="password"
            value={keyDraft}
            onChange={setKeyDraft}
            placeholder={draft.tts_api_key_set ? '已设置（留空不变）' : '未设置'}
          />
          <Field label="Group ID" value={draft.tts_group_id} onChange={(v) => patchDraft({ tts_group_id: v })} placeholder="MiniMax GroupId" />
          <Field label="Model" value={draft.tts_model} onChange={(v) => patchDraft({ tts_model: v })} placeholder="speech-02-hd" />
          <Field label="Voice ID" value={draft.tts_voice_id} onChange={(v) => patchDraft({ tts_voice_id: v })} placeholder="如 male-qn-qingse" />
          <Field label="语速 Speed" type="number" value={speedDraft} onChange={setSpeedDraft} placeholder="1.0（0.5–2）" />
        </Modal>
      )}
    </section>
  )
}

function Action({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
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

function Modal({
  title,
  children,
  onClose,
  onSave,
  saving,
  status,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  onSave: () => void
  saving: boolean
  status: string
}) {
  return (
    <div className="cc-settings-modal-root" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="cc-settings-modal-backdrop" aria-label="Close" onClick={onClose} />
      <div className="cc-settings-modal-panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--cc-text)]">{title}</h2>
          <button type="button" className="cc-session-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        <div className="mt-4 flex items-center justify-end gap-2">
          {status && <span className="mr-auto text-xs text-[var(--cc-primary)]">{status}</span>}
          <button type="button" className="cc-modal-secondary-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="cc-modal-primary-btn" onClick={onSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[var(--cc-text)]">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-[var(--cc-primary)]' : 'bg-[var(--cc-input)]'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="cc-settings-field">
      <span>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function CloseIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
