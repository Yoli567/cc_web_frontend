export const DIARY_ENABLED_KEY = 'cc-diary-enabled'
export const DIARY_TIME_KEY = 'cc-diary-time'
export const DIARY_PROMPT_KEY = 'cc-diary-prompt'
export const DIARY_SETTINGS_CHANGED_EVENT = 'cc-diary-settings-changed'

export const DEFAULT_DIARY_PROMPT = '晚上好。请温柔地提醒我写今天的晚间日记，陪我回想今天发生了什么、我感受到了什么、有什么想感谢或放下，以及明天可以轻轻期待什么。'

export interface DiarySettings {
  enabled: boolean
  time: string
  prompt: string
}

export function loadDiarySettings(): DiarySettings {
  return {
    enabled: localStorage.getItem(DIARY_ENABLED_KEY) !== 'false',
    time: localStorage.getItem(DIARY_TIME_KEY) ?? '22:30',
    prompt: localStorage.getItem(DIARY_PROMPT_KEY) ?? DEFAULT_DIARY_PROMPT,
  }
}

export function dispatchDiarySettingsChanged() {
  window.dispatchEvent(new CustomEvent(DIARY_SETTINGS_CHANGED_EVENT))
}

export function syncDiarySettingsToBackend(sessionId: string | null = null) {
  const settings = loadDiarySettings()
  return fetch('/api/diary/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: settings.enabled,
      time: settings.time,
      prompt: settings.prompt,
      session_id: sessionId,
    }),
    credentials: 'include',
  })
}
