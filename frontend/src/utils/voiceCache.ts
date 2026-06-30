export const VOICE_DB_NAME = 'cc-voice-cache'
export const VOICE_STORE_NAME = 'voices'
export const VOICE_MAX_AGE_DAYS = 3

/** Stable cache key for an audio block: messageId + its index within the message. */
export function voiceCacheKey(messageId: string, index = 0) {
  return `${messageId}:${index}`
}

interface VoiceCacheRecord {
  key: string
  blob: Blob
  createdAt: number
  saved: boolean
}

function openVoiceDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(VOICE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VOICE_STORE_NAME)) {
        request.result.createObjectStore(VOICE_STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readRecord(key: string) {
  return openVoiceDb()
    .then(
      (db) =>
        new Promise<VoiceCacheRecord | null>((resolve, reject) => {
          const tx = db.transaction(VOICE_STORE_NAME, 'readonly')
          const request = tx.objectStore(VOICE_STORE_NAME).get(key)
          request.onsuccess = () => resolve((request.result as VoiceCacheRecord) ?? null)
          request.onerror = () => reject(request.error)
          tx.oncomplete = () => db.close()
          tx.onerror = () => db.close()
        }),
    )
    .catch(() => null)
}

function writeRecord(record: VoiceCacheRecord) {
  return openVoiceDb()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(VOICE_STORE_NAME, 'readwrite')
          tx.objectStore(VOICE_STORE_NAME).put(record)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error)
          }
        }),
    )
    .catch(() => {})
}

/** Store a voice blob. Preserves the existing `saved` flag if the key already exists. */
export async function putVoice(key: string, blob: Blob) {
  if (!key) return
  const existing = await readRecord(key)
  await writeRecord({
    key,
    blob,
    createdAt: existing?.createdAt ?? Date.now(),
    saved: existing?.saved ?? false,
  })
}

export async function getVoiceBlob(key: string): Promise<Blob | null> {
  if (!key) return null
  const record = await readRecord(key)
  return record?.blob ?? null
}

export async function markVoiceSaved(key: string, saved: boolean) {
  if (!key) return
  const existing = await readRecord(key)
  if (!existing) return
  await writeRecord({ ...existing, saved })
}

/** Remove unsaved voices older than maxAgeDays. Saved voices are kept forever. */
export async function cleanupExpiredVoices(maxAgeDays = VOICE_MAX_AGE_DAYS) {
  const db = await openVoiceDb().catch(() => null)
  if (!db) return
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  return new Promise<void>((resolve) => {
    const tx = db.transaction(VOICE_STORE_NAME, 'readwrite')
    const store = tx.objectStore(VOICE_STORE_NAME)
    const cursorRequest = store.openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      const record = cursor.value as VoiceCacheRecord
      if (!record.saved && record.createdAt < cutoff) {
        cursor.delete()
      }
      cursor.continue()
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      resolve()
    }
  })
}
