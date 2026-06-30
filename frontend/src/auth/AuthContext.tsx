/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

type AuthContextValue = {
  authenticated: boolean
  authRequired: boolean
  checking: boolean
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
}

type AuthStatus = {
  auth_required: boolean
  authenticated: boolean
}

const API_BASE = import.meta.env.DEV ? `http://${window.location.hostname}:8000` : ''
const AUTH_STATUS_TIMEOUT_MS = 1500
const AuthContext = createContext<AuthContextValue | null>(null)

async function fetchAuthStatus(): Promise<AuthStatus> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), AUTH_STATUS_TIMEOUT_MS)

  try {
    const response = await fetch(`${API_BASE}/api/auth/status`, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error('Auth status unavailable')
    }
    return response.json()
  } finally {
    window.clearTimeout(timeout)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [authRequired, setAuthRequired] = useState(true)

  useEffect(() => {
    let active = true

    fetchAuthStatus()
      .then((status) => {
        if (!active) return
        setAuthRequired(status.auth_required)
        setAuthenticated(!status.auth_required || status.authenticated)
      })
      .catch(() => {
        if (!active) return
        setAuthRequired(!import.meta.env.DEV)
        setAuthenticated(import.meta.env.DEV)
      })
      .finally(() => {
        if (!active) return
        setChecking(false)
      })

    return () => {
      active = false
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) {
        return { ok: false, error: '用户名或密码不对' }
      }
      setAuthenticated(true)
      setAuthRequired(true)
      return { ok: true }
    } catch {
      return { ok: false, error: '连不上登录服务' }
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      })
    } finally {
      setAuthenticated(false)
      setAuthRequired(true)
    }
  }, [])

  const value = useMemo(
    () => ({ authenticated, authRequired, checking, login, logout }),
    [authenticated, authRequired, checking, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return value
}
