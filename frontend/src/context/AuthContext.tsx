import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ApiError,
  getCurrentAccount,
  loginAccount,
  registerAccount,
  setApiToken,
  setUnauthorizedHandler,
  type SafeAccount,
  type SafeBusiness,
} from '../services/api'

const tokenStorageKey = 'whatsapp-sales-assistant-token'

type RegistrationInput = {
  name: string
  email: string
  password: string
  businessName: string
}

type LoginInput = { email: string; password: string }

type AuthContextValue = {
  user: SafeAccount | null
  business: SafeBusiness | null
  loading: boolean
  restoreError: string | null
  login: (input: LoginInput) => Promise<void>
  register: (input: RegistrationInput) => ReturnType<typeof registerAccount>
  logout: () => void
  retryRestore: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(tokenStorageKey)
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initialToken = useRef<string | null>(readStoredToken())
  const [user, setUser] = useState<SafeAccount | null>(null)
  const [business, setBusiness] = useState<SafeBusiness | null>(null)
  const [loading, setLoading] = useState(Boolean(initialToken.current))
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoreAttempt, setRestoreAttempt] = useState(0)

  const logout = useCallback(() => {
    try {
      window.sessionStorage.removeItem(tokenStorageKey)
    } catch {
      // Keep the in-memory session cleared even if browser storage is unavailable.
    }
    initialToken.current = null
    setApiToken(null)
    setUser(null)
    setBusiness(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(logout)

    const storedToken = initialToken.current
    if (!storedToken) {
      setApiToken(null)
      return () => setUnauthorizedHandler(null)
    }

    setApiToken(storedToken)
    setLoading(true)
    setRestoreError(null)
    void getCurrentAccount()
      .then((account) => {
        setUser(account.user)
        setBusiness(account.business)
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          logout()
        } else {
          setRestoreError(
            error instanceof Error ? error.message : 'Unable to restore your session right now.',
          )
        }
      })
      .finally(() => setLoading(false))

    return () => setUnauthorizedHandler(null)
  }, [logout, restoreAttempt])

  const login = useCallback(async (input: LoginInput) => {
    const result = await loginAccount(input)

    try {
      window.sessionStorage.setItem(tokenStorageKey, result.token)
    } catch {
      throw new ApiError('This browser could not save your session. Enable session storage and retry.')
    }

    initialToken.current = result.token
    setApiToken(result.token)
    setUser(result.user)
    setBusiness(result.business)
    setLoading(false)
  }, [])

  const register = useCallback((input: RegistrationInput) => registerAccount(input), [])
  const retryRestore = useCallback(() => setRestoreAttempt((attempt) => attempt + 1), [])

  const value = useMemo(
    () => ({ user, business, loading, restoreError, login, register, logout, retryRestore }),
    [user, business, loading, restoreError, login, register, logout, retryRestore],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider.')
  return context
}
