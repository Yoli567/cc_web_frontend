export type NotificationStatus = 'unsupported' | 'default' | 'granted' | 'denied' | 'unconfigured' | 'subscribed'

const SERVICE_WORKER_URL = '/sw.js'
const CLAUDE_AVATAR_MESSAGE = 'cc-set-claude-avatar'

export async function registerAppServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL)
  } catch {
    return null
  }
}

export function getNotificationStatus(): NotificationStatus {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

// Permission being 'granted' does NOT mean a push subscription exists — the app
// must call pushManager.subscribe() and register it with the backend. Check the
// real subscription so the UI doesn't claim "Enabled" before that happens.
export async function getDetailedNotificationStatus(): Promise<NotificationStatus> {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission !== 'granted') return Notification.permission
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'granted'
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = registration ? await registration.pushManager.getSubscription() : null
    return subscription ? 'subscribed' : 'granted'
  } catch {
    return 'granted'
  }
}

export async function requestNotificationPermission(): Promise<NotificationStatus> {
  if (!('Notification' in window)) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission === 'granted') await registerAppServiceWorker()
  return permission
}

export async function subscribeToWebPush(): Promise<NotificationStatus> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported'
  }
  try {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    if (permission !== 'granted') return permission

    const keyResponse = await fetch('/api/push/public-key', { credentials: 'include' })
    if (!keyResponse.ok) {
      console.error('[push] public-key fetch failed', keyResponse.status)
      return 'unconfigured'
    }
    const keyPayload = await keyResponse.json() as { configured?: boolean; public_key?: string }
    if (!keyPayload.configured || !keyPayload.public_key) {
      console.error('[push] backend reports VAPID keys not configured')
      return 'unconfigured'
    }

    const registration = await registerAppServiceWorker()
    if (!registration) return 'unsupported'
    await navigator.serviceWorker.ready
    const applicationServerKey = urlBase64ToUint8Array(keyPayload.public_key)
    let subscription = await registration.pushManager.getSubscription()
    // A subscription from a previous (mismatched) VAPID key can't be re-signed;
    // drop it and re-subscribe with the current key.
    if (subscription && !applicationServerKeyMatches(subscription, applicationServerKey)) {
      await subscription.unsubscribe().catch(() => {})
      subscription = null
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    }
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
      credentials: 'include',
    })
    if (!response.ok) {
      console.error('[push] subscribe POST failed', response.status)
      return 'unconfigured'
    }
    return 'subscribed'
  } catch (error) {
    console.error('[push] subscribe failed', error)
    return 'default'
  }
}

function applicationServerKeyMatches(subscription: PushSubscription, key: Uint8Array) {
  const existing = subscription.options?.applicationServerKey
  if (!existing) return true
  const existingBytes = new Uint8Array(existing as ArrayBuffer)
  if (existingBytes.length !== key.length) return false
  for (let index = 0; index < key.length; index += 1) {
    if (existingBytes[index] !== key[index]) return false
  }
  return true
}

export async function showAppNotification(title: string, options: NotificationOptions = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker?.ready.catch(() => null)
  const payload: NotificationOptions = {
    badge: '/notification-badge.svg',
    icon: '/notification-claude-avatar',
    ...options,
  }
  if (registration) {
    await registration.showNotification(title, payload)
    return
  }
  new Notification(title, payload)
}

export async function syncClaudeAvatarForNotifications(avatar: string) {
  if (!('serviceWorker' in navigator)) return
  try {
    const registration = await registerAppServiceWorker()
    if (!registration) return
    await navigator.serviceWorker.ready
    const notificationAvatar = avatar ? await makeNotificationAvatar(avatar) : ''
    const worker = registration.active || navigator.serviceWorker.controller
    worker?.postMessage({ type: CLAUDE_AVATAR_MESSAGE, avatar: notificationAvatar })
  } catch {
    // Notification avatar sync is cosmetic; the push itself should keep working.
  }
}

async function makeNotificationAvatar(source: string) {
  if (!source.startsWith('data:image/')) return ''
  const image = await loadImage(source)
  const size = 192
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return source
  const scale = Math.max(size / image.width, size / image.height)
  const width = image.width * scale
  const height = image.height * scale
  const x = (size - width) / 2
  const y = (size - height) / 2
  context.clearRect(0, 0, size, size)
  context.drawImage(image, x, y, width, height)
  return canvas.toDataURL('image/png')
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = source
  })
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index)
  }
  return output
}
