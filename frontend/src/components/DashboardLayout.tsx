import { useState, type ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'

const navigationItems = [
  { label: 'Overview', href: '/dashboard', marker: 'OV' },
  { label: 'Business Profile', href: '/dashboard/business', marker: 'BP' },
  { label: 'Products & Services', href: '/dashboard/catalog', marker: 'PS' },
  { label: 'FAQs', href: '/dashboard/faqs', marker: 'FQ' },
] as const

type DashboardPath = (typeof navigationItems)[number]['href']

function NavigationLinks({
  pathname,
  onNavigate,
  onAfterNavigate,
}: {
  pathname: string
  onNavigate: (path: string) => void
  onAfterNavigate?: () => void
}) {
  return (
    <nav aria-label="Dashboard navigation" className="space-y-1">
      {navigationItems.map((item) => {
        const active = pathname === item.href
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault()
              onNavigate(item.href satisfies DashboardPath)
              onAfterNavigate?.()
            }}
            className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 ${
              active
                ? 'bg-emerald-50 text-emerald-800'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-[10px] font-bold tracking-wide ${
                active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {item.marker}
            </span>
            {item.label}
          </a>
        )
      })}
    </nav>
  )
}

export function DashboardLayout({
  pathname,
  title,
  onNavigate,
  children,
}: {
  pathname: DashboardPath
  title: string
  onNavigate: (path: string, replace?: boolean) => void
  children: ReactNode
}) {
  const { user, business, logout } = useAuth()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  function handleLogout() {
    logout()
    onNavigate('/login', true)
  }

  return (
    <div className="min-h-svh bg-[#f5f7fb] text-slate-900 md:flex">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex">
        <a
          href="/dashboard"
          onClick={(event) => {
            event.preventDefault()
            onNavigate('/dashboard')
          }}
          className="mb-9 flex items-center gap-3 rounded-xl px-2 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-700 text-xs font-bold tracking-wide text-white shadow-sm">
            WA
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-5 text-slate-950">WhatsApp Sales</span>
            <span className="block text-xs leading-5 text-slate-500">Assistant</span>
          </span>
        </a>

        <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Workspace
        </p>
        <NavigationLinks pathname={pathname} onNavigate={onNavigate} />

        <div className="mt-auto border-t border-slate-100 px-3 pt-5">
          <p className="truncate text-sm font-semibold text-slate-900">{business?.name ?? 'Business workspace'}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{user?.email ?? ''}</p>
        </div>
      </aside>

      <div className="min-h-svh min-w-0 flex-1 md:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
          <div className="mx-auto flex min-h-[76px] max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
                aria-expanded={mobileMenuOpen}
                aria-controls="mobile-dashboard-navigation"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 md:hidden"
              >
                <span aria-hidden="true" className="text-lg leading-none">{mobileMenuOpen ? '×' : '☰'}</span>
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">{title}</h1>
                <p className="truncate text-xs text-slate-500 sm:text-sm">{business?.name ?? 'Business workspace'}</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="max-w-44 truncate text-sm font-medium text-slate-800">{user?.name}</p>
                <p className="max-w-44 truncate text-xs text-slate-500">{user?.email}</p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 sm:px-4"
              >
                Log out
              </button>
            </div>
          </div>

          {mobileMenuOpen && (
            <div id="mobile-dashboard-navigation" className="border-t border-slate-100 bg-white px-4 py-4 sm:px-6 md:hidden">
              <NavigationLinks
                pathname={pathname}
                onNavigate={onNavigate}
                onAfterNavigate={() => setMobileMenuOpen(false)}
              />
            </div>
          )}
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  )
}
