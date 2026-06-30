import { useState } from 'react'
import { useSessions } from '@/sessions/SessionsContext'

/**
 * Collapsible status board for session usage and limits.
 * Shows usage limits, current session, context length and current model.
 */
export default function UsageDashboard() {
  const {
    currentSession,
    currentModelOption,
    usage,
    compactSession,
    refreshUsage,
    usageRefreshing,
  } = useSessions()
  const [open, setOpen] = useState(false)

  const ctxUsed = currentSession?.contextLength ?? 0
  const ctxLimit = currentSession?.contextLimit ?? currentModelOption.contextLimit
  const ctxPct = ctxLimit > 0 ? Math.min(100, (ctxUsed / ctxLimit) * 100) : 0

  const fivePct = usage.fiveHourLimit > 0
    ? Math.min(100, (usage.fiveHourUsed / usage.fiveHourLimit) * 100)
    : 0
  const weeklyPct = usage.weeklyLimit > 0
    ? Math.min(100, (usage.weeklyUsed / usage.weeklyLimit) * 100)
    : 0

  return (
    <div className="cc-usage-dashboard">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cc-usage-toggle flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">
          <span className="cc-usage-pill cc-usage-pill-session truncate">
            {currentSession?.name ?? 'No session'}
          </span>
          <span className="cc-usage-pill cc-usage-pill-context shrink-0">
            {formatTokens(ctxUsed)} / {formatTokens(ctxLimit)}
          </span>
          <span className="cc-usage-pill cc-usage-pill-model shrink-0 truncate">
            {currentModelOption.label}
          </span>
        </div>
        <span className={`shrink-0 text-[var(--cc-dim)] transition-transform ${open ? 'rotate-180' : ''}`}>
          <ChevronDownIcon />
        </span>
      </button>

      {open && (
        <div className="cc-usage-panel space-y-2 px-3 py-2.5">
          <UsageBar
            label="Context"
            pct={ctxPct}
            value={`${formatTokens(ctxUsed)} / ${formatTokens(ctxLimit)}`}
            action={
              currentSession ? (
                <button
                  type="button"
                  onClick={() => compactSession(currentSession.id)}
                  className="cc-usage-action"
                  title="Compact this session"
                >
                  <CompactIcon /> Compact
                </button>
              ) : null
            }
          />
          <UsageBar
            label="5h limit"
            pct={fivePct}
            value={formatPercent(fivePct)}
            sub={`resets ${formatRelativeTime(usage.fiveHourResetsAt)}`}
          />
          <UsageBar
            label="Weekly limit"
            pct={weeklyPct}
            value={formatPercent(weeklyPct)}
            sub={`resets ${formatRelativeTime(usage.weeklyResetsAt)}`}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={refreshUsage}
              disabled={usageRefreshing}
              className="cc-usage-refresh"
              aria-label="Refresh usage"
              title="Refresh usage"
            >
              <RefreshIcon spinning={usageRefreshing} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function UsageBar({
  label,
  pct,
  value,
  sub,
  action,
}: {
  label: string
  pct: number
  value: string
  sub?: string
  action?: React.ReactNode
}) {
  const danger = pct >= 90
  const warn = pct >= 70 && !danger
  const barTone = danger ? 'cc-usage-bar-danger' : warn ? 'cc-usage-bar-warn' : 'cc-usage-bar-ok'

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-[var(--cc-sub)]">{label}</span>
        <div className="flex items-center gap-2 text-[var(--cc-dim)]">
          <span className="tabular-nums">{value}</span>
          {action}
        </div>
      </div>
      <div className="cc-usage-bar">
        <div className={`cc-usage-bar-fill ${barTone}`} style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      {sub && <p className="mt-1 text-[10px] text-[var(--cc-dim)]">{sub}</p>}
    </div>
  )
}

function formatPercent(n: number): string {
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function formatRelativeTime(ts: number): string {
  const diffMs = ts - Date.now()
  if (diffMs < 0) return 'soon'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

function ChevronDownIcon() {
  return (
    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 ${spinning ? 'cc-spin' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 1 0-2.34 5.66M20 11V5m0 6h-6" />
    </svg>
  )
}

function CompactIcon() {
  return (
    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16M9 4v4M15 16v4" />
    </svg>
  )
}
