import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'

export default function Home() {
  const { openSidebar } = useAppLayout()

  return (
    <div className="cc-page relative flex h-full flex-col items-center justify-center gap-6 p-6 text-center">
      <button
        type="button"
        onClick={openSidebar}
        aria-label="Open navigation"
        title="Navigation"
        className="cc-cabin-nav-button"
      >
        <SidebarOpenIcon />
      </button>
      <div className="relative cc-fade-in">
        <div className="cc-card flex h-44 w-60 items-center justify-center rounded-[20px] border-dashed bg-[var(--cc-primary-soft)]">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-[var(--cc-primary)]">
              <span className="text-2xl">🏠</span>
            </div>
            <p className="text-sm font-medium text-[var(--cc-primary)]">Pixel Cottage</p>
            <p className="mt-1 text-xs text-[var(--cc-dim)]">Coming soon...</p>
          </div>
        </div>
      </div>
      <div className="max-w-xs cc-fade-in">
        <h1 className="mb-1 text-lg font-semibold text-[var(--cc-text)]">
          Our Little Home
        </h1>
        <p className="text-sm leading-relaxed text-[var(--cc-sub)]">
          2.5D pixel cottage with interactive elements - piano, record player, bookshelf, and more
        </p>
      </div>
    </div>
  )
}
