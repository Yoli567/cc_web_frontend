import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import MarkdownContent from '@/components/chat/MarkdownContent'
import { useSessions } from '@/sessions/SessionsContext'
import type { ActivityEntry, ActivityReplyRecord, ActivityToolRecord } from '@/types'
import {
  ACTIVITY_CHANGED_EVENT,
  activityDateKey,
  loadActivityEntries,
} from '@/utils/activityStorage'
import { formatTimestamp } from '@/utils/formatTime'

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function Activity() {
  const { openSidebar } = useAppLayout()
  const { switchSession } = useSessions()
  const navigate = useNavigate()
  const [todayKey] = useState(() => activityDateKey(Date.now()))
  const [entries, setEntries] = useState(loadActivityEntries)
  const [selectedDate, setSelectedDate] = useState(todayKey)
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(parseDateKey(todayKey)))
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const refresh = () => setEntries(loadActivityEntries())
    window.addEventListener(ACTIVITY_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(ACTIVITY_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const cells = useMemo(() => buildMonthCells(viewMonth), [viewMonth])
  const monthLabel = useMemo(
    () => viewMonth.toLocaleDateString([], { month: 'long', year: 'numeric' }),
    [viewMonth],
  )
  const activeDates = useMemo(() => new Set(entries.map((entry) => entry.dateKey)), [entries])
  const selectedEntries = entries
    .filter((entry) => entry.dateKey === selectedDate)
    .sort((a, b) => b.timestamp - a.timestamp)

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openInMessage = (entry: ActivityEntry) => {
    if (entry.sessionId) switchSession(entry.sessionId)
    navigate(`/message?focus=${encodeURIComponent(entry.turnId)}`)
  }

  return (
    <div className="cc-page h-full overflow-y-auto">
      <header className="cc-header flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open navigation"
          title="Navigation"
          className="cc-header-nav-button"
        >
          <SidebarOpenIcon />
        </button>
        <h1 className="flex-1 text-[15px] font-semibold text-[var(--cc-text)]">Activity</h1>
      </header>

      <div className="space-y-4 p-4">
        <section className="cc-activity-calendar cc-card rounded-[14px] p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <button
              type="button"
              onClick={() => setViewMonth((month) => addMonths(month, -1))}
              className="cc-activity-month-nav"
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="text-sm font-semibold text-[var(--cc-text)]">{monthLabel}</span>
            <button
              type="button"
              onClick={() => setViewMonth((month) => addMonths(month, 1))}
              className="cc-activity-month-nav"
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={index} className="text-center text-[10px] font-medium uppercase text-[var(--cc-dim)]">
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, index) => {
              if (!cell) return <span key={`blank-${index}`} />
              const active = cell.key === selectedDate
              const isToday = cell.key === todayKey
              const hasActivity = activeDates.has(cell.key)
              return (
                <button
                  key={cell.key}
                  type="button"
                  onClick={() => {
                    setSelectedDate(cell.key)
                    setExpandedIds(new Set())
                  }}
                  className={`cc-activity-day ${active ? 'is-active' : ''} ${isToday ? 'is-today' : ''}`}
                  aria-label={cell.label}
                >
                  <span className="text-sm font-medium">{cell.dayNumber}</span>
                  <span className={`cc-activity-dot ${hasActivity ? 'is-visible' : ''}`} />
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">
            {formatDateHeading(selectedDate)}
          </h2>
          <div className="space-y-2">
            {selectedEntries.length === 0 && (
              <div className="cc-card rounded-[12px] px-4 py-5 text-sm text-[var(--cc-dim)]">
                No activity.
              </div>
            )}
            {selectedEntries.map((entry) => {
              const expanded = expandedIds.has(entry.id)
              const moments = activityMoments(entry)
              return (
                <article key={entry.id} className="cc-card overflow-hidden rounded-[12px]">
                  <div
                    className="flex cursor-pointer items-center gap-2 px-3 py-2.5"
                    onClick={() => toggleExpanded(entry.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--cc-text)]">
                        {activitySourceLabel(entry.source)} · {entry.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--cc-dim)]">{activityPreview(entry)}</p>
                    </div>
                    <span className="text-[12px] text-[var(--cc-dim)]">{expanded ? '▾' : '▸'}</span>
                  </div>
                  {expanded && (
                    <div className="divide-y divide-[var(--cc-border-soft)] border-t border-[var(--cc-border-soft)]">
                      {moments.length > 0 && (
                        <div className="space-y-3 px-3 py-3">
                          {moments.map((moment, index) => (
                            <ActivityMoment key={`${entry.id}-moment-${index}`} moment={moment} />
                          ))}
                        </div>
                      )}
                      {moments.length === 0 && (
                        <div className="px-3 py-3 text-sm text-[var(--cc-dim)]">Waiting for activity...</div>
                      )}
                      <div className="px-3 py-2.5">
                        <button type="button" className="cc-settings-link-btn" onClick={() => openInMessage(entry)}>
                          Open in Message
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

type ActivityMoment =
  | { thinking?: string; event: { kind: 'reply'; reply: ActivityReplyRecord; timestamp: number } }
  | { thinking?: string; event: { kind: 'tool'; tool: ActivityToolRecord; timestamp: number } }
  | { thinking: string; event?: null }

function ActivityMoment({ moment }: { moment: ActivityMoment }) {
  return (
    <div className="space-y-2">
      {moment.thinking && (
        <div className="rounded-[10px] border border-[var(--cc-border-soft)] bg-[rgba(var(--cc-primary-rgb),0.05)] px-3 py-2 text-sm text-[var(--cc-sub)]">
          <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--cc-dim)]">Thinking</p>
          <MarkdownContent text={moment.thinking} />
        </div>
      )}
      {moment.event?.kind === 'reply' && (
        <div className="space-y-1.5 px-1">
          <p className="text-[10px] font-semibold uppercase text-[var(--cc-primary)]">
            Reply · {formatTimestamp(moment.event.reply.timestamp)}
          </p>
          <MarkdownContent text={moment.event.reply.text} />
        </div>
      )}
      {moment.event?.kind === 'tool' && <ToolRecord tool={moment.event.tool} />}
    </div>
  )
}

function ToolRecord({ tool }: { tool: ActivityToolRecord }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12px] text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-sub)]"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="font-mono">{tool.name}</span>
        <span>{formatTimestamp(tool.timestamp)}</span>
      </button>
      {open && (
        <div className="cc-tool-use-panel mt-1.5 max-h-56 overflow-y-auto p-3 font-mono text-xs text-[var(--cc-sub)]">
          <pre className="whitespace-pre-wrap">{JSON.stringify(tool.input, null, 2)}</pre>
          {tool.result && <pre className="mt-2 whitespace-pre-wrap opacity-75">{tool.result}</pre>}
        </div>
      )}
    </div>
  )
}

type DayCell = {
  key: string
  label: string
  dayNumber: string
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

function buildMonthCells(month: Date): (DayCell | null)[] {
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const leadingBlanks = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const cells: (DayCell | null)[] = Array.from({ length: leadingBlanks }, () => null)
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, monthIndex, day)
    cells.push({
      key: activityDateKey(date.getTime()),
      label: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      dayNumber: String(day),
    })
  }
  return cells
}

function activityPreview(entry: ActivityEntry) {
  const thinking = entry.thinking.find((item) => item.trim())
  if (thinking) return firstSentence(thinking)
  const reply = entry.replies.find((item) => item.text.trim())
  if (reply) return firstSentence(reply.text)
  const tool = entry.tools.find((item) => item.name.trim())
  if (tool) return tool.name
  return 'Waiting for activity...'
}

function activityMoments(entry: ActivityEntry): ActivityMoment[] {
  const events = [
    ...entry.replies.map((reply) => ({ kind: 'reply' as const, reply, timestamp: reply.timestamp })),
    ...entry.tools.map((tool) => ({ kind: 'tool' as const, tool, timestamp: tool.timestamp })),
  ].sort((a, b) => a.timestamp - b.timestamp)

  const moments: ActivityMoment[] = []
  let thinkingIndex = 0
  events.forEach((event) => {
    const thinking = entry.thinking[thinkingIndex]?.trim()
    if (thinking) thinkingIndex += 1
    moments.push({ thinking: thinking || undefined, event })
  })
  for (; thinkingIndex < entry.thinking.length; thinkingIndex += 1) {
    const thinking = entry.thinking[thinkingIndex]?.trim()
    if (thinking) moments.push({ thinking })
  }
  return moments
}

function activitySourceLabel(source: ActivityEntry['source']) {
  if (source === 'self_alarm') return 'Self Wake'
  if (source === 'diary') return 'Diary'
  return 'Nudge'
}

function firstLine(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text.trim()
}

function firstSentence(text: string) {
  const line = firstLine(text)
  const match = line.match(/^(.+?[。！？.!?])(?:\s|$)/)
  return match?.[1]?.trim() || line
}

function parseDateKey(key: string) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function formatDateHeading(key: string) {
  const date = parseDateKey(key)
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}
