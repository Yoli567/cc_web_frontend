/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatMode, Session } from '@/types'
import { deleteChatMessages } from '@/utils/chatStorage'

const SESSIONS_KEY = 'cc-sessions'
const CURRENT_SESSION_KEY = 'cc-current-session'
const CURRENT_MODEL_KEY = 'cc-current-model'
const MODELS_KEY = 'cc-model-options'
const LEGACY_CUSTOM_MODELS_KEY = 'cc-custom-models'
// Dev: 直连本地后端 8000。Prod: 同源相对路径，nginx 反代到后端
const API_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:8000`
  : ''

export interface ModelOption {
  id: string
  label: string
  /** Maximum context window for this model, in tokens. */
  contextLimit: number
  /** Set when this model was added by the user. */
  custom?: boolean
}

export const BUILTIN_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', contextLimit: 500_000 },
  { id: 'claude-sonnet-4-7', label: 'Claude Sonnet 4.7', contextLimit: 200_000 },
  { id: 'claude-haiku-4-7', label: 'Claude Haiku 4.7', contextLimit: 200_000 },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', contextLimit: 500_000 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextLimit: 200_000 },
]

export interface UsageSnapshot {
  fiveHourUsed: number
  fiveHourLimit: number
  fiveHourResetsAt: number
  weeklyUsed: number
  weeklyLimit: number
  weeklyResetsAt: number
}

interface SessionsContextValue {
  sessions: Session[]
  currentSessionId: string | null
  currentSession: Session | null
  currentModel: string
  modelOptions: ModelOption[]
  currentModelOption: ModelOption
  usage: UsageSnapshot
  usageRefreshing: boolean
  createSession: (initialMode?: ChatMode, name?: string) => Session
  switchSession: (id: string) => void
  renameSession: (id: string, name: string) => void
  deleteSession: (id: string) => void
  setCurrentModel: (modelId: string) => void
  setSessionModel: (sessionId: string, modelId: string) => void
  setSessionLastMode: (sessionId: string, mode: ChatMode) => void
  touchSession: (id: string, patch?: Partial<Pick<Session, 'lastMessageAt' | 'contextLength'>>) => void
  compactSession: (id: string) => void
  refreshUsage: () => Promise<void>
  addModel: (model: Omit<ModelOption, 'custom'>) => void
  updateModel: (id: string, patch: Partial<Omit<ModelOption, 'id'>>) => void
  removeModel: (id: string) => void
  reorderModels: (draggedId: string, targetId: string) => void
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

const defaultSeed = (): Session[] => [
  {
    id: 'session-default-message',
    name: '日常碎碎念',
    lastMode: 'message',
    modelId: 'claude-sonnet-4-7',
    createdAt: Date.now() - 86400000 * 2,
    lastMessageAt: Date.now() - 3100000,
    contextLength: 142_000,
    contextLimit: 200_000,
  },
  {
    id: 'session-default-cabin',
    name: '雨天的沙发',
    lastMode: 'cabin',
    modelId: 'claude-opus-4-7',
    createdAt: Date.now() - 86400000 * 3,
    lastMessageAt: Date.now() - 7100000,
    contextLength: 89_400,
    contextLimit: 500_000,
  },
]

const loadFromStorage = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed as T
  } catch {
    return fallback
  }
}

const loadSessions = (): Session[] => {
  const stored = loadFromStorage<Session[] | null>(SESSIONS_KEY, null)
  if (!stored || !Array.isArray(stored)) return defaultSeed()
  // Backfill new fields for sessions persisted under the old schema.
  return stored.map((s) => ({
    contextLimit: 200_000,
    ...s,
  }))
}

const loadModelOptions = (): ModelOption[] => {
  const stored = loadFromStorage<ModelOption[] | null>(MODELS_KEY, null)
  if (stored && Array.isArray(stored) && stored.length > 0) {
    return stored.map((m) => ({
      ...m,
      contextLimit: Number.isFinite(Number(m.contextLimit)) && Number(m.contextLimit) > 0
        ? Number(m.contextLimit)
        : 200_000,
    }))
  }

  const legacyCustomModels = loadFromStorage<ModelOption[] | null>(LEGACY_CUSTOM_MODELS_KEY, null)
  if (legacyCustomModels && Array.isArray(legacyCustomModels) && legacyCustomModels.length > 0) {
    return [...BUILTIN_MODELS, ...legacyCustomModels.map((m) => ({ ...m, custom: true }))]
  }

  return BUILTIN_MODELS
}

const loadCurrentSessionId = (sessions: Session[]): string | null => {
  const stored = localStorage.getItem(CURRENT_SESSION_KEY)
  if (stored && sessions.some((s) => s.id === stored)) return stored
  return sessions[0]?.id ?? null
}

const loadCurrentModel = (allModels: ModelOption[]): string => {
  const stored = localStorage.getItem(CURRENT_MODEL_KEY)
  if (stored && allModels.some((m) => m.id === stored)) return stored
  return allModels[0]?.id ?? BUILTIN_MODELS[0].id
}

const generateId = () => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const friendlyDefaultName = (): string => {
  const stamp = new Date()
  const mm = String(stamp.getMonth() + 1).padStart(2, '0')
  const dd = String(stamp.getDate()).padStart(2, '0')
  const hh = String(stamp.getHours()).padStart(2, '0')
  const min = String(stamp.getMinutes()).padStart(2, '0')
  return `Session · ${mm}/${dd} ${hh}:${min}`
}

const mockUsage = (): UsageSnapshot => ({
  fiveHourUsed: 38_500,
  fiveHourLimit: 100_000,
  fiveHourResetsAt: Date.now() + 1000 * 60 * 60 * 2.5,
  weeklyUsed: 720_000,
  weeklyLimit: 2_400_000,
  weeklyResetsAt: Date.now() + 1000 * 60 * 60 * 24 * 4,
})

const normalizeUsageSnapshot = (raw: Partial<UsageSnapshot> & Record<string, unknown>): UsageSnapshot => ({
  fiveHourUsed: Number(raw.fiveHourUsed ?? raw.five_hour_used ?? 0),
  fiveHourLimit: Number(raw.fiveHourLimit ?? raw.five_hour_limit ?? 100),
  fiveHourResetsAt: Number(raw.fiveHourResetsAt ?? raw.five_hour_resets_at ?? Date.now()),
  weeklyUsed: Number(raw.weeklyUsed ?? raw.weekly_used ?? 0),
  weeklyLimit: Number(raw.weeklyLimit ?? raw.weekly_limit ?? 100),
  weeklyResetsAt: Number(raw.weeklyResetsAt ?? raw.weekly_resets_at ?? Date.now()),
})

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>(loadSessions)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(loadModelOptions)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() =>
    loadCurrentSessionId(loadSessions()),
  )
  const [currentModel, setCurrentModelState] = useState<string>(() =>
    loadCurrentModel(loadModelOptions()),
  )
  const [usage, setUsage] = useState<UsageSnapshot>(mockUsage)
  const [usageRefreshing, setUsageRefreshing] = useState(false)

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
  }, [sessions])

  useEffect(() => {
    localStorage.setItem(MODELS_KEY, JSON.stringify(modelOptions))
  }, [modelOptions])

  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem(CURRENT_SESSION_KEY, currentSessionId)
    } else {
      localStorage.removeItem(CURRENT_SESSION_KEY)
    }
  }, [currentSessionId])

  useEffect(() => {
    localStorage.setItem(CURRENT_MODEL_KEY, currentModel)
  }, [currentModel])

  const createSession = useCallback(
    (initialMode?: ChatMode, name?: string): Session => {
      const activeModel =
        modelOptions.find((m) => m.id === currentModel) ?? modelOptions[0] ?? BUILTIN_MODELS[0]
      const session: Session = {
        id: generateId(),
        name: name?.trim() || friendlyDefaultName(),
        lastMode: initialMode,
        modelId: activeModel.id,
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        contextLength: 0,
        contextLimit: activeModel.contextLimit,
      }
      setSessions((current) => [session, ...current])
      setCurrentSessionId(session.id)
      return session
    },
    [currentModel, modelOptions],
  )

  const switchSession = useCallback((id: string) => {
    setCurrentSessionId(id)
  }, [])

  const renameSession = useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSessions((current) =>
      current.map((s) => (s.id === id ? { ...s, name: trimmed } : s)),
    )
  }, [])

  const deleteSession = useCallback((id: string) => {
    void deleteChatMessages(id)
    localStorage.removeItem(`cc-live-messages:${id}`)
    localStorage.removeItem(`cc-live-cabin-messages:${id}`)
    setSessions((current) => {
      const next = current.filter((s) => s.id !== id)
      if (currentSessionId === id) {
        setCurrentSessionId(next[0]?.id ?? null)
      }
      return next
    })
  }, [currentSessionId])

  const setCurrentModel = useCallback((modelId: string) => {
    setCurrentModelState((current) =>
      modelOptions.some((m) => m.id === modelId) ? modelId : current,
    )
  }, [modelOptions])

  const setSessionModel = useCallback(
    (sessionId: string, modelId: string) => {
      const model = modelOptions.find((m) => m.id === modelId)
      setSessions((current) =>
        current.map((s) =>
          s.id === sessionId
            ? { ...s, modelId, contextLimit: model?.contextLimit ?? s.contextLimit }
            : s,
        ),
      )
      if (sessionId === currentSessionId) setCurrentModelState(modelId)
    },
    [currentSessionId, modelOptions],
  )

  const setSessionLastMode = useCallback((sessionId: string, mode: ChatMode) => {
    setSessions((current) =>
      current.map((s) => (s.id === sessionId ? { ...s, lastMode: mode } : s)),
    )
  }, [])

  const touchSession = useCallback(
    (id: string, patch?: Partial<Pick<Session, 'lastMessageAt' | 'contextLength'>>) => {
      setSessions((current) =>
        current.map((s) =>
          s.id === id ? { ...s, lastMessageAt: Date.now(), ...patch } : s,
        ),
      )
    },
    [],
  )

  const compactSession = useCallback((id: string) => {
    setSessions((current) =>
      current.map((s) => {
        if (s.id !== id) return s
        const compactedLength = Math.round((s.contextLength ?? 0) * 0.28)
        return { ...s, contextLength: compactedLength, lastMessageAt: Date.now() }
      }),
    )
  }, [])

  const refreshUsage = useCallback(async () => {
    setUsageRefreshing(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/usage`)
      if (!response.ok) throw new Error(`Usage request failed: ${response.status}`)
      const data = await response.json()
      setUsage(normalizeUsageSnapshot(data))
    } catch {
      setUsage(mockUsage())
    } finally {
      setUsageRefreshing(false)
    }
  }, [])

  const addModel = useCallback((model: Omit<ModelOption, 'custom'>) => {
    setModelOptions((current) => [...current, { ...model, custom: true }])
  }, [])

  const updateModel = useCallback((id: string, patch: Partial<Omit<ModelOption, 'id'>>) => {
    setModelOptions((current) =>
      current.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
    if (patch.contextLimit) {
      setSessions((current) =>
        current.map((s) =>
          s.modelId === id ? { ...s, contextLimit: patch.contextLimit } : s,
        ),
      )
    }
  }, [])

  const removeModel = useCallback((id: string) => {
    setModelOptions((current) => {
      if (current.length <= 1) return current
      const next = current.filter((m) => m.id !== id)
      if (next.length === current.length) return current
      const fallback = next[0]
      setSessions((sessionsNow) =>
        sessionsNow.map((s) =>
          s.modelId === id
            ? { ...s, modelId: fallback.id, contextLimit: fallback.contextLimit }
            : s,
        ),
      )
      setCurrentModelState((currentModelId) => (currentModelId === id ? fallback.id : currentModelId))
      return next
    })
  }, [])

  const reorderModels = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    setModelOptions((current) => {
      const from = current.findIndex((m) => m.id === draggedId)
      const to = current.findIndex((m) => m.id === targetId)
      if (from < 0 || to < 0) return current
      const next = [...current]
      const [dragged] = next.splice(from, 1)
      next.splice(to, 0, dragged)
      return next
    })
  }, [])

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )

  const currentModelOption = useMemo(
    () =>
      modelOptions.find((m) => m.id === currentModel) ??
      modelOptions[0] ??
      BUILTIN_MODELS[0],
    [modelOptions, currentModel],
  )

  const value = useMemo(
    () => ({
      sessions,
      currentSessionId,
      currentSession,
      currentModel,
      modelOptions,
      currentModelOption,
      usage,
      usageRefreshing,
      createSession,
      switchSession,
      renameSession,
      deleteSession,
      setCurrentModel,
      setSessionModel,
      setSessionLastMode,
      touchSession,
      compactSession,
      refreshUsage,
      addModel,
      updateModel,
      removeModel,
      reorderModels,
    }),
    [
      sessions,
      currentSessionId,
      currentSession,
      currentModel,
      modelOptions,
      currentModelOption,
      usage,
      usageRefreshing,
      createSession,
      switchSession,
      renameSession,
      deleteSession,
      setCurrentModel,
      setSessionModel,
      setSessionLastMode,
      touchSession,
      compactSession,
      refreshUsage,
      addModel,
      updateModel,
      removeModel,
      reorderModels,
    ],
  )

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessions() {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used inside SessionsProvider')
  return ctx
}
