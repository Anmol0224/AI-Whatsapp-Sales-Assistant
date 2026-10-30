import { useAuth } from '../context/AuthContext'

export function DashboardPage({ onNavigate }: { onNavigate: (path: string, replace?: boolean) => void }) {
  const { user, business, logout } = useAuth()

  if (!user || !business) return null

  function handleLogout() {
    logout()
    onNavigate('/login', true)
  }

  return (
    <main className="min-h-svh bg-[#f5f7fb] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-700 text-xs font-bold text-white">WA</div>
            <div>
              <p className="text-sm font-semibold text-slate-950">WhatsApp Sales Assistant</p>
              <p className="text-xs text-slate-500">Business workspace</p>
            </div>
          </div>
          <button
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={handleLogout}
          >
            Log out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="mb-8">
          <p className="text-sm font-medium text-emerald-700">Workspace overview</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Welcome, {user.name}</h1>
          <p className="mt-2 text-slate-600">Your account is connected and ready for the next setup steps.</p>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" aria-labelledby="account-heading">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
            <div>
              <h2 id="account-heading" className="text-lg font-semibold text-slate-950">Account details</h2>
              <p className="mt-1 text-sm text-slate-500">Your owner profile and business workspace.</p>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">Owner account</span>
          </div>

          <dl className="grid gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owner name</dt>
              <dd className="mt-2 text-sm font-medium text-slate-900">{user.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owner email</dt>
              <dd className="mt-2 break-all text-sm font-medium text-slate-900">{user.email}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business</dt>
              <dd className="mt-2 text-sm font-medium text-slate-900">{business.name}</dd>
            </div>
          </dl>
        </section>

        <p className="mt-6 text-sm text-slate-500">This is your starter workspace. Business settings and conversation tools will be added in later steps.</p>
      </div>
    </main>
  )
}
