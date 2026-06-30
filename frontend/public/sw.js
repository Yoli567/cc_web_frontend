const SW_VERSION = 'diag-6'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cc-set-claude-avatar') return
  event.waitUntil(storeClaudeAvatar(event.data.avatar))
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { body: event.data ? event.data.text() : '' }
  }
  const title = payload.title || 'Claude Code Web'
  event.waitUntil((async () => {
    await pingDebug({ stage: 'push-received', version: SW_VERSION, tag: payload.tag })
    const avatar = await getClaudeAvatar()
    const options = {
      body: payload.body || '',
      badge: payload.badge || '/notification-badge.svg',
      icon: payload.icon || avatar || '/favicon-192-maskable.png',
      tag: payload.tag || 'cc-web-push',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: payload.url || '/activity' },
    }
    await self.registration.showNotification(title, options)
  })())
})

async function pingDebug(info) {
  try {
    await fetch('/api/push/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info),
    })
  } catch {
    // diagnostics only
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/activity'
  event.waitUntil((async () => {
    if (targetUrl.startsWith('/message')) {
      const notifications = await self.registration.getNotifications()
      for (const notification of notifications) {
        if (isMessageNotification(notification)) notification.close()
      }
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const origin = self.location.origin
    const url = new URL(targetUrl, origin).href
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(url)
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})

async function storeClaudeAvatar(avatar) {
  const cache = await caches.open('cc-notification-assets')
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) {
    await cache.delete('/notification-claude-avatar-data')
    return
  }
  await cache.put('/notification-claude-avatar-data', new Response(avatar, {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  }))
}

async function getClaudeAvatar() {
  const cache = await caches.open('cc-notification-assets')
  const response = await cache.match('/notification-claude-avatar-data')
  if (!response) return ''
  return response.text()
}

function isMessageNotification(notification) {
  return (
    notification.data?.url?.startsWith('/message') ||
    notification.tag?.startsWith('message-reply-') ||
    notification.tag?.startsWith('nudge-message-') ||
    notification.tag?.startsWith('self-alarm-message-') ||
    notification.tag?.startsWith('diary-message-')
  )
}
