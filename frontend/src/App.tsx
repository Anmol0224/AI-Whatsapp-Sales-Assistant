import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from './components/DashboardLayout'
import { useAuth } from './context/AuthContext'
import { BusinessProfilePage } from './pages/BusinessProfilePage'
import { CatalogPage } from './pages/CatalogPage'
import { DashboardPage } from './pages/DashboardPage'
import { FaqsPage } from './pages/FaqsPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'

const dashboardRoutes = {
  '/dashboard': { title: 'Overview' },
  '/dashboard/business': { title: 'Business Profile' },
  '/dashboard/catalog': { title: 'Products & Services' },
  '/dashboard/faqs': { title: 'FAQs' },
} as const

type DashboardPath = keyof typeof dashboardRoutes

function isDashboardPath(pathname: string): boolean {
  return pathname === '/dashboard' || pathname.startsWith('/dashboard/')
}

function AppContent() {
  const { user, loading, restoreError, retryRestore, logout } = useAuth()
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState({}, '', path)
    else window.history.pushState({}, '', path)
    setPathname(path)
  }, [])

  useEffect(() => {
    if (user && !(pathname in dashboardRoutes)) {
      navigate('/dashboard', true)
    } else if (!user && !loading && isDashboardPath(pathname) && !restoreError) {
      navigate('/login', true)
    }
  }, [user, loading, pathname, restoreError, navigate])

  if (loading) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-[#f5f7fb] px-6 text-center">
        <div role="status" aria-live="polite" className="rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-sm">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
          <p className="font-medium text-slate-800">Restoring your session…</p>
        </div>
      </main>
    )
  }

  if (restoreError) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-[#f5f7fb] px-5 py-10">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
          <p className="text-sm font-semibold text-amber-700">Session check unavailable</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">We couldn’t verify your session</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">{restoreError}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={retryRestore} className="rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">Retry connection</button>
            <button type="button" onClick={() => { logout(); navigate('/login', true) }} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">Sign in again</button>
          </div>
        </section>
      </main>
    )
  }

  if (user) {
    const routePath = (pathname in dashboardRoutes ? pathname : '/dashboard') as DashboardPath
    const route = dashboardRoutes[routePath]
    let page = <DashboardPage onNavigate={navigate} />

    if (routePath === '/dashboard/business') {
      page = <BusinessProfilePage />
    } else if (routePath === '/dashboard/catalog') {
      page = <CatalogPage />
    } else if (routePath === '/dashboard/faqs') {
      page = <FaqsPage />
    } else if (routePath !== '/dashboard') {
      page = (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm font-semibold text-emerald-700">Coming next</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">{route.title}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            This management page will be available in a later step.
          </p>
        </section>
      )
    }

    return (
      <DashboardLayout pathname={routePath} title={route.title} onNavigate={navigate}>
        {page}
      </DashboardLayout>
    )
  }

  return pathname === '/register'
    ? <RegisterPage onNavigate={navigate} />
    : <LoginPage onNavigate={navigate} />
}

function App() {
  return <AppContent />
}

export default App
