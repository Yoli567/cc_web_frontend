import type { ChatMessage, ChatMode } from '@/types'

export const CHAT_DB_NAME = 'cc-chat-history'
export const CHAT_STORE_NAME = 'threads'

const CHAT_BASE_KEYS: Record<ChatMode, string> = {
  message: 'cc-live-messages',
  cabin: 'cc-live-cabin-messages',
}

const MIGRATION_KEYS: Record<ChatMode, string> = {
  message: 'cc-live-messages-session-migrated',
  cabin: 'cc-live-cabin-messages-session-migrated',
}

export interface StoredChatThread {
  storageKey: string
  mode: ChatMode
  sessionId: string | null
  messages: ChatMessage[]
  updatedAt: number
}

export function chatStorageKey(mode: ChatMode, sessionId: string | null) {
  return `${CHAT_BASE_KEYS[mode]}:${sessionId || 'default'}`
}

export async function loadChatMessages(mode: ChatMode, sessionId: string | null) {
  const storageKey = chatStorageKey(mode, sessionId)
  const existing = await readChatThread(storageKey)
  if (existing.length > 0) return existing
  const legacy = await migrateLegacyChatThread(mode, sessionId)
  return legacy.length > 0 ? legacy : existing
}

export async function saveChatMessages(mode: ChatMode, sessionId: string | null, messages: ChatMessage[]) {
  const storageKey = chatStorageKey(mode, sessionId)
  await writeChatThread({
    storageKey,
    mode,
    sessionId,
    messages,
    updatedAt: Date.now(),
  })
}

const appendQueues = new Map<string, Promise<unknown>>()

// Serialized read-modify-write so concurrent appends (e.g. two nudge messages
// arriving in the same tick) can't each load the same base array and clobber
// one another. Returns true if the message was newly stored.
export async function appendChatMessage(mode: ChatMode, sessionId: string | null, message: ChatMessage) {
  const key = chatStorageKey(mode, sessionId)
  const run = (appendQueues.get(key) ?? Promise.resolve()).then(async () => {
    const stored = await loadChatMessages(mode, sessionId)
    if (stored.some((existing) => existing.id === message.id)) return false
    await saveChatMessages(mode, sessionId, [...stored, message])
    return true
  })
  appendQueues.set(key, run.catch(() => {}))
  return run
}

export async function deleteChatMessages(sessionId: string) {
  await Promise.all([
    deleteChatThread(chatStorageKey('message', sessionId)),
    deleteChatThread(chatStorageKey('cabin', sessionId)),
  ])
}

export async function listChatThreads() {
  await migrateAllLegacyChatThreads()
  const db = await openChatDb().catch(() => null)
  if (!db) return []
  return new Promise<StoredChatThread[]>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE_NAME, 'readonly')
    const request = tx.objectStore(CHAT_STORE_NAME).getAll()
    request.onsuccess = () => {
      resolve((request.result as StoredChatThread[]).filter((thread) => Array.isArray(thread.messages)))
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

export async function restoreChatThread(thread: StoredChatThread) {
  await writeChatThread(thread)
}

export async function clearChatThreads() {
  const db = await openChatDb().catch(() => null)
  if (!db) return
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE_NAME, 'readwrite')
    tx.objectStore(CHAT_STORE_NAME).clear()
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

export async function getChatStorageBytes() {
  const threads = await listChatThreads()
  return threads.reduce((total, thread) => total + byteLength(thread.storageKey) + byteLength(JSON.stringify(thread)), 0)
}

export function isLegacyChatStorageKey(key: string) {
  return Object.values(CHAT_BASE_KEYS).some((baseKey) => key === baseKey || key.startsWith(`${baseKey}:`))
}

export function clearLegacyChatStorage() {
  legacyChatStorageKeys().forEach((key) => localStorage.removeItem(key))
  Object.values(MIGRATION_KEYS).forEach((key) => localStorage.removeItem(key))
}

async function migrateAllLegacyChatThreads() {
  const keys = legacyChatStorageKeys().sort((a, b) => Number(!a.includes(':')) - Number(!b.includes(':')))
  for (const key of keys) {
    const mode = modeFromStorageKey(key)
    if (!mode) continue
    const sessionId = sessionIdFromStorageKey(key)
    await migrateLegacyChatThread(mode, sessionId)
  }
}

async function migrateLegacyChatThread(mode: ChatMode, sessionId: string | null) {
  const storageKey = chatStorageKey(mode, sessionId)
  const existing = await readChatThread(storageKey)
  if (existing.length > 0) {
    if (sessionId === null) localStorage.removeItem(CHAT_BASE_KEYS[mode])
    return existing
  }
  const scopedMessages = parseMessages(localStorage.getItem(storageKey))
  if (scopedMessages.length > 0) {
    await saveChatMessages(mode, sessionId, scopedMessages)
    localStorage.removeItem(storageKey)
    return scopedMessages
  }

  const migrationKey = MIGRATION_KEYS[mode]
  const baseKey = CHAT_BASE_KEYS[mode]
  const hasMigratedLegacy = localStorage.getItem(migrationKey)
  const legacyMessages = parseMessages(localStorage.getItem(baseKey))
  if (legacyMessages.length > 0 && (!hasMigratedLegacy || sessionId === null)) {
    await saveChatMessages(mode, sessionId, legacyMessages)
    if (!hasMigratedLegacy) localStorage.setItem(migrationKey, storageKey)
    localStorage.removeItem(baseKey)
    return legacyMessages
  }

  return []
}

async function readChatThread(storageKey: string) {
  const db = await openChatDb().catch(() => null)
  if (!db) return []
  return new Promise<ChatMessage[]>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE_NAME, 'readonly')
    const request = tx.objectStore(CHAT_STORE_NAME).get(storageKey)
    request.onsuccess = () => {
      const thread = request.result as StoredChatThread | undefined
      resolve(Array.isArray(thread?.messages) ? thread.messages : [])
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

async function writeChatThread(thread: StoredChatThread) {
  const db = await openChatDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE_NAME, 'readwrite')
    tx.objectStore(CHAT_STORE_NAME).put(thread, thread.storageKey)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

async function deleteChatThread(storageKey: string) {
  const db = await openChatDb().catch(() => null)
  if (!db) return
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE_NAME, 'readwrite')
    tx.objectStore(CHAT_STORE_NAME).delete(storageKey)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

function openChatDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(CHAT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CHAT_STORE_NAME)) {
        request.result.createObjectStore(CHAT_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function legacyChatStorageKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key && isLegacyChatStorageKey(key)))
}

function modeFromStorageKey(key: string): ChatMode | null {
  if (key === CHAT_BASE_KEYS.message || key.startsWith(`${CHAT_BASE_KEYS.message}:`)) return 'message'
  if (key === CHAT_BASE_KEYS.cabin || key.startsWith(`${CHAT_BASE_KEYS.cabin}:`)) return 'cabin'
  return null
}

function sessionIdFromStorageKey(key: string) {
  const parts = key.split(':')
  return parts.length > 1 ? parts.slice(1).join(':') : null
}

function parseMessages(raw: string | null): ChatMessage[] {
  try {
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed as ChatMessage[] : []
  } catch {
    return []
  }
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}
