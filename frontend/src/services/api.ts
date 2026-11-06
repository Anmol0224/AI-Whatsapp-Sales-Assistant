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

export type BusinessAiSettings = {
  automaticRepliesEnabled: boolean
  automaticRepliesEnabledAt?: string
  automaticRepliesDisabledAt?: string
  automaticRepliesPolicyVersion?: string
}

export type BusinessAiSettingsResponse = {
  success: true
  aiSettings: BusinessAiSettings
  automaticSendAvailable: boolean
}

export type BusinessAiSettingsUpdateResponse = BusinessAiSettingsResponse & {
  message: string
}

export type BusinessAiSettingsUpdate = {
  automaticRepliesEnabled: boolean
}

export type BusinessWhatsAppConnectionStatus =
  | 'not_configured'
  | 'configured_not_verified'
  | 'verification_pending'
  | 'verified'
  | 'verification_failed'

export type BusinessWhatsAppVerificationFailureCategory =
  | 'missing_access_token'
  | 'missing_graph_api_version'
  | 'invalid_phone_number_id'
  | 'provider_authentication_failed'
  | 'missing_permissions'
  | 'invalid_phone_number_id_at_provider'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_unavailable'
  | 'unexpected_provider_response'
  | 'phone_number_id_mismatch'

export type BusinessWhatsAppSettings = {
  phoneNumberId?: string
  displayNumber?: string
  connectionStatus: BusinessWhatsAppConnectionStatus
  verifiedPhoneNumberId?: string
  lastVerificationAt?: string
  verificationFailureCategory?: BusinessWhatsAppVerificationFailureCategory
  verifiedDisplayNumber?: string
  verifiedName?: string
  qualityRating?: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'
}

export type BusinessWhatsAppSettingsResponse = {
  success: true
  whatsapp: BusinessWhatsAppSettings
}

export type BusinessWhatsAppSettingsUpdate = {
  phoneNumberId: string
  displayNumber?: string
}

export type BusinessWhatsAppVerificationResponse = {
  success: true
  message: string
  whatsapp: BusinessWhatsAppSettings
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

export type InboxConversation = {
  id: string
  customer?: {
    profileName?: string
    phoneNumber?: string
  }
  status: 'open' | 'closed'
  lastMessagePreview?: string
  lastActivityAt: string
}

export type InboxMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  messageType: 'text'
  text: string
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed'
  providerErrorCode?: string
  providerErrorTitle?: string
  timestamp?: string
  createdAt: string
}

export type ConversationListResponse = {
  success: true
  conversations: InboxConversation[]
  pagination: CatalogPagination
}

export type ConversationMessagesResponse = {
  success: true
  messages: InboxMessage[]
  pagination: CatalogPagination
}

export type SentConversationMessage = InboxMessage & {
  conversationId: string
  customerId: string
  providerMessageId: string
  updatedAt: string
}

export type SendConversationMessageResponse = {
  success: true
  message: string
  data: { message: SentConversationMessage }
}

export type ConversationFilters = {
  page?: number
  limit?: number
}

export type AiReplyDraftStatus =
  | 'queued'
  | 'processing'
  | 'draft_ready'
  | 'approved'
  | 'rejected'
  | 'sending'
  | 'sent'
  | 'send_failed'
  | 'send_uncertain'
  | 'failed'
  | 'cancelled'

export type AiReplyDraft = {
  id: string
  conversationId: string
  sourceMessage: AiDraftSourceMessage | null
  status: AiReplyDraftStatus
  generatedDraft?: string
  approvedText?: string
  approvalEdited?: boolean
  approvedAt?: string
  rejectedAt?: string
  rejectionReason?: string
  createdAt: string
  updatedAt: string
}

export type AiDraftSourceMessage = {
  id: string
  text: string
  timestamp?: string
  createdAt: string
}

export type AiDraftsResponse = {
  success: true
  drafts: AiReplyDraft[]
  pagination: CatalogPagination
}

export type AiDraftResponse = {
  success: true
  draft: AiReplyDraft
}

export type AiDraftApprovalResponse = {
  success: true
  message: string
  draft: { id: string; status: 'approved'; approvedText: string }
}

export type AiDraftRejectionResponse = {
  success: true
  message: string
  draft: { id: string; status: 'rejected' }
}

export type AiDraftSendResponse =
  | {
      success: true
      message: string
      draft: { id: string; status: 'sent'; alreadySent?: true }
      data?: { message: { id: string; text: string; status: 'sent'; createdAt: string } }
    }
  | {
      success: true
      message: string
      draft: { id: string; status: 'outcome_uncertain' }
    }

export type AiDraftFilters = {
  page?: number
  limit?: number
  status?: AiReplyDraftStatus
}

export type AiReplyEscalationCategory =
  | 'needs_owner_review'
  | 'unsupported_information'
  | 'ambiguous_request'
  | 'missing_business_information'
  | 'policy_conflict'
  | 'invalid_or_empty_response'

export type AiReplyEscalationReasonCode =
  | 'automatic_replies_disabled'
  | 'source_message_unavailable'
  | 'conversation_mode_mismatch'
  | 'stale_control_version'
  | 'stale_policy_version'
  | 'business_evidence_unavailable'
  | 'evidence_incomplete'
  | 'faq_not_exact'
  | 'faq_answers_conflict'
  | 'catalog_intent_unsupported'
  | 'catalog_item_missing'
  | 'catalog_item_ambiguous'
  | 'catalog_price_missing'
  | 'faq_exact_answer'
  | 'catalog_price_response'
  | 'catalog_listing_response'
  | 'generated_response_mismatch'
  | 'generated_response_invalid'
  | 'provider_generation_failed'
  | 'validation_failed'

export type AiReplyEscalationStatus = 'open' | 'resolved' | 'dismissed'
export type AiReplyEscalationStatusFilter = AiReplyEscalationStatus | 'all'
export type AiReplyEscalationResolutionOutcome = 'resolved' | 'dismissed'

export type AiEscalationConversation = {
  id: string
  status: 'open' | 'closed'
  customer: {
    profileName?: string
    phoneNumber?: string
  } | null
}

export type AiEscalationInboundMessage = {
  id: string
  text: string
  timestamp?: string
  createdAt: string
}

export type AiEscalationEvidence = {
  kind: 'faq' | 'catalog_item'
  recordId: string
  label?: string
}

export type AiReplyEscalation = {
  id: string
  conversationId: string
  conversation: AiEscalationConversation | null
  inboundMessage: AiEscalationInboundMessage | null
  category: AiReplyEscalationCategory
  reasonCode: AiReplyEscalationReasonCode
  policyVersion?: string
  expectedPolicyVersion?: string
  controlVersion?: number
  expectedControlVersion?: number
  status: AiReplyEscalationStatus
  resolvedAt?: string
  resolutionNote?: string
  createdAt: string
  updatedAt: string
}

export type AiReplyEscalationDetail = AiReplyEscalation & {
  evidence: AiEscalationEvidence[]
}

export type AiEscalationCounts = {
  pending: number
  resolved: number
  dismissed: number
  total: number
}

export type AiEscalationsResponse = {
  success: true
  escalations: AiReplyEscalation[]
  counts: AiEscalationCounts
  pagination: CatalogPagination
}

export type AiEscalationResponse = {
  success: true
  escalation: AiReplyEscalationDetail
}

export type AiEscalationResolutionResponse = {
  success: true
  message: string
  escalation: {
    id: string
    status: AiReplyEscalationResolutionOutcome
    resolvedAt: string
    resolutionNote?: string
  }
}

export type AiEscalationFilters = {
  page?: number
  limit?: number
  status?: AiReplyEscalationStatusFilter
}

export type ConversationResponseMode = 'human' | 'ai' | 'ai_draft' | 'ai_automatic'

export type ConversationResponseModeResponse = {
  success: true
  message: string
  conversation: { id: string; responseMode: ConversationResponseMode }
}

export type ConversationResponseModeGetResponse = {
  success: true
  conversation: { id: string; responseMode: ConversationResponseMode }
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

function isBusinessAiSettings(value: unknown): value is BusinessAiSettings {
  return (
    isRecord(value) &&
    typeof value.automaticRepliesEnabled === 'boolean' &&
    (value.automaticRepliesEnabledAt === undefined || isDateString(value.automaticRepliesEnabledAt)) &&
    (value.automaticRepliesDisabledAt === undefined || isDateString(value.automaticRepliesDisabledAt)) &&
    (value.automaticRepliesPolicyVersion === undefined || typeof value.automaticRepliesPolicyVersion === 'string')
  )
}

function isBusinessAiSettingsResponse(value: unknown): value is BusinessAiSettingsResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    isBusinessAiSettings(value.aiSettings) &&
    typeof value.automaticSendAvailable === 'boolean'
  )
}

function isBusinessAiSettingsUpdateResponse(value: unknown): value is BusinessAiSettingsUpdateResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    isBusinessAiSettings(value.aiSettings) &&
    typeof value.automaticSendAvailable === 'boolean' &&
    typeof value.message === 'string'
  )
}

function isBusinessWhatsAppSettings(value: unknown): value is BusinessWhatsAppSettings {
  return (
    isRecord(value) &&
    (value.phoneNumberId === undefined || typeof value.phoneNumberId === 'string') &&
    (value.displayNumber === undefined || typeof value.displayNumber === 'string') &&
    (value.connectionStatus === 'not_configured' ||
      value.connectionStatus === 'configured_not_verified' ||
      value.connectionStatus === 'verification_pending' ||
      value.connectionStatus === 'verified' ||
      value.connectionStatus === 'verification_failed') &&
    (value.verifiedPhoneNumberId === undefined || typeof value.verifiedPhoneNumberId === 'string') &&
    (value.lastVerificationAt === undefined || isDateString(value.lastVerificationAt)) &&
    (value.verificationFailureCategory === undefined || isBusinessWhatsAppVerificationFailureCategory(value.verificationFailureCategory)) &&
    (value.verifiedDisplayNumber === undefined || typeof value.verifiedDisplayNumber === 'string') &&
    (value.verifiedName === undefined || typeof value.verifiedName === 'string') &&
    (value.qualityRating === undefined || ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'].includes(String(value.qualityRating)))
  )
}

function isBusinessWhatsAppVerificationFailureCategory(value: unknown): value is BusinessWhatsAppVerificationFailureCategory {
  return [
    'missing_access_token', 'missing_graph_api_version', 'invalid_phone_number_id',
    'provider_authentication_failed', 'missing_permissions', 'invalid_phone_number_id_at_provider',
    'provider_rate_limited', 'provider_timeout', 'provider_network_error', 'provider_unavailable',
    'unexpected_provider_response', 'phone_number_id_mismatch',
  ].includes(String(value))
}

function isBusinessWhatsAppSettingsResponse(value: unknown): value is BusinessWhatsAppSettingsResponse {
  return isRecord(value) && value.success === true && isBusinessWhatsAppSettings(value.whatsapp)
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

function isInboxConversation(value: unknown): value is InboxConversation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.status !== 'open' && value.status !== 'closed') ||
    (value.lastMessagePreview !== undefined && typeof value.lastMessagePreview !== 'string') ||
    !isDateString(value.lastActivityAt)
  ) {
    return false
  }

  if (value.customer === undefined) return true
  return (
    isRecord(value.customer) &&
    (value.customer.profileName === undefined || typeof value.customer.profileName === 'string') &&
    (value.customer.phoneNumber === undefined || typeof value.customer.phoneNumber === 'string')
  )
}

function isInboxMessage(value: unknown): value is InboxMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.direction === 'inbound' || value.direction === 'outbound') &&
    value.messageType === 'text' &&
    typeof value.text === 'string' &&
    ['received', 'sent', 'delivered', 'read', 'failed'].includes(String(value.status)) &&
    (value.providerErrorCode === undefined || (typeof value.providerErrorCode === 'string' && value.providerErrorCode.length <= 64)) &&
    (value.providerErrorTitle === undefined || (typeof value.providerErrorTitle === 'string' && value.providerErrorTitle.length <= 200)) &&
    (value.timestamp === undefined || isDateString(value.timestamp)) &&
    isDateString(value.createdAt)
  )
}

function isConversationListResponse(value: unknown): value is ConversationListResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.conversations) &&
    value.conversations.every(isInboxConversation) &&
    isCatalogPagination(value.pagination)
  )
}

function isConversationMessagesResponse(value: unknown): value is ConversationMessagesResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.messages) &&
    value.messages.every(isInboxMessage) &&
    isCatalogPagination(value.pagination)
  )
}

function isSentConversationMessage(value: unknown): value is SentConversationMessage {
  return (
    isRecord(value) &&
    typeof value.conversationId === 'string' &&
    typeof value.customerId === 'string' &&
    typeof value.providerMessageId === 'string' &&
    isDateString(value.updatedAt) &&
    isInboxMessage(value)
  )
}

function isSendConversationMessageResponse(value: unknown): value is SendConversationMessageResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isRecord(value.data) &&
    isSentConversationMessage(value.data.message)
  )
}

const aiReplyDraftStatuses: readonly AiReplyDraftStatus[] = [
  'queued',
  'processing',
  'draft_ready',
  'approved',
  'rejected',
  'sending',
  'sent',
  'send_failed',
  'send_uncertain',
  'failed',
  'cancelled',
]

function isAiReplyDraft(value: unknown): value is AiReplyDraft {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.conversationId === 'string' &&
    (value.sourceMessage === null || isAiDraftSourceMessage(value.sourceMessage)) &&
    aiReplyDraftStatuses.includes(value.status as AiReplyDraftStatus) &&
    (value.generatedDraft === undefined || typeof value.generatedDraft === 'string') &&
    (value.approvedText === undefined || typeof value.approvedText === 'string') &&
    (value.approvalEdited === undefined || typeof value.approvalEdited === 'boolean') &&
    (value.approvedAt === undefined || isDateString(value.approvedAt)) &&
    (value.rejectedAt === undefined || isDateString(value.rejectedAt)) &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string') &&
    isDateString(value.createdAt) &&
    isDateString(value.updatedAt)
  )
}

function isAiDraftSourceMessage(value: unknown): value is AiDraftSourceMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    (value.timestamp === undefined || isDateString(value.timestamp)) &&
    isDateString(value.createdAt)
  )
}

function isAiDraftsResponse(value: unknown): value is AiDraftsResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isAiReplyDraft) &&
    isCatalogPagination(value.pagination)
  )
}

function isAiDraftResponse(value: unknown): value is AiDraftResponse {
  return isRecord(value) && value.success === true && isAiReplyDraft(value.draft)
}

function isAiDraftApprovalResponse(value: unknown): value is AiDraftApprovalResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isRecord(value.draft) &&
    typeof value.draft.id === 'string' &&
    value.draft.status === 'approved' &&
    typeof value.draft.approvedText === 'string'
  )
}

function isAiDraftRejectionResponse(value: unknown): value is AiDraftRejectionResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isRecord(value.draft) &&
    typeof value.draft.id === 'string' &&
    value.draft.status === 'rejected'
  )
}

function isAiDraftSendResponse(value: unknown): value is AiDraftSendResponse {
  if (!isRecord(value) || value.success !== true || typeof value.message !== 'string' || !isRecord(value.draft)) {
    return false
  }

  if (typeof value.draft.id !== 'string') return false
  if (value.draft.status === 'outcome_uncertain') return true
  if (value.draft.status !== 'sent') return false
  if (value.draft.alreadySent === true) return true

  return (
    isRecord(value.data) &&
    isRecord(value.data.message) &&
    typeof value.data.message.id === 'string' &&
    typeof value.data.message.text === 'string' &&
    value.data.message.status === 'sent' &&
    isDateString(value.data.message.createdAt)
  )
}

function isConversationResponseModeResponse(value: unknown): value is ConversationResponseModeResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isRecord(value.conversation) &&
    typeof value.conversation.id === 'string' &&
    isConversationResponseMode(value.conversation.responseMode)
  )
}

function isConversationResponseModeGetResponse(value: unknown): value is ConversationResponseModeGetResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    isRecord(value.conversation) &&
    typeof value.conversation.id === 'string' &&
    isConversationResponseMode(value.conversation.responseMode)
  )
}

function isConversationResponseMode(value: unknown): value is ConversationResponseMode {
  return value === 'human' || value === 'ai' || value === 'ai_draft' || value === 'ai_automatic'
}

const aiReplyEscalationCategories: readonly AiReplyEscalationCategory[] = [
  'needs_owner_review',
  'unsupported_information',
  'ambiguous_request',
  'missing_business_information',
  'policy_conflict',
  'invalid_or_empty_response',
]

const aiReplyEscalationReasonCodes: readonly AiReplyEscalationReasonCode[] = [
  'automatic_replies_disabled',
  'source_message_unavailable',
  'conversation_mode_mismatch',
  'stale_control_version',
  'stale_policy_version',
  'business_evidence_unavailable',
  'evidence_incomplete',
  'faq_not_exact',
  'faq_answers_conflict',
  'catalog_intent_unsupported',
  'catalog_item_missing',
  'catalog_item_ambiguous',
  'catalog_price_missing',
  'faq_exact_answer',
  'catalog_price_response',
  'catalog_listing_response',
  'generated_response_mismatch',
  'generated_response_invalid',
  'provider_generation_failed',
  'validation_failed',
]

const aiReplyEscalationStatuses: readonly AiReplyEscalationStatus[] = ['open', 'resolved', 'dismissed']

function isAiEscalationConversation(value: unknown): value is AiEscalationConversation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.status !== 'open' && value.status !== 'closed')
  ) {
    return false
  }
  if (value.customer === null) return true
  return (
    isRecord(value.customer) &&
    (value.customer.profileName === undefined || typeof value.customer.profileName === 'string') &&
    (value.customer.phoneNumber === undefined || typeof value.customer.phoneNumber === 'string')
  )
}

function isAiEscalationInboundMessage(value: unknown): value is AiEscalationInboundMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    (value.timestamp === undefined || isDateString(value.timestamp)) &&
    isDateString(value.createdAt)
  )
}

function isAiEscalationEvidence(value: unknown): value is AiEscalationEvidence {
  return (
    isRecord(value) &&
    (value.kind === 'faq' || value.kind === 'catalog_item') &&
    typeof value.recordId === 'string' &&
    (value.label === undefined || typeof value.label === 'string')
  )
}

function isOptionalNonNegativeInt(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function isAiReplyEscalation(value: unknown): value is AiReplyEscalation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.conversationId === 'string' &&
    (value.conversation === null || isAiEscalationConversation(value.conversation)) &&
    (value.inboundMessage === null || isAiEscalationInboundMessage(value.inboundMessage)) &&
    aiReplyEscalationCategories.includes(value.category as AiReplyEscalationCategory) &&
    aiReplyEscalationReasonCodes.includes(value.reasonCode as AiReplyEscalationReasonCode) &&
    (value.policyVersion === undefined || typeof value.policyVersion === 'string') &&
    (value.expectedPolicyVersion === undefined || typeof value.expectedPolicyVersion === 'string') &&
    isOptionalNonNegativeInt(value.controlVersion) &&
    isOptionalNonNegativeInt(value.expectedControlVersion) &&
    aiReplyEscalationStatuses.includes(value.status as AiReplyEscalationStatus) &&
    (value.resolvedAt === undefined || isDateString(value.resolvedAt)) &&
    (value.resolutionNote === undefined || typeof value.resolutionNote === 'string') &&
    isDateString(value.createdAt) &&
    isDateString(value.updatedAt)
  )
}

function isAiReplyEscalationDetail(value: unknown): value is AiReplyEscalationDetail {
  if (!isAiReplyEscalation(value)) return false
  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.evidence) && candidate.evidence.every(isAiEscalationEvidence)
}

function isAiEscalationCounts(value: unknown): value is AiEscalationCounts {
  return (
    isRecord(value) &&
    typeof value.pending === 'number' &&
    Number.isSafeInteger(value.pending) &&
    value.pending >= 0 &&
    typeof value.resolved === 'number' &&
    Number.isSafeInteger(value.resolved) &&
    value.resolved >= 0 &&
    typeof value.dismissed === 'number' &&
    Number.isSafeInteger(value.dismissed) &&
    value.dismissed >= 0 &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0
  )
}

function isAiEscalationsResponse(value: unknown): value is AiEscalationsResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    Array.isArray(value.escalations) &&
    value.escalations.every(isAiReplyEscalation) &&
    isAiEscalationCounts(value.counts) &&
    isCatalogPagination(value.pagination)
  )
}

function isAiEscalationResponse(value: unknown): value is AiEscalationResponse {
  return isRecord(value) && value.success === true && isAiReplyEscalationDetail(value.escalation)
}

function isAiEscalationResolutionResponse(value: unknown): value is AiEscalationResolutionResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.message === 'string' &&
    isRecord(value.escalation) &&
    typeof value.escalation.id === 'string' &&
    (value.escalation.status === 'resolved' || value.escalation.status === 'dismissed') &&
    isDateString(value.escalation.resolvedAt) &&
    (value.escalation.resolutionNote === undefined || typeof value.escalation.resolutionNote === 'string')
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

export function getBusinessAiSettings(): Promise<BusinessAiSettingsResponse> {
  return requestJson('/business/ai-settings', isBusinessAiSettingsResponse, {}, true)
}

export function updateBusinessAiSettings(
  data: BusinessAiSettingsUpdate,
): Promise<BusinessAiSettingsUpdateResponse> {
  return requestJson(
    '/business/ai-settings',
    isBusinessAiSettingsUpdateResponse,
    { method: 'PATCH', body: JSON.stringify(data) },
    true,
  )
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

export function getBusinessWhatsAppSettings(): Promise<BusinessWhatsAppSettingsResponse> {
  return requestJson('/business/whatsapp', isBusinessWhatsAppSettingsResponse, {}, true)
}

export function updateBusinessWhatsAppSettings(
  data: BusinessWhatsAppSettingsUpdate,
): Promise<BusinessWhatsAppSettingsResponse> {
  return requestJson(
    '/business/whatsapp',
    isBusinessWhatsAppSettingsResponse,
    { method: 'PATCH', body: JSON.stringify(data) },
    true,
  )
}

export function verifyBusinessWhatsAppSettings(): Promise<BusinessWhatsAppVerificationResponse> {
  return requestJson(
    '/business/whatsapp/verify',
    (value): value is BusinessWhatsAppVerificationResponse =>
      isRecord(value) && value.success === true && typeof value.message === 'string' && isBusinessWhatsAppSettings(value.whatsapp),
    { method: 'POST', body: JSON.stringify({}) },
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

export function getConversations(
  filters: ConversationFilters = {},
): Promise<ConversationListResponse> {
  const path = buildQuery('/conversations', {
    page: filters.page,
    limit: filters.limit,
  })
  return requestJson(path, isConversationListResponse, {}, true)
}

export function getConversationMessages(
  conversationId: string,
  filters: ConversationFilters = {},
): Promise<ConversationMessagesResponse> {
  const path = buildQuery(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    page: filters.page,
    limit: filters.limit,
  })
  return requestJson(path, isConversationMessagesResponse, {}, true)
}

export function sendConversationMessage(
  conversationId: string,
  text: string,
): Promise<SendConversationMessageResponse> {
  return requestJson(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    isSendConversationMessageResponse,
    { method: 'POST', body: JSON.stringify({ text }) },
    true,
  )
}

export function getAiDrafts(filters: AiDraftFilters = {}): Promise<AiDraftsResponse> {
  const path = buildQuery('/ai-drafts', {
    page: filters.page,
    limit: filters.limit,
    status: filters.status,
  })
  return requestJson(path, isAiDraftsResponse, {}, true)
}

export function getAiDraft(id: string): Promise<AiDraftResponse> {
  return requestJson(`/ai-drafts/${encodeURIComponent(id)}`, isAiDraftResponse, {}, true)
}

export function getConversationAiDrafts(
  conversationId: string,
  filters: AiDraftFilters = {},
): Promise<AiDraftsResponse> {
  const path = buildQuery(`/conversations/${encodeURIComponent(conversationId)}/ai-drafts`, {
    page: filters.page,
    limit: filters.limit,
    status: filters.status,
  })
  return requestJson(path, isAiDraftsResponse, {}, true)
}

export function approveAiDraft(
  id: string,
  approvedText?: string,
): Promise<AiDraftApprovalResponse> {
  return requestJson(
    `/ai-drafts/${encodeURIComponent(id)}/approve`,
    isAiDraftApprovalResponse,
    {
      method: 'POST',
      body: JSON.stringify(approvedText === undefined ? {} : { approvedText }),
    },
    true,
  )
}

export function rejectAiDraft(
  id: string,
  reason?: string,
): Promise<AiDraftRejectionResponse> {
  return requestJson(
    `/ai-drafts/${encodeURIComponent(id)}/reject`,
    isAiDraftRejectionResponse,
    { method: 'POST', body: JSON.stringify(reason === undefined ? {} : { reason }) },
    true,
  )
}

export function sendApprovedAiDraft(id: string): Promise<AiDraftSendResponse> {
  return requestJson(
    `/ai-drafts/${encodeURIComponent(id)}/send`,
    isAiDraftSendResponse,
    { method: 'POST', body: JSON.stringify({}) },
    true,
  )
}

export function updateConversationResponseMode(
  conversationId: string,
  responseMode: ConversationResponseMode,
): Promise<ConversationResponseModeResponse> {
  return requestJson(
    `/conversations/${encodeURIComponent(conversationId)}/response-mode`,
    isConversationResponseModeResponse,
    { method: 'PATCH', body: JSON.stringify({ responseMode }) },
    true,
  )
}

export function getConversationResponseMode(
  conversationId: string,
): Promise<ConversationResponseModeGetResponse> {
  return requestJson(
    `/conversations/${encodeURIComponent(conversationId)}/response-mode`,
    isConversationResponseModeGetResponse,
    {},
    true,
  )
}

export function getAiEscalations(filters: AiEscalationFilters = {}): Promise<AiEscalationsResponse> {
  const path = buildQuery('/ai-escalations', {
    page: filters.page,
    limit: filters.limit,
    status: filters.status,
  })
  return requestJson(path, isAiEscalationsResponse, {}, true)
}

export function getAiEscalation(id: string): Promise<AiEscalationResponse> {
  return requestJson(`/ai-escalations/${encodeURIComponent(id)}`, isAiEscalationResponse, {}, true)
}

export function resolveAiEscalation(
  id: string,
  input: { outcome?: AiReplyEscalationResolutionOutcome; note?: string } = {},
): Promise<AiEscalationResolutionResponse> {
  const note = input.note?.trim()
  return requestJson(
    `/ai-escalations/${encodeURIComponent(id)}/resolve`,
    isAiEscalationResolutionResponse,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(note ? { note } : {}),
      }),
    },
    true,
  )
}
