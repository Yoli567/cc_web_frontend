import type { ActivityEntry, ActivityToolRecord } from '@/types'

const ACTIVITY_STORAGE_KEY = 'cc-activity-entries'
const MAX_ACTIVITY_ENTRIES = 500

export const ACTIVITY_CHANGED_EVENT = 'cc-activity-changed'

export function activityDateKey(timestamp: number) {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function loadActivityEntries(): ActivityEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || '[]') as ActivityEntry[]
    return Array.isArray(parsed) ? parsed.filter(isActivityEntry).sort((a, b) => b.timestamp - a.timestamp) : []
  } catch {
    return []
  }
}

export function saveActivityEntries(entries: ActivityEntry[]) {
  const compact = entries
    .filter(isActivityEntry)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_ACTIVITY_ENTRIES)
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(compact))
  window.dispatchEvent(new CustomEvent(ACTIVITY_CHANGED_EVENT))
  return compact
}

export function upsertActivityEntry(entry: ActivityEntry) {
  const entries = loadActivityEntries()
  const index = entries.findIndex((item) => item.id === entry.id || item.turnId === entry.turnId)
  const next = index >= 0
    ? entries.map((item, itemIndex) => (itemIndex === index ? { ...item, ...entry } : item))
    : [entry, ...entries]
  return saveActivityEntries(next)
}

export function updateActivityEntry(turnId: string, updater: (entry: ActivityEntry) => ActivityEntry) {
  const entries = loadActivityEntries()
  const index = entries.findIndex((item) => item.turnId === turnId)
  if (index < 0) return entries
  const next = entries.map((item, itemIndex) => (itemIndex === index ? updater(item) : item))
  return saveActivityEntries(next)
}

export function appendActivityThinking(turnId: string, thinking: string) {
  const value = thinking.trim()
  if (!value) return loadActivityEntries()
  return updateActivityEntry(turnId, (entry) =>
    entry.thinking.includes(value)
      ? entry
      : { ...entry, thinking: [...entry.thinking, value] },
  )
}

export function appendActivityReply(turnId: string, reply: { id: string; text: string; timestamp: number }) {
  const value = reply.text.trim()
  if (!value) return loadActivityEntries()
  return updateActivityEntry(turnId, (entry) =>
    entry.replies.some((item) => item.id === reply.id)
      ? entry
      : { ...entry, replies: [...entry.replies, { ...reply, text: value }] },
  )
}

export function appendActivityTool(turnId: string, tool: ActivityToolRecord) {
  return updateActivityEntry(turnId, (entry) =>
    entry.tools.some((item) => item.id === tool.id)
      ? entry
      : { ...entry, tools: [...entry.tools, tool] },
  )
}

export function appendActivityToolResult(turnId: string, toolUseId: string, content: string, timestamp: number) {
  return updateActivityEntry(turnId, (entry) => ({
    ...entry,
    tools: entry.tools.map((tool) =>
      tool.id === toolUseId
        ? { ...tool, result: content, resultTimestamp: timestamp }
        : tool,
    ),
  }))
}

export function markActivityComplete(turnId: string, completedAt: number) {
  return updateActivityEntry(turnId, (entry) => ({ ...entry, completedAt }))
}

export function activityTitle(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!value || typeof value !== 'object') return false
  const raw = value as ActivityEntry
  return (
    typeof raw.id === 'string' &&
    typeof raw.turnId === 'string' &&
    typeof raw.timestamp === 'number' &&
    typeof raw.dateKey === 'string' &&
    typeof raw.title === 'string' &&
    typeof raw.prompt === 'string' &&
    Array.isArray(raw.thinking) &&
    Array.isArray(raw.replies) &&
    Array.isArray(raw.tools)
  )
}
