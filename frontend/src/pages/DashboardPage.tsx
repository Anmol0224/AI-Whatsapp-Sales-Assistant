import { useAuth } from '../context/AuthContext'

const managementLinks = [
  {
    title: 'Business profile',
    description: 'Review and update your business information.',
    href: '/dashboard/business',
    marker: 'BP',
  },
  {
    title: 'Products & services',
    description: 'Manage the products and services in your catalog.',
    href: '/dashboard/catalog',
    marker: 'PS',
  },
  {
    title: 'FAQs',
    description: 'Manage the answers your business provides to customers.',
    href: '/dashboard/faqs',
    marker: 'FQ',
  },
] as const

export function DashboardPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { user, business } = useAuth()

  if (!user || !business) return null

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm font-semibold text-emerald-700">Workspace overview</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Welcome, {user.name}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
          Your business workspace is ready. Use the sections below to manage its information.
        </p>
      </section>

      <section
        aria-labelledby="account-heading"
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
          <div>
            <h3 id="account-heading" className="text-lg font-semibold text-slate-950">
              Account and business
            </h3>
            <p className="mt-1 text-sm text-slate-500">Authenticated workspace details.</p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
            Owner account
          </span>
        </div>

        <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owner</dt>
            <dd className="mt-2 text-sm font-medium text-slate-900">{user.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt>
            <dd className="mt-2 break-all text-sm font-medium text-slate-900">{user.email}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business</dt>
            <dd className="mt-2 text-sm font-medium text-slate-900">{business.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Workspace ID</dt>
            <dd className="mt-2 break-all font-mono text-xs text-slate-600">{business.id}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="management-heading">
        <div className="mb-4">
          <h3 id="management-heading" className="text-lg font-semibold text-slate-950">
            Manage your workspace
          </h3>
          <p className="mt-1 text-sm text-slate-600">Choose a section to continue.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {managementLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={(event) => {
                event.preventDefault()
                onNavigate(link.href)
              }}
              className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm outline-none transition-colors hover:border-emerald-300 hover:bg-emerald-50/30 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 sm:p-6"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xs font-bold tracking-wide text-emerald-800 group-hover:bg-emerald-100">
                {link.marker}
              </span>
              <span className="mt-4 block text-base font-semibold text-slate-950">{link.title}</span>
              <span className="mt-2 block text-sm leading-6 text-slate-600">{link.description}</span>
              <span className="mt-5 block text-sm font-semibold text-emerald-700">Open section <span aria-hidden="true">→</span></span>
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}
