import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { AuthLayout, FormField, FormMessage, SubmitButton } from '../components/AuthLayout'
import { ApiError } from '../services/api'

export function LoginPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login({ email, password })
      onNavigate('/dashboard')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Sign in could not be completed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Welcome back"
      title="Sign in to your workspace"
      description="Manage your business profile and customer conversations from your workspace."
      footer={
        <>
          New to Sales Assistant?{' '}
          <a className="font-semibold text-emerald-700 hover:text-emerald-800" href="/register" onClick={(event) => { event.preventDefault(); onNavigate('/register') }}>
            Create an account
          </a>
        </>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <FormField id="email" label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} />
        <FormField id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <FormMessage>{error}</FormMessage>}
        <div className="pt-1">
          <SubmitButton loading={submitting}>Sign in</SubmitButton>
        </div>
        <p className="text-center text-xs leading-5 text-slate-500">Your account session stays in this browser tab.</p>
      </form>
    </AuthLayout>
  )
}
