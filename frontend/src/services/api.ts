export type HealthResponse = {
  success: true
  message: 'Backend is running successfully'
  service: 'WhatsApp Sales Assistant API'
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

async function requestJson<T>(
  path: string,
  isExpectedResponse: ResponseValidator<T>,
  options: RequestInit = {},
): Promise<T> {
  const normalizedPath = path.replace(/^\/+/, '')
  const headers = new Headers(options.headers)

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json')
  }

  let response: Response

  try {
    response = await fetch(`${apiBaseUrl}/${normalizedPath}`, {
      ...options,
      headers,
    })
  } catch {
    throw new ApiError('Unable to reach the backend. Check the connection and retry.')
  }

  let payload: unknown

  try {
    payload = await response.json()
  } catch {
    throw new ApiError('The backend returned an invalid response.', response.status)
  }

  if (!response.ok) {
    throw new ApiError('The backend request failed.', response.status)
  }

  if (!isExpectedResponse(payload)) {
    throw new ApiError('The backend returned an unexpected response.', response.status)
  }

  return payload
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const response = value as Record<string, unknown>

  return (
    response.success === true &&
    response.message === 'Backend is running successfully' &&
    response.service === 'WhatsApp Sales Assistant API'
  )
}

let healthRequest: Promise<HealthResponse> | null = null

export function getHealth(): Promise<HealthResponse> {
  if (healthRequest) {
    return healthRequest
  }

  healthRequest = requestJson('/health', isHealthResponse).finally(() => {
    healthRequest = null
  })

  return healthRequest
}
