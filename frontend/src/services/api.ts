export type HealthResponse = {
  success: true
  message: 'Backend is running successfully'
  service: 'WhatsApp Sales Assistant API'
}

export type SafeAccount = {
  id: string
  name: string
  email: string
  role: 'owner'
}

export type SafeBusiness = {
  id: string
  name: string
}

export type RegistrationResponse = {
  user: Pick<SafeAccount, 'id' | 'name' | 'email'>
  business: SafeBusiness
}

export type LoginResponse = {
  success: true
  token: string
  expiresIn: number
  user: SafeAccount
  business: SafeBusiness
}

export type CurrentAccountResponse = {
  success: true
  user: SafeAccount
  business: SafeBusiness
}

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type ResponseValidator<T> = (value: unknown) => value is T

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/+$/, '')
let authToken: string | null = null
let unauthorizedHandler: (() => void) | null = null
let healthRequest: Promise<HealthResponse> | null = null
let accountRequest: { token: string | null; promise: Promise<CurrentAccountResponse> } | null = null

export function setApiToken(token: string | null): void {
  if (authToken !== token) accountRequest = null
  authToken = token
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    value.message === 'Backend is running successfully' &&
    value.service === 'WhatsApp Sales Assistant API'
  )
}

function isSafeAccount(value: unknown): value is SafeAccount {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    value.role === 'owner'
  )
}

function isSafeBusiness(value: unknown): value is SafeBusiness {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function isRegistrationResponse(value: unknown): value is RegistrationResponse {
  return (
    isRecord(value) &&
    isRecord(value.user) &&
    typeof value.user.id === 'string' &&
    typeof value.user.name === 'string' &&
    typeof value.user.email === 'string' &&
    isSafeBusiness(value.business)
  )
}

function isLoginResponse(value: unknown): value is LoginResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.expiresIn === 'number' &&
    isSafeAccount(value.user) &&
    isSafeBusiness(value.business)
  )
}

function isCurrentAccountResponse(value: unknown): value is CurrentAccountResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    isSafeAccount(value.user) &&
    isSafeBusiness(value.business)
  )
}

function safeErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.message === 'string') {
    const details = Array.isArray(payload.errors)
      ? payload.errors
          .filter(
            (item): item is Record<string, unknown> =>
              isRecord(item) && typeof item.message === 'string',
          )
          .map((item) => String(item.message))
      : []
    return details.length > 0 ? `${payload.message} ${details.join(' ')}` : payload.message
  }

  if (status === 401) return 'Your session is invalid or has expired. Please sign in again.'
  if (status === 409) return 'An account with this email already exists.'
  return 'The request could not be completed. Please try again.'
}

async function requestJson<T>(
  path: string,
  isExpectedResponse: ResponseValidator<T>,
  options: RequestInit = {},
  authenticated = false,
): Promise<T> {
  const normalizedPath = path.replace(/^\/+/, '')
  const headers = new Headers(options.headers)

  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (authenticated && authToken) headers.set('Authorization', `Bearer ${authToken}`)

  let response: Response

  try {
    response = await fetch(`${apiBaseUrl}/${normalizedPath}`, { ...options, headers })
  } catch {
    throw new ApiError('Unable to reach the backend. Check the connection and retry.')
  }

  let payload: unknown

  try {
    payload = await response.json()
  } catch {
    if (!response.ok) {
      if (authenticated && response.status === 401) unauthorizedHandler?.()
      throw new ApiError(safeErrorMessage(null, response.status), response.status)
    }
    throw new ApiError('The backend returned an invalid response.', response.status)
  }

  if (!response.ok) {
    if (authenticated && response.status === 401) unauthorizedHandler?.()
    throw new ApiError(safeErrorMessage(payload, response.status), response.status)
  }

  if (!isExpectedResponse(payload)) {
    throw new ApiError('The backend returned an unexpected response.', response.status)
  }

  return payload
}

export function getHealth(): Promise<HealthResponse> {
  if (!healthRequest) {
    healthRequest = requestJson('/health', isHealthResponse).finally(() => {
      healthRequest = null
    })
  }
  return healthRequest
}

export function registerAccount(input: {
  name: string
  email: string
  password: string
  businessName: string
}): Promise<RegistrationResponse> {
  return requestJson('/auth/register', isRegistrationResponse, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function loginAccount(input: { email: string; password: string }): Promise<LoginResponse> {
  return requestJson('/auth/login', isLoginResponse, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getCurrentAccount(): Promise<CurrentAccountResponse> {
  if (accountRequest?.token === authToken) return accountRequest.promise

  const token = authToken
  const promise = requestJson('/auth/me', isCurrentAccountResponse, {}, true).finally(() => {
    if (accountRequest?.promise === promise) accountRequest = null
  })
  accountRequest = { token, promise }
  return promise
}
