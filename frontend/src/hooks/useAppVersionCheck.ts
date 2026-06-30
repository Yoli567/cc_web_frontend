import { useEffect } from 'react'

const RELOAD_MARKER_KEY = 'cc-app-version-reload-marker'

export function useAppVersionCheck() {
  useEffect(() => {
    let cancelled = false

    const checkVersion = async () => {
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!response.ok || cancelled) return
        const payload = await response.json() as { version?: unknown }
        const latestVersion = typeof payload.version === 'string' ? payload.version : ''
        if (!latestVersion || latestVersion === __CC_APP_VERSION__) {
          sessionStorage.removeItem(RELOAD_MARKER_KEY)
          return
        }

        const marker = `${__CC_APP_VERSION__}->${latestVersion}`
        if (sessionStorage.getItem(RELOAD_MARKER_KEY) === marker) return
        sessionStorage.setItem(RELOAD_MARKER_KEY, marker)

        const url = new URL(window.location.href)
        url.searchParams.set('__ccv', latestVersion)
        window.location.replace(url.toString())
      } catch {
        // Version checks should never block the chat UI.
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkVersion()
      }
    }

    void checkVersion()
    window.addEventListener('focus', checkVersion)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      window.removeEventListener('focus', checkVersion)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
