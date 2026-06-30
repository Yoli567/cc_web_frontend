import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useAuth } from './AuthContext'

export default function AuthGate({ children }: { children: ReactNode }) {
  const { authenticated, authRequired, checking, login } = useAuth()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (checking) {
    return (
      <div className="cc-login-page">
        <div className="cc-login-panel">
          <div className="cc-login-mark" />
          <p className="cc-login-muted">正在连接...</p>
        </div>
      </div>
    )
  }

  if (!authRequired || authenticated) {
    return children
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const result = await login(username.trim(), password)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error ?? '登录失败')
    }
  }

  return (
    <div className="cc-login-page">
      <form className="cc-login-panel" onSubmit={handleSubmit}>
        <div className="cc-login-mark" />
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold">Claude Code Web</h1>
          <p className="cc-login-muted">请登录</p>
        </div>
        <label className="cc-login-field">
          <span>用户名</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="cc-login-field">
          <span>密码</span>
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p className="cc-login-error">{error}</p>}
        <button className="cc-login-button" disabled={submitting || !username.trim() || !password}>
          {submitting ? '进入中...' : '进入'}
        </button>
      </form>
    </div>
  )
}
