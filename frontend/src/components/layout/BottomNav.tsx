import { NavLink, useNavigate } from 'react-router-dom'
import { useSessions } from '@/sessions/SessionsContext'

const navItems = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/message', label: 'Messages', icon: MessageIcon },
  { to: '/cabin', label: 'Cabin', icon: CabinIcon },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/saved', label: 'Saved', icon: SavedIcon },
  { to: '/sessions', label: 'Sessions', icon: SessionsListIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

const RECENT_LIMIT = 5

export default function BottomNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { sessions, currentSessionId, switchSession } = useSessions()
  const navigate = useNavigate()
  const recentSessions = sessions
    .slice()
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, RECENT_LIMIT)

  const handleSessionClick = (sessionId: string, lastMode?: 'message' | 'cabin') => {
    switchSession(sessionId)
    navigate(lastMode === 'cabin' ? '/cabin' : '/message')
    onClose()
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className={`cc-sidebar-scrim fixed inset-0 z-40 transition-opacity duration-200 ${
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <nav
        aria-label="Main navigation"
        data-open={open ? 'true' : 'false'}
        className={`cc-sidebar fixed bottom-0 left-0 top-0 z-50 w-[min(18rem,82vw)] transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col px-3 py-4">
          <div className="mb-4 flex items-center justify-between px-2">
            <p className="text-lg italic text-[var(--cc-text)]" style={{ fontFamily: 'Georgia, "Palatino Linotype", "Book Antiqua", serif' }}>Claude Code Web</p>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onClose}
              className="cc-sidebar-close"
            >
              <ArrowLeftIcon />
            </button>
          </div>

          <div className="space-y-1">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                onClick={onClose}
                className={({ isActive }) =>
                  `cc-sidebar-link flex items-center gap-3 px-3 py-2.5 transition-all duration-200 ${
                    isActive
                      ? 'is-active text-[var(--cc-primary)]'
                      : 'text-[var(--cc-sub)] hover:text-[var(--cc-primary)]'
                  }`
                }
              >
                <Icon />
                <span className="text-sm font-medium">{label}</span>
              </NavLink>
            ))}
          </div>

          {recentSessions.length > 0 && (
            <>
              <div className="mt-4 flex items-center justify-between px-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--cc-dim)]">
                  Recent
                </span>
                <NavLink
                  to="/sessions"
                  onClick={onClose}
                  className="text-[10px] text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-primary)]"
                >
                  View all
                </NavLink>
              </div>
              <div className="mt-1 space-y-0.5 overflow-y-auto">
                {recentSessions.map((session) => {
                  const isActive = session.id === currentSessionId
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => handleSessionClick(session.id, session.lastMode)}
                      className={`cc-sidebar-session-link flex w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-left transition-colors ${
                        isActive ? 'cc-sidebar-session-active' : ''
                      }`}
                    >
                      <span className="shrink-0 text-[var(--cc-dim)]">
                        {session.lastMode === 'cabin' ? <SidebarCabinDot /> : <SidebarMessageDot />}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-[12.5px] ${
                          isActive ? 'text-[var(--cc-primary)]' : 'text-[var(--cc-sub)]'
                        }`}
                      >
                        {session.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </nav>
    </>
  )
}

function ArrowLeftIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.1}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
    </svg>
  )
}

export function SidebarOpenIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.1}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  )
}

function MessageIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  )
}

function CabinIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
    </svg>
  )
}

function SavedIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-3.5L6 21V4.75Z" />
    </svg>
  )
}

function ActivityIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3v3M17 3v3M4.75 8.5h14.5M6.75 12.25h.01M11.75 12.25h.01M16.75 12.25h.01M6.75 16.25h.01M11.75 16.25h.01M5.75 5.25h12.5c.83 0 1.5.67 1.5 1.5v11.5c0 .83-.67 1.5-1.5 1.5H5.75c-.83 0-1.5-.67-1.5-1.5V6.75c0-.83.67-1.5 1.5-1.5Z" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function SessionsListIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  )
}

function SidebarMessageDot() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.7 9.7 0 0 1-3.5-.62l-4.3 1.3 1.3-4.3A8.5 8.5 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z" />
    </svg>
  )
}

function SidebarCabinDot() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6a8 8 0 0 0-6-2c-1 0-2 .2-3 .5v14a8.6 8.6 0 0 1 3-.5c2.3 0 4.4.9 6 2.3M12 6a8 8 0 0 1 6-2c1 0 2 .2 3 .5v14a8.6 8.6 0 0 0-3-.5 8.6 8.6 0 0 0-6 2.3M12 6v14" />
    </svg>
  )
}
