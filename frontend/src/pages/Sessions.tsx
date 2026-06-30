import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import { useSessions, type ModelOption } from '@/sessions/SessionsContext'
import type { ChatMode, Session } from '@/types'
import { formatTimestamp } from '@/utils/formatTime'
import UsageDashboard from '@/components/chat/UsageDashboard'

export default function Sessions() {
  const { openSidebar } = useAppLayout()
  const navigate = useNavigate()
  const {
    sessions,
    currentSessionId,
    currentModel,
    modelOptions,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
    setCurrentModel,
    setSessionModel,
    setSessionLastMode,
    addModel,
    updateModel,
    removeModel,
    reorderModels,
  } = useSessions()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [modelEditorOpen, setModelEditorOpen] = useState(false)
  const [draggedModelId, setDraggedModelId] = useState<string | null>(null)
  const [dragOverModelId, setDragOverModelId] = useState<string | null>(null)

  const openInMode = (session: Session, mode: ChatMode) => {
    switchSession(session.id)
    setSessionLastMode(session.id, mode)
    navigate(mode === 'cabin' ? '/cabin' : '/message')
  }

  const handleNewSession = () => {
    const session = createSession()
    setExpandedId(session.id)
  }

  const handleModelDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (!modelEditorOpen) {
      event.preventDefault()
      return
    }
    setDraggedModelId(id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  const handleModelDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (!modelEditorOpen || draggedModelId === id) return
    event.preventDefault()
    setDragOverModelId(id)
  }

  const handleModelDrop = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (!modelEditorOpen) return
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggedModelId
    if (sourceId) reorderModels(sourceId, id)
    setDraggedModelId(null)
    setDragOverModelId(null)
  }

  const handleModelDragEnd = () => {
    setDraggedModelId(null)
    setDragOverModelId(null)
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
        <h1 className="flex-1 text-[15px] font-semibold text-[var(--cc-text)]">Sessions</h1>
        <button
          type="button"
          onClick={handleNewSession}
          aria-label="New session"
          title="New session"
          className="cc-session-new-icon-btn"
        >
          <PlusIcon />
        </button>
      </header>

      <div className="space-y-5 p-4">
        {/* Dashboard */}
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">Dashboard</h2>
          <div className="cc-card overflow-hidden rounded-[14px]">
            <UsageDashboard />
          </div>
        </section>

        {/* Model section */}
        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold uppercase text-[var(--cc-dim)]">Models</h2>
            <button
              type="button"
              onClick={() => setModelEditorOpen((v) => !v)}
              className="text-[10px] text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-primary)]"
            >
              {modelEditorOpen ? 'Done' : 'Manage'}
            </button>
          </div>

          <div className="cc-card divide-y divide-[var(--cc-border-soft)] overflow-hidden rounded-[14px]">
            {modelOptions.map((opt) => {
              const active = opt.id === currentModel
              return (
                <ModelRow
                  key={opt.id}
                  option={opt}
                  active={active}
                  editing={modelEditorOpen}
                  draggable={modelEditorOpen}
                  dragging={draggedModelId === opt.id}
                  dragOver={dragOverModelId === opt.id}
                  onSelect={() => {
                    if (currentSessionId) {
                      setSessionModel(currentSessionId, opt.id)
                    } else {
                      setCurrentModel(opt.id)
                    }
                  }}
                  onUpdate={(patch) => updateModel(opt.id, patch)}
                  onRemove={() => removeModel(opt.id)}
                  onDragStart={(event) => handleModelDragStart(event, opt.id)}
                  onDragOver={(event) => handleModelDragOver(event, opt.id)}
                  onDrop={(event) => handleModelDrop(event, opt.id)}
                  onDragEnd={handleModelDragEnd}
                />
              )
            })}
            {modelEditorOpen && <AddModelRow onAdd={addModel} />}
          </div>
        </section>

        {/* Sessions list */}
        <section>
          <h2 className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase text-[var(--cc-dim)]">
            <span>All sessions</span>
            <span className="flex items-center gap-1.5 normal-case text-[10px] font-normal text-[var(--cc-dim)]">
              {sessions.length} total
            </span>
          </h2>

          <div className="space-y-2">
            {sessions.length === 0 && (
              <div className="cc-card rounded-[14px] p-6 text-center">
                <p className="text-sm text-[var(--cc-dim)]">还没有任何会话</p>
                <p className="mt-1 text-[11px] text-[var(--cc-dim)]">点右上角 + 新建一个</p>
              </div>
            )}

            {sessions.map((session) => {
              const isActive = session.id === currentSessionId
              const isEditing = session.id === editingId
              const isConfirming = session.id === confirmDeleteId
              const isExpanded = session.id === expandedId
              const sessionModel = modelOptions.find((m) => m.id === session.modelId)
              const ctxUsed = session.contextLength ?? 0
              const ctxLimit = session.contextLimit ?? sessionModel?.contextLimit ?? 200_000
              const ctxPct = Math.min(100, (ctxUsed / ctxLimit) * 100)

              return (
                <div
                  key={session.id}
                  className={`cc-session-card rounded-[14px] p-3 transition-colors ${
                    isActive ? 'cc-session-card-active' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => !isEditing && setExpandedId(isExpanded ? null : session.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        {isEditing ? (
                          <input
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                if (editingId) renameSession(editingId, draftName)
                                setEditingId(null)
                                setDraftName('')
                              } else if (e.key === 'Escape') {
                                setEditingId(null)
                                setDraftName('')
                              }
                            }}
                            autoFocus
                            className="cc-session-rename-input flex-1 bg-transparent text-sm font-medium text-[var(--cc-text)] outline-none"
                          />
                        ) : (
                          <span className={`text-sm font-medium ${isActive ? 'text-[var(--cc-primary)]' : 'text-[var(--cc-text)]'}`}>
                            {session.name}
                          </span>
                        )}
                        {isActive && !isEditing && (
                          <span className="cc-session-active-badge ml-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
                            当前
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--cc-dim)]">
                        <span>{formatTimestamp(session.lastMessageAt)}</span>
                        <span className="tabular-nums">
                          {formatTokens(ctxUsed)} / {formatTokens(ctxLimit)}
                        </span>
                      </div>
                      <div className="cc-session-progress mt-1.5">
                        <div
                          className={`cc-session-progress-fill ${ctxPct >= 90 ? 'cc-session-progress-danger' : ctxPct >= 70 ? 'cc-session-progress-warn' : ''}`}
                          style={{ width: `${ctxPct.toFixed(1)}%` }}
                        />
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (editingId) renameSession(editingId, draftName)
                              setEditingId(null)
                              setDraftName('')
                            }}
                            aria-label="Save"
                            className="cc-session-icon-btn"
                          >
                            <CheckIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null)
                              setDraftName('')
                            }}
                            aria-label="Cancel"
                            className="cc-session-icon-btn"
                          >
                            <CloseSmallIcon />
                          </button>
                        </>
                      ) : isConfirming ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              deleteSession(session.id)
                              setConfirmDeleteId(null)
                              if (expandedId === session.id) setExpandedId(null)
                            }}
                            aria-label="Confirm delete"
                            className="cc-session-icon-btn cc-session-icon-danger"
                          >
                            <CheckIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            aria-label="Cancel"
                            className="cc-session-icon-btn"
                          >
                            <CloseSmallIcon />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(session.id)
                              setDraftName(session.name)
                            }}
                            aria-label="Rename"
                            title="Rename"
                            className="cc-session-icon-btn"
                          >
                            <EditPenIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(session.id)}
                            aria-label="Delete"
                            title="Delete"
                            className="cc-session-icon-btn"
                          >
                            <TrashIcon />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="cc-fade-in mt-2.5 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => openInMode(session, 'message')}
                        className="cc-session-mode-btn flex items-center gap-1.5 rounded-[12px] px-3 py-2.5 text-left"
                      >
                        <MessageIcon />
                        <span className="text-sm text-[var(--cc-text)]">Message</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openInMode(session, 'cabin')}
                        className="cc-session-mode-btn flex items-center gap-1.5 rounded-[12px] px-3 py-2.5 text-left"
                      >
                        <CabinIcon />
                        <span className="text-sm text-[var(--cc-text)]">Cabin</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function ModelRow({
  option,
  active,
  editing,
  draggable,
  dragging,
  dragOver,
  onSelect,
  onUpdate,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  option: ModelOption
  active: boolean
  editing: boolean
  draggable: boolean
  dragging: boolean
  dragOver: boolean
  onSelect: () => void
  onUpdate: (patch: Partial<Omit<ModelOption, 'id'>>) => void
  onRemove: () => void
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const [editingLabel, setEditingLabel] = useState(false)
  const [draftLabel, setDraftLabel] = useState(option.label)
  const [draftLimit, setDraftLimit] = useState(String(option.contextLimit))

  const handleSave = () => {
    onUpdate({
      label: draftLabel.trim() || option.label,
      contextLimit: Number.isFinite(Number(draftLimit)) && Number(draftLimit) > 0
        ? Number(draftLimit)
        : option.contextLimit,
    })
    setEditingLabel(false)
  }

  if (editingLabel) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Model label"
            className="cc-model-input text-sm text-[var(--cc-text)] outline-none"
            autoFocus
          />
          <input
            value={draftLimit}
            onChange={(e) => setDraftLimit(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="Context limit (tokens)"
            className="cc-model-input text-[12px] text-[var(--cc-sub)] outline-none"
            inputMode="numeric"
          />
        </div>
        <button type="button" onClick={handleSave} className="cc-session-icon-btn">
          <CheckIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            setDraftLabel(option.label)
            setDraftLimit(String(option.contextLimit))
            setEditingLabel(false)
          }}
          className="cc-session-icon-btn"
        >
          <CloseSmallIcon />
        </button>
      </div>
    )
  }

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`cc-model-row flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors ${
        active ? 'cc-model-row-active' : ''
      } ${dragging ? 'cc-model-row-dragging' : ''} ${dragOver ? 'cc-model-row-drag-over' : ''}`}
    >
      {editing && (
        <span className="cc-model-drag-handle" aria-hidden="true">
          <DragHandleIcon />
        </span>
      )}

      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className={`truncate text-sm ${active ? 'text-[var(--cc-primary)] font-medium' : 'text-[var(--cc-text)]'}`}>
          {option.label}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--cc-dim)]">
          {formatTokens(option.contextLimit)}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {active && !editing && <span className="text-[var(--cc-primary)]"><CheckIcon /></span>}
        {editing && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setEditingLabel(true)
              }}
              className="cc-session-icon-btn"
              aria-label="Edit model"
            >
              <EditPenIcon />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
              className="cc-session-icon-btn"
              aria-label="Remove model"
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function AddModelRow({ onAdd }: { onAdd: (model: { id: string; label: string; contextLimit: number }) => void }) {
  const [label, setLabel] = useState('')
  const [limit, setLimit] = useState('200000')

  const handleAdd = () => {
    if (!label.trim()) return
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const limitNum = Number(limit)
    onAdd({
      id,
      label: label.trim(),
      contextLimit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 200_000,
    })
    setLabel('')
    setLimit('200000')
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Model label (e.g. Claude Opus 5)"
          className="cc-model-input text-sm text-[var(--cc-text)] outline-none placeholder:text-[var(--cc-dim)]"
        />
        <input
          value={limit}
          onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Context limit (tokens)"
          inputMode="numeric"
          className="cc-model-input text-[12px] text-[var(--cc-sub)] outline-none placeholder:text-[var(--cc-dim)]"
        />
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={!label.trim()}
        className="cc-session-icon-btn"
        aria-label="Add model"
      >
        <PlusIcon />
      </button>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function CloseSmallIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function EditPenIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19 16 8l3 3L8 22H5v-3ZM14 10l3 3" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    </svg>
  )
}

function MessageIcon() {
  return (
    <svg className="h-4 w-4 text-[var(--cc-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.7 9.7 0 0 1-3.5-.62l-4.3 1.3 1.3-4.3A8.5 8.5 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z" />
    </svg>
  )
}

function CabinIcon() {
  return (
    <svg className="h-4 w-4 text-[var(--cc-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
    </svg>
  )
}

function DragHandleIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
    </svg>
  )
}
