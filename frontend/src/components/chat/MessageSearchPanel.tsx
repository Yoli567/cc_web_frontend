export default function MessageSearchPanel({
  query,
  onQueryChange,
  count,
  current,
  onPrevious,
  onNext,
}: {
  query: string
  onQueryChange: (value: string) => void
  count: number
  current: number
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <div className="cc-message-search-panel cc-fade-in mx-3 mt-2 flex items-center gap-2 rounded-2xl px-3 py-2">
      <SearchIcon />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search messages..."
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--cc-text)] outline-none placeholder:text-[var(--cc-dim)]"
        autoFocus
      />
      <span className="min-w-[2.75rem] text-right text-xs tabular-nums text-[var(--cc-dim)]">
        {query.trim() ? `${count ? current + 1 : 0}/${count}` : '0/0'}
      </span>
      <button type="button" className="cc-message-search-step" onClick={onPrevious} disabled={count === 0}>
        <ArrowUpIcon />
      </button>
      <button type="button" className="cc-message-search-step" onClick={onNext} disabled={count === 0}>
        <ArrowDownIcon />
      </button>
    </div>
  )
}

export function SearchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />
    </svg>
  )
}

function ArrowUpIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 15 6-6 6 6" />
    </svg>
  )
}

function ArrowDownIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  )
}
