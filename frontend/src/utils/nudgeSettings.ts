export const NUDGE_ENABLED_KEY = 'cc-nudge-enabled'
export const NUDGE_MESSAGE_KEY = 'cc-nudge-message'
export const NUDGE_ACTIVE_START_KEY = 'cc-nudge-active-start'
export const NUDGE_ACTIVE_END_KEY = 'cc-nudge-active-end'
export const NUDGE_INTERVAL_VALUE_KEY = 'cc-nudge-interval-value'
export const NUDGE_INTERVAL_UNIT_KEY = 'cc-nudge-interval-unit'
export const NUDGE_LAST_FIRED_KEY = 'cc-nudge-last-fired-at'
export const NUDGE_LAST_INTERACTION_KEY = 'cc-nudge-last-interaction-at'
export const NUDGE_RUNTIME_LAST_SEEN_KEY = 'cc-nudge-runtime-last-seen-at'
export const NUDGE_SETTINGS_CHANGED_EVENT = 'cc-nudge-settings-changed'

export type NudgeIntervalUnit = 'minutes' | 'hours'

export const DEFAULT_NUDGE_MESSAGE = '想起你了。要不要一起把现在的想法整理一下？'

export interface NudgeSettings {
  enabled: boolean
  message: string
  activeStart: string
  activeEnd: string
  intervalValue: number
  intervalUnit: NudgeIntervalUnit
}

export function loadNudgeSettings(): NudgeSettings {
  return {
    enabled: localStorage.getItem(NUDGE_ENABLED_KEY) !== 'false',
    message: localStorage.getItem(NUDGE_MESSAGE_KEY) ?? DEFAULT_NUDGE_MESSAGE,
    activeStart: localStorage.getItem(NUDGE_ACTIVE_START_KEY) ?? '09:00',
    activeEnd: localStorage.getItem(NUDGE_ACTIVE_END_KEY) ?? '23:00',
    intervalValue: Math.max(1, Number(localStorage.getItem(NUDGE_INTERVAL_VALUE_KEY) || '2') || 2),
    intervalUnit: (localStorage.getItem(NUDGE_INTERVAL_UNIT_KEY) as NudgeIntervalUnit | null) ?? 'hours',
  }
}

export function dispatchNudgeSettingsChanged() {
  window.dispatchEvent(new CustomEvent(NUDGE_SETTINGS_CHANGED_EVENT))
}

export function nudgeIntervalMs(settings: NudgeSettings) {
  const multiplier = settings.intervalUnit === 'minutes' ? 60_000 : 3_600_000
  return Math.max(1, settings.intervalValue) * multiplier
}

export function markNudgeInteraction(timestamp = Date.now()) {
  localStorage.setItem(NUDGE_LAST_INTERACTION_KEY, String(timestamp))
}

export function syncNudgeSettingsToBackend(sessionId: string | null = null) {
  const settings = loadNudgeSettings()
  return fetch('/api/nudge/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: settings.enabled,
      message: settings.message,
      active_start: settings.activeStart,
      active_end: settings.activeEnd,
      interval_value: settings.intervalValue,
      interval_unit: settings.intervalUnit,
      session_id: sessionId,
    }),
    credentials: 'include',
  })
}

export function isWithinNudgeHours(now: Date, start: string, end: string) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = timeToMinutes(start)
  const endMinutes = timeToMinutes(end)
  if (startMinutes === endMinutes) return true
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes
}

function timeToMinutes(value: string) {
  const [hourRaw, minuteRaw] = value.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return Math.min(23, Math.max(0, hour)) * 60 + Math.min(59, Math.max(0, minute))
}
