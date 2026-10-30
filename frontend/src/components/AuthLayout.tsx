import type { ReactNode } from 'react'

export function AuthLayout({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[#f5f7fb] px-4 py-12 text-slate-900 sm:px-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-28 -top-32 h-96 w-96 rounded-full bg-emerald-200/40 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-teal-100/70 blur-3xl" />
      </div>
      <div className="relative z-10 w-full max-w-[460px]">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-sm font-bold tracking-tight text-white shadow-lg shadow-emerald-900/15">
            WA
          </div>
          <p className="text-sm font-semibold tracking-wide text-emerald-700">Sales Assistant</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{title}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">{description}</p>
        </header>

        <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-9">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{eyebrow}</p>
          </div>
          {children}
        </section>
        <footer className="mt-6 text-center text-sm text-slate-600">{footer}</footer>
        <p className="mt-8 text-center text-xs text-slate-400">AI-powered customer conversation management</p>
      </div>
    </main>
  )
}

export function FormField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  required = true,
  minLength,
  maxLength,
}: {
  id: string
  label: string
  type?: string
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  required?: boolean
  minLength?: number
  maxLength?: number
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-2 block text-sm font-medium text-slate-800">{label}</span>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
      />
    </label>
  )
}

export function SubmitButton({ children, loading }: { children: string; loading: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="flex h-12 w-full items-center justify-center rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? 'Please wait…' : children}
    </button>
  )
}

export function FormMessage({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'success' }) {
  return (
    <div
      className={`rounded-xl px-4 py-3 text-sm leading-5 ${kind === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {children}
    </div>
  )
}
