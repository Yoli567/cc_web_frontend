/* eslint-disable react-refresh/only-export-components */
import { Outlet, useOutletContext } from 'react-router-dom'
import { useState } from 'react'
import BottomNav from './BottomNav'

type AppLayoutContext = {
  openSidebar: () => void
}

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="cc-app-shell flex h-full flex-col">
      <main className="flex-1 overflow-hidden">
        <Outlet context={{ openSidebar: () => setSidebarOpen(true) } satisfies AppLayoutContext} />
      </main>
      <BottomNav open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </div>
  )
}

export function useAppLayout() {
  return useOutletContext<AppLayoutContext>()
}
