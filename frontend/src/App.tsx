import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppLayout from '@/components/layout/AppLayout'
import Home from '@/pages/Home'
import Message from '@/pages/Message'
import Cabin from '@/pages/Cabin'
import Settings from '@/pages/Settings'
import Sessions from '@/pages/Sessions'
import Saved from '@/pages/Saved'
import Activity from '@/pages/Activity'
import AuthGate from '@/auth/AuthGate'
import { AuthProvider } from '@/auth/AuthContext'
import { ThemeProvider } from '@/theme/ThemeContext'
import { SessionsProvider } from '@/sessions/SessionsContext'
import { useAppVersionCheck } from '@/hooks/useAppVersionCheck'
import NudgeRuntime from '@/runtime/NudgeRuntime'
import { cleanupExpiredVoices } from '@/utils/voiceCache'

export default function App() {
  useAppVersionCheck()

  useEffect(() => {
    void cleanupExpiredVoices()
  }, [])

  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <SessionsProvider>
            <NudgeRuntime />
            <BrowserRouter>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/message" element={<Message />} />
                  <Route path="/cabin" element={<Cabin />} />
                  <Route path="/activity" element={<Activity />} />
                  <Route path="/saved" element={<Saved />} />
                  <Route path="/sessions" element={<Sessions />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </SessionsProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  )
}
