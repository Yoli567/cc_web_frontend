export function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const now = new Date()

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (msgDay.getTime() === today.getTime()) {
    return time
  }

  if (msgDay.getTime() === yesterday.getTime()) {
    return `Yesterday ${time}`
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()} ${time}`
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`
}
