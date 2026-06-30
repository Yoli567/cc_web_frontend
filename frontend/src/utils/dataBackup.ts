import type { ChatMessage } from '@/types'
import {
  clearChatThreads,
  clearLegacyChatStorage,
  getChatStorageBytes,
  isLegacyChatStorageKey,
  listChatThreads,
  restoreChatThread,
  type StoredChatThread,
} from '@/utils/chatStorage'

export type BackupImportMode = 'merge' | 'replace'

export interface StorageSnapshot {
  localStorageBytes: number
  chatBytes: number
  settingsBytes: number
  fontBytes: number
  quotaUsageBytes: number | null
  quotaBytes: number | null
}

type ChatBackupEntry = {
  sessionId: string | null
  mode: 'message' | 'cabin'
  storageKey: string
  jsonl: string
  count: number
}

type FontAssetBackup = {
  key: string
  type: string
  size: number
  dataUrl: string
}

type DataBackupPayload = {
  app: 'cc-web-frontend'
  version: 1
  exportedAt: string
  settings: {
    localStorage: Record<string, string>
  }
  chats: ChatBackupEntry[]
  assets: {
    fonts: FontAssetBackup[]
  }
}

const FONT_DB_NAME = 'cc-font-assets'
const FONT_STORE_NAME = 'fonts'

const STRUCTURED_ARRAY_KEYS = new Set([
  'cc-sessions',
  'cc-model-options',
  'cc-custom-models',
  'cc-userstyles',
  'cc-custom-fonts-en',
  'cc-custom-fonts-zh',
  'cc-saved-messages',
  'cc-activity-entries',
])

export async function exportAllData() {
  const backup: DataBackupPayload = {
    app: 'cc-web-frontend',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      localStorage: collectSettingsStorage(),
    },
    chats: await collectChatBackups(),
    assets: {
      fonts: await collectFontAssets(),
    },
  }

  downloadJson(`cc-web-backup-${new Date().toISOString().slice(0, 10)}.json`, backup)
}

export async function importAllData(file: File, mode: BackupImportMode) {
  const backup = validateBackup(JSON.parse(await file.text()) as Partial<DataBackupPayload>)
  if (mode === 'replace') {
    clearManagedLocalStorage()
    await clearChatThreads()
    await clearFontAssets()
  }

  restoreSettingsStorage(backup.settings.localStorage, mode)
  await restoreChatBackups(backup.chats, mode)
  await restoreFontAssets(backup.assets.fonts)
  clearLegacyChatStorage()
}

export async function getStorageSnapshot(): Promise<StorageSnapshot> {
  const chatBytes = await getChatStorageBytes()
  const localStorageBytes = managedLocalStorageKeys().reduce(
    (total, key) =>
      isLegacyChatStorageKey(key)
        ? total
        : total + byteLength(key) + byteLength(localStorage.getItem(key) ?? ''),
    0,
  )
  const fontBytes = await getFontAssetBytes()
  const estimate = await readStorageEstimate()
  return {
    localStorageBytes,
    chatBytes,
    settingsBytes: Math.max(0, localStorageBytes - chatBytes),
    fontBytes,
    quotaUsageBytes: typeof estimate?.usage === 'number' ? estimate.usage : null,
    quotaBytes: typeof estimate?.quota === 'number' ? estimate.quota : null,
  }
}

export function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`
}

function collectSettingsStorage() {
  const values: Record<string, string> = {}
  managedLocalStorageKeys().forEach((key) => {
    if (isLegacyChatStorageKey(key)) return
    values[key] = localStorage.getItem(key) ?? ''
  })
  return values
}

async function collectChatBackups(): Promise<ChatBackupEntry[]> {
  const threads = await listChatThreads()
  return threads
    .map((thread) => ({
      storageKey: thread.storageKey,
      sessionId: thread.sessionId,
      mode: thread.mode,
      jsonl: thread.messages.map((message) => JSON.stringify(message)).join('\n'),
      count: thread.messages.length,
    }))
    .filter((entry) => entry.count > 0)
}

function restoreSettingsStorage(values: Record<string, string>, mode: BackupImportMode) {
  const entries = Object.entries(values).filter(([key]) => isManagedLocalStorageKey(key) && !isLegacyChatStorageKey(key))
  entries.forEach(([key, value]) => {
    if (mode === 'replace') {
      localStorage.setItem(key, value)
      return
    }
    if (STRUCTURED_ARRAY_KEYS.has(key)) {
      localStorage.setItem(key, JSON.stringify(mergeArrayStorage(localStorage.getItem(key), value)))
      return
    }
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, value)
    }
  })
}

async function restoreChatBackups(chats: ChatBackupEntry[], mode: BackupImportMode) {
  const currentThreads = mode === 'merge' ? await listChatThreads() : []
  const currentByKey = new Map(currentThreads.map((thread) => [thread.storageKey, thread]))
  await Promise.all(chats.map((entry) => {
    if (!isLegacyChatStorageKey(entry.storageKey)) return Promise.resolve()
    const imported = parseJsonlMessages(entry.jsonl)
    if (imported.length === 0) return Promise.resolve()
    const existing = currentByKey.get(entry.storageKey)
    const thread: StoredChatThread = {
      storageKey: entry.storageKey,
      sessionId: entry.sessionId,
      mode: entry.mode,
      messages: mode === 'replace' ? imported : mergeMessages(existing?.messages ?? [], imported),
      updatedAt: Date.now(),
    }
    return restoreChatThread(thread)
  }))
}

function mergeArrayStorage(currentRaw: string | null, incomingRaw: string) {
  const current = parseArrayWithIds(currentRaw)
  const incoming = parseArrayWithIds(incomingRaw)
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !seen.has(item.id))]
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const seen = new Set(current.map(messageIdentity))
  return [...current, ...incoming.filter((message) => !seen.has(messageIdentity(message)))]
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
}

function messageIdentity(message: ChatMessage) {
  return message.id || `${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`
}

function parseArrayWithIds(raw: string | null) {
  try {
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is { id: string } & Record<string, unknown> =>
          item && typeof item === 'object' && typeof item.id === 'string',
        )
      : []
  } catch {
    return []
  }
}

function parseJsonlMessages(jsonl: string): ChatMessage[] {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ChatMessage
      } catch {
        return null
      }
    })
    .filter((message): message is ChatMessage =>
      Boolean(message && typeof message === 'object' && Array.isArray(message.content)),
    )
}

async function collectFontAssets(): Promise<FontAssetBackup[]> {
  const db = await openFontDb().catch(() => null)
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readonly')
    const store = tx.objectStore(FONT_STORE_NAME)
    const request = store.getAllKeys()
    const assets: FontAssetBackup[] = []

    request.onsuccess = () => {
      const keys = request.result.map(String)
      if (keys.length === 0) {
        resolve([])
        return
      }
      let remaining = keys.length
      keys.forEach((key) => {
        const blobRequest = store.get(key)
        blobRequest.onsuccess = () => {
          const blob = blobRequest.result as Blob | undefined
          if (blob) {
            void blobToDataUrl(blob).then((dataUrl) => {
              assets.push({ key, type: blob.type, size: blob.size, dataUrl })
              remaining -= 1
              if (remaining === 0) resolve(assets)
            }).catch(() => {
              remaining -= 1
              if (remaining === 0) resolve(assets)
            })
          } else {
            remaining -= 1
            if (remaining === 0) resolve(assets)
          }
        }
        blobRequest.onerror = () => {
          remaining -= 1
          if (remaining === 0) resolve(assets)
        }
      })
    }
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

async function restoreFontAssets(fonts: FontAssetBackup[]) {
  if (fonts.length === 0) return
  const db = await openFontDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readwrite')
    const store = tx.objectStore(FONT_STORE_NAME)
    fonts.forEach((font) => {
      if (!font.key || !font.dataUrl) return
      store.put(dataUrlToBlob(font.dataUrl), font.key)
    })
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

async function clearFontAssets() {
  const db = await openFontDb().catch(() => null)
  if (!db) return
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readwrite')
    tx.objectStore(FONT_STORE_NAME).clear()
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

async function getFontAssetBytes() {
  const assets = await collectFontAssets()
  return assets.reduce((total, asset) => total + asset.size, 0)
}

function openFontDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FONT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FONT_STORE_NAME)) {
        request.result.createObjectStore(FONT_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function managedLocalStorageKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key && isManagedLocalStorageKey(key)))
}

function isManagedLocalStorageKey(key: string) {
  return key.startsWith('cc-') && !key.startsWith('cc-ws-')
}

function clearManagedLocalStorage() {
  managedLocalStorageKeys().forEach((key) => localStorage.removeItem(key))
}

function validateBackup(payload: Partial<DataBackupPayload>): DataBackupPayload {
  if (payload.app !== 'cc-web-frontend' || payload.version !== 1) {
    throw new Error('This backup file is not compatible.')
  }
  return {
    app: 'cc-web-frontend',
    version: 1,
    exportedAt: payload.exportedAt ?? new Date().toISOString(),
    settings: {
      localStorage: payload.settings?.localStorage ?? {},
    },
    chats: Array.isArray(payload.chats) ? payload.chats : [],
    assets: {
      fonts: Array.isArray(payload.assets?.fonts) ? payload.assets.fonts : [],
    },
  }
}

async function readStorageEstimate() {
  try {
    return await navigator.storage?.estimate?.()
  } catch {
    return null
  }
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string) {
  const [meta, data] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'application/octet-stream'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mime })
}
