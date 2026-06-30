import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import { useSessions } from '@/sessions/SessionsContext'
import {
  loadSavedMessages,
  savedPreview,
  savedReply,
  savedText,
  savedThinking,
  updateSavedMessageTitle,
  type SavedMessage,
} from '@/utils/savedMessages'
import { formatTimestamp } from '@/utils/formatTime'
import MarkdownContent from '@/components/chat/MarkdownContent'

const MESSAGE_PREVIEW_LIMIT = 6

export default function Saved() {
  const { openSidebar } = useAppLayout()
  const { switchSession } = useSessions()
  const navigate = useNavigate()
  const [saved, setSaved] = useState(loadSavedMessages)
  const [query, setQuery] = useState('')
  const [showAllMessages, setShowAllMessages] = useState(false)
  const [expandedCabinIds, setExpandedCabinIds] = useState<Set<string>>(new Set())
  const [editingCabinId, setEditingCabinId] = useState<string | null>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const sorted = useMemo(
    () => saved.slice().sort((a, b) => b.timestamp - a.timestamp),
    [saved],
  )
  const messageItems = sorted.filter((item) => item.mode === 'message')
  const cabinItems = sorted.filter((item) => item.mode === 'cabin')
  const searchResults = normalizedQuery
    ? sorted.filter((item) =>
        `${savedText(item)} ${item.title ?? ''}`.toLowerCase().includes(normalizedQuery),
      )
    : []

  const jumpToSaved = (item: SavedMessage) => {
    if (item.sessionId) switchSession(item.sessionId)
    navigate(`/${item.mode}?focus=${encodeURIComponent(item.messageId)}`)
  }

  const toggleCabin = (id: string) => {
    setExpandedCabinIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveTitle = (id: string, title: string) => {
    setSaved(updateSavedMessageTitle(id, title))
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
        <h1 className="flex-1 text-[15px] font-semibold text-[var(--cc-text)]">Saved</h1>
      </header>

      <div className="space-y-5 p-4">
        <div className="cc-saved-search-card cc-card rounded-[14px] px-3 py-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search saved messages..."
            className="w-full bg-transparent text-sm text-[var(--cc-text)] outline-none placeholder:text-[var(--cc-dim)]"
          />
        </div>

        {normalizedQuery ? (
          <section>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">
              Results · {searchResults.length}
            </h2>
            <div className="cc-card divide-y divide-[var(--cc-border-soft)] overflow-hidden rounded-[14px]">
              {searchResults.length === 0 && (
                <p className="px-4 py-5 text-sm text-[var(--cc-dim)]">No saved messages found.</p>
              )}
              {searchResults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => jumpToSaved(item)}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[rgba(var(--cc-primary-rgb),0.05)]"
                >
                  <span className="mt-0.5 rounded-full bg-[rgba(var(--cc-primary-rgb),0.12)] px-2 py-0.5 text-[10px] uppercase text-[var(--cc-primary)]">
                    {item.mode}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--cc-text)]">
                      {item.title || savedPreview(item, 80)}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-[var(--cc-dim)]">
                      {savedPreview(item, 180)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--cc-dim)]">{formatTimestamp(item.timestamp)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">Messages</h2>
              <div className="grid grid-cols-2 gap-2">
                {(showAllMessages ? messageItems : messageItems.slice(0, MESSAGE_PREVIEW_LIMIT)).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => jumpToSaved(item)}
                    className="cc-saved-message-card cc-card flex min-h-28 flex-col rounded-[12px] p-3 text-left"
                  >
                    <p className="line-clamp-4 text-sm leading-relaxed text-[var(--cc-text)]">{savedPreview(item, 180)}</p>
                    <p className="cc-saved-message-time mt-auto pt-2 text-right text-[10px] text-[var(--cc-dim)]">{formatTimestamp(item.timestamp)}</p>
                  </button>
                ))}
              </div>
              {messageItems.length > MESSAGE_PREVIEW_LIMIT && !showAllMessages && (
                <button
                  type="button"
                  onClick={() => setShowAllMessages(true)}
                  className="cc-load-all-btn mt-2 w-full rounded-[12px] px-3 py-2 text-xs font-medium text-[var(--cc-dim)]"
                >
                  Load all
                </button>
              )}
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">Cabin</h2>
              <div className="space-y-2">
                {cabinItems.map((item) => {
                  const expanded = expandedCabinIds.has(item.id)
                  const thinking = savedThinking(item)
                  const reply = savedReply(item) || savedText(item)
                  return (
                    <article key={item.id} className="cc-card overflow-hidden rounded-[12px]">
                      <div
                        className="flex cursor-pointer items-center gap-2 px-3 py-2.5"
                        onClick={() => toggleCabin(item.id)}
                      >
                        <div className="min-w-0 flex-1 text-left">
                          {editingCabinId === item.id ? (
                            <input
                              value={item.title || ''}
                              placeholder="Untitled cabin note"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => saveTitle(item.id, event.target.value)}
                              onBlur={() => setEditingCabinId(null)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur()
                                }
                              }}
                              className="w-full bg-transparent text-sm font-medium text-[var(--cc-text)] outline-none"
                              autoFocus
                            />
                          ) : (
                            <p className="truncate text-sm font-medium text-[var(--cc-text)]">
                              {item.title || 'Untitled cabin note'}
                            </p>
                          )}
                          <span className="mt-0.5 block text-[10px] text-[var(--cc-dim)]">{formatTimestamp(item.timestamp)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setEditingCabinId(item.id)
                          }}
                          aria-label="Edit saved cabin title"
                          className="cc-session-icon-btn"
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            jumpToSaved(item)
                          }}
                          aria-label="Open saved cabin message"
                          className="cc-session-icon-btn"
                        >
                          <JumpIcon />
                        </button>
                      </div>
                      {expanded && (
                        <div className="border-t border-[var(--cc-border-soft)]">
                          {thinking && (
                            <div className="cc-saved-thinking border-b border-[var(--cc-border-soft)] px-3 py-3">
                              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cc-dim)]">Thinking</p>
                              <MarkdownContent text={thinking} />
                            </div>
                          )}
                          {reply && (
                            <div className="px-3 py-3">
                              {thinking && (
                                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cc-primary)]">Reply</p>
                              )}
                              <MarkdownContent text={reply} />
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function JumpIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m14 6 4 4" />
    </svg>
  )
}
