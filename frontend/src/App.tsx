import { useEffect, useState } from 'react'
import { getHealth } from './services/api'

type ConnectionState = 'checking' | 'connected' | 'failed'

function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('checking')
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let isCurrentRequest = true

    setConnectionState('checking')

    void getHealth()
      .then(() => {
        if (isCurrentRequest) {
          setConnectionState('connected')
        }
      })
      .catch(() => {
        if (isCurrentRequest) {
          setConnectionState('failed')
        }
      })

    return () => {
      isCurrentRequest = false
    }
  }, [retryCount])

  const handleRetry = () => {
    setConnectionState('checking')
    setRetryCount((count) => count + 1)
  }

  const connectionMessage = {
    checking: 'Checking connection...',
    connected: 'Backend connected successfully.',
    failed: 'Backend connection failed.',
  }[connectionState]

  return (
    <main className="flex min-h-svh items-center justify-center bg-slate-50 px-6 text-center text-slate-900">
      <section className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-10 shadow-sm sm:p-14">
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
          Frontend foundation
        </p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          WhatsApp Sales Assistant
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          AI-powered customer conversation management
        </p>
        <p className="mt-8 rounded-lg bg-emerald-50 px-5 py-4 font-medium text-emerald-800">
          Frontend foundation is running successfully.
        </p>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="text-lg font-semibold">Backend connection</h2>
          <p
            className={`mt-2 font-medium ${
              connectionState === 'connected'
                ? 'text-emerald-700'
                : connectionState === 'failed'
                  ? 'text-rose-700'
                  : 'text-slate-600'
            }`}
            role={connectionState === 'failed' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {connectionMessage}
          </p>

          {connectionState === 'failed' && (
            <button
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
              onClick={handleRetry}
              type="button"
            >
              Retry
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
