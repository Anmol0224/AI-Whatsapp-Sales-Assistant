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

export type BusinessContactDetails = {
  phone?: string
  email?: string
  website?: string
  address?: string
}

export type BusinessProfile = {
  id: string
  name: string
  description?: string
  industry?: string
  contactDetails: BusinessContactDetails
  timezone?: string
}

export type BusinessProfileResponse = {
  success: true
  business: BusinessProfile
}

export type BusinessProfileUpdate = {
  name?: string
  description?: string
  industry?: string
  contactDetails?: BusinessContactDetails
  timezone?: string
}

export type CatalogItemKind = 'product' | 'service'

export type CatalogItem = {
  id: string
  kind: CatalogItemKind
  name: string
  description?: string
  priceInPaise?: number
  currency: 'INR'
  availability?: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type CatalogPagination = {
  page: number
  limit: number
  totalItems: number
  totalPages: number
}

export type CatalogItemsResponse = {
  success: true
  items: CatalogItem[]
  pagination: CatalogPagination
}

export type CatalogItemResponse = {
  success: true
  item: CatalogItem
}

export type CatalogItemDeactivationResponse = CatalogItemResponse & {
  message: string
}

export type CatalogItemCreateData = {
  kind: CatalogItemKind
  name: string
  description?: string
  priceInPaise?: number
  currency?: 'INR'
  availability?: string
}

export type CatalogItemUpdateData = Partial<CatalogItemCreateData>

export type CatalogFilters = {
  page?: number
  limit?: number
  kind?: CatalogItemKind
  isActive?: boolean
}

export type Faq = {
  id: string
  question: string
  answer: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type FaqResponse = {
  success: true
  faq: Faq
}

export type FaqDeactivationResponse = FaqResponse & {
  message: string
}

export type FaqsResponse = {
  success: true
  faqs: Faq[]
}

export type FaqCreateData = {
  question: string
  answer: string
}

export type FaqUpdateData = Partial<FaqCreateData>

export type FaqFilters = {
  isActive?: boolean
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

function hasOptionalStringProperties(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => !(key in value) || typeof value[key] === 'string')
}

function isBusinessContactDetails(value: unknown): value is BusinessContactDetails {
  return (
    isRecord(value) &&
    hasOptionalStringProperties(value, ['phone', 'email', 'website', 'address'])
  )
}

function isBusinessProfile(value: unknown): value is BusinessProfile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.industry === undefined || typeof value.industry === 'string') &&
    isBusinessContactDetails(value.contactDetails) &&
    (value.timezone === undefined || typeof value.timezone === 'string')
  )
}

function isBusinessProfileResponse(value: unknown): value is BusinessProfileResponse {
  return isRecord(value) && value.success === true && isBusinessProfile(value.business)
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isCatalogItem(value: unknown): value is CatalogItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'product' || value.kind === 'service') &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.priceInPaise === undefined ||
      (typeof value.priceInPaise === 'number' &&
        Number.isSafeInteger(value.priceInPaise) &&
        value.priceInPaise >= 0)) &&
    value.currency === 'INR' &&
    (value.availability === undefined || typeof value.availability === 'string') &&
    typeof value.isActive === 'boolean' &&
    isDateString(value.createdAt) &&
    isDateString(value.updatedAt)
  )
}

function isCatalogPagination(value: unknown): value is CatalogPagination {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.page) &&
    typeof value.page === 'number' &&
    value.page > 0 &&
    Number.isSafeInteger(value.limit) &&
    typeof value.limit === 'number' &&
    value.limit > 0 &&
    value.limit <= 100 &&
    Number.isSafeInteger(value.totalItems) &&
    typeof value.totalItems === 'number' &&
    value.totalItems >= 0 &&
    Number.isSafeInteger(value.totalPages) &&
    typeof value.totalPages === 'number' &&
    value.totalPages >= 0
  )
}

function isCatalogItemsResponse(value: unknown): value is CatalogItemsResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.items) &&
    value.items.every(isCatalogItem) &&
    isCatalogPagination(value.pagination)
  )
}

function isCatalogItemResponse(value: unknown): value is CatalogItemResponse {
  return isRecord(value) && value.success === true && isCatalogItem(value.item)
}

function isCatalogItemDeactivationResponse(
  value: unknown,
): value is CatalogItemDeactivationResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isCatalogItem(value.item)
  )
}

function isFaq(value: unknown): value is Faq {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.question === 'string' &&
    typeof value.answer === 'string' &&
    typeof value.isActive === 'boolean' &&
    isDateString(value.createdAt) &&
    isDateString(value.updatedAt)
  )
}

function isFaqResponse(value: unknown): value is FaqResponse {
  return isRecord(value) && value.success === true && isFaq(value.faq)
}

function isFaqDeactivationResponse(value: unknown): value is FaqDeactivationResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isFaq(value.faq)
  )
}

function isFaqsResponse(value: unknown): value is FaqsResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.faqs) &&
    value.faqs.every(isFaq)
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

export function getBusinessProfile(): Promise<BusinessProfileResponse> {
  return requestJson('/business', isBusinessProfileResponse, {}, true)
}

export function updateBusinessProfile(
  data: BusinessProfileUpdate,
): Promise<BusinessProfileResponse> {
  return requestJson(
    '/business',
    isBusinessProfileResponse,
    { method: 'PATCH', body: JSON.stringify(data) },
    true,
  )
}

function buildQuery(path: string, values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export function getCatalogItems(filters: CatalogFilters = {}): Promise<CatalogItemsResponse> {
  const path = buildQuery('/catalog-items', {
    page: filters.page,
    limit: filters.limit,
    kind: filters.kind,
    isActive: filters.isActive,
  })
  return requestJson(path, isCatalogItemsResponse, {}, true)
}

export function getCatalogItem(id: string): Promise<CatalogItemResponse> {
  return requestJson(`/catalog-items/${encodeURIComponent(id)}`, isCatalogItemResponse, {}, true)
}

export function createCatalogItem(data: CatalogItemCreateData): Promise<CatalogItemResponse> {
  return requestJson(
    '/catalog-items',
    isCatalogItemResponse,
    { method: 'POST', body: JSON.stringify(data) },
    true,
  )
}

export function updateCatalogItem(
  id: string,
  data: CatalogItemUpdateData,
): Promise<CatalogItemResponse> {
  return requestJson(
    `/catalog-items/${encodeURIComponent(id)}`,
    isCatalogItemResponse,
    { method: 'PATCH', body: JSON.stringify(data) },
    true,
  )
}

export function deactivateCatalogItem(id: string): Promise<CatalogItemDeactivationResponse> {
  return requestJson(
    `/catalog-items/${encodeURIComponent(id)}`,
    isCatalogItemDeactivationResponse,
    { method: 'DELETE' },
    true,
  )
}

export function getFaqs(filters: FaqFilters = {}): Promise<FaqsResponse> {
  const path = buildQuery('/faqs', { isActive: filters.isActive })
  return requestJson(path, isFaqsResponse, {}, true)
}

export function getFaq(id: string): Promise<FaqResponse> {
  return requestJson(`/faqs/${encodeURIComponent(id)}`, isFaqResponse, {}, true)
}

export function createFaq(data: FaqCreateData): Promise<FaqResponse> {
  return requestJson('/faqs', isFaqResponse, { method: 'POST', body: JSON.stringify(data) }, true)
}

export function updateFaq(id: string, data: FaqUpdateData): Promise<FaqResponse> {
  return requestJson(
    `/faqs/${encodeURIComponent(id)}`,
    isFaqResponse,
    { method: 'PATCH', body: JSON.stringify(data) },
    true,
  )
}

export function deactivateFaq(id: string): Promise<FaqDeactivationResponse> {
  return requestJson(
    `/faqs/${encodeURIComponent(id)}`,
    isFaqDeactivationResponse,
    { method: 'DELETE' },
    true,
  )
}
