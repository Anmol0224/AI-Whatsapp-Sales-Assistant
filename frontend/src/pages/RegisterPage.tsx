import { useState, type FormEvent } from 'react'
import { AuthLayout, FormField, FormMessage, SubmitButton } from '../components/AuthLayout'
import { ApiError } from '../services/api'
import { useAuth } from '../context/AuthContext'

export function RegisterPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { register } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await register({ name, email, password, businessName })
      setRegisteredEmail(result.user.email)
      setPassword('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Registration could not be completed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Create your workspace"
      title="Set up your account"
      description="Create an owner account to manage your business conversations in one place."
      footer={
        <>
          Already have an account?{' '}
          <a className="font-semibold text-emerald-700 hover:text-emerald-800" href="/login" onClick={(event) => { event.preventDefault(); onNavigate('/login') }}>
            Sign in
          </a>
        </>
      }
    >
      {registeredEmail ? (
        <div className="space-y-5">
          <FormMessage kind="success">
            Your account for <strong>{registeredEmail}</strong> is ready. Sign in to continue.
          </FormMessage>
          <button
            className="flex h-12 w-full items-center justify-center rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="button"
            onClick={() => onNavigate('/login')}
          >
            Continue to sign in
          </button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <FormField id="name" label="Owner name" value={name} onChange={setName} autoComplete="name" maxLength={100} />
          <FormField id="email" label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} />
          <FormField id="businessName" label="Business name" value={businessName} onChange={setBusinessName} autoComplete="organization" maxLength={150} />
          <FormField id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
          {error && <FormMessage>{error}</FormMessage>}
          <div className="pt-2">
            <SubmitButton loading={submitting}>Create account</SubmitButton>
          </div>
          <p className="text-center text-xs leading-5 text-slate-500">Use at least 8 characters for your password.</p>
        </form>
      )}
    </AuthLayout>
  )
}
