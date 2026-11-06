import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { WhatsAppCloudApiError } from '../dist/services/whatsapp-cloud-api.service.js'
import { createAiReplySendService } from '../dist/services/ai-reply-send.service.js'

const businessId = new Types.ObjectId()
const ownerUserId = new Types.ObjectId()
const draftId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const customerId = new Types.ObjectId()
const approvedText = 'Approved owner-reviewed reply'
const sendInput = { businessId, ownerUserId, draftId }

function makeDependencies(overrides = {}) {
  const state = {
    job: {
      conversationId,
      status: 'approved',
      approvedText,
      approvedControlVersion: 7,
      outboundMessageId: undefined,
    },
    conversation: {
      customerId,
      responseMode: 'ai',
      aiControlVersion: 7,
      activeAiSendJobId: undefined,
    },
    customer: { phoneNumber: '919876543210' },
    business: {
      ownerUserId,
      whatsapp: { phoneNumberId: '1234567890', connectionStatus: 'configured_not_verified' },
    },
    calls: [],
    message: {
      _id: new Types.ObjectId(),
      text: approvedText,
      status: 'sent',
      createdAt: new Date('2026-11-02T12:00:00.000Z'),
    },
  }

  const dependencies = {
    async findJob(requestBusinessId, requestDraftId) {
      if (overrides.findJob) return overrides.findJob(requestBusinessId, requestDraftId)
      assert.equal(requestBusinessId.toString(), businessId.toString())
      assert.equal(requestDraftId.toString(), draftId.toString())
      return state.job ? { ...state.job } : null
    },
    async findConversation(requestConversationId, requestBusinessId) {
      if (overrides.findConversation) return overrides.findConversation(requestConversationId, requestBusinessId)
      assert.equal(requestConversationId.toString(), conversationId.toString())
      assert.equal(requestBusinessId.toString(), businessId.toString())
      return state.conversation ? { ...state.conversation } : null
    },
    async findCustomer(requestCustomerId, requestBusinessId) {
      if (overrides.findCustomer) return overrides.findCustomer(requestCustomerId, requestBusinessId)
      assert.equal(requestCustomerId.toString(), customerId.toString())
      assert.equal(requestBusinessId.toString(), businessId.toString())
      return state.customer
    },
    async findBusiness(requestBusinessId, requestOwnerId) {
      if (overrides.findBusiness) return overrides.findBusiness(requestBusinessId, requestOwnerId)
      assert.equal(requestBusinessId.toString(), businessId.toString())
      assert.equal(requestOwnerId.toString(), ownerUserId.toString())
      return state.business
    },
    async reserve(input) {
      state.calls.push(['reserve', input])
      if (overrides.reserve) return overrides.reserve(input)
      state.job.status = 'sending'
      state.conversation.activeAiSendJobId = draftId
      return {
        kind: 'reserved',
        sendAttemptId: 'attempt-12345678-1234-4234-8234-123456789abc',
        approvedText,
        conversationId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    async complete(input) {
      state.calls.push(['complete', input])
      if (overrides.complete) return overrides.complete(input)
      state.job.status = 'sent'
      state.job.outboundMessageId = state.message._id
      return { kind: 'sent', message: state.message }
    },
    async recordOutcome(input) {
      state.calls.push(['recordOutcome', input])
      if (overrides.recordOutcome) return overrides.recordOutcome(input)
      state.job.status = input.outcome === 'rejected' ? 'send_failed' : 'send_uncertain'
      state.conversation.activeAiSendJobId = undefined
      return { kind: 'recorded' }
    },
    async sendText(business, phoneNumber, text) {
      state.calls.push(['sendText', { phoneNumber, text }])
      if (overrides.sendText) return overrides.sendText(business, phoneNumber, text)
      return { providerMessageId: 'wamid.safe-test-id' }
    },
    isProviderConfigured() {
      if (overrides.isProviderConfigured) return overrides.isProviderConfigured()
      return true
    },
  }

  return { dependencies, state }
}

test('successful send uses approved text and completes one outbound message', async () => {
  const { dependencies, state } = makeDependencies()
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.equal(result.kind, 'sent')
  assert.equal(result.message.text, approvedText)
  assert.equal(result.message.status, 'sent')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
  assert.equal(state.calls.filter(([kind]) => kind === 'complete').length, 1)
  assert.equal(state.calls.find(([kind]) => kind === 'sendText')[1].text, approvedText)
  assert.equal(state.calls.findIndex(([kind]) => kind === 'reserve') < state.calls.findIndex(([kind]) => kind === 'sendText'), true)
})

test('definitive provider rejection records send_failed without returning provider details', async () => {
  const { dependencies, state } = makeDependencies({
    async sendText() { throw new WhatsAppCloudApiError('provider_http_error', 400) },
  })
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.deepEqual(result, {
    kind: 'send_failed',
    draftId: draftId.toString(),
    errorCode: 'provider_rejected',
    providerStatusCode: 400,
  })
  assert.equal(state.job.status, 'send_failed')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
  assert.equal(state.calls.filter(([kind]) => kind === 'recordOutcome').length, 1)
})

test('timeout, network, 5xx, and malformed responses become uncertain without retry', async (context) => {
  const cases = [
    [new WhatsAppCloudApiError('provider_timeout'), 'provider_timeout'],
    [new WhatsAppCloudApiError('provider_network_error'), 'provider_network_error'],
    [new WhatsAppCloudApiError('provider_http_error', 503), 'provider_unavailable'],
    [new WhatsAppCloudApiError('invalid_provider_response'), 'invalid_provider_response'],
  ]

  for (const [providerError, errorCode] of cases) {
    await context.test(errorCode, async () => {
      const { dependencies, state } = makeDependencies({
        async sendText() { throw providerError },
      })
      const result = await createAiReplySendService(dependencies)(sendInput)

      assert.equal(result.kind, 'outcome_uncertain')
      assert.equal(result.errorCode, errorCode)
      assert.equal(state.job.status, 'send_uncertain')
      assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
      assert.equal(state.calls.filter(([kind]) => kind === 'recordOutcome').length, 1)
      assert.equal(state.calls.filter(([kind]) => kind === 'complete').length, 0)
    })
  }
})

test('provider acceptance followed by completion failure is uncertain and never resends', async () => {
  const { dependencies, state } = makeDependencies({
    async complete() { throw new Error('private database details') },
  })
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.deepEqual(result, {
    kind: 'outcome_uncertain',
    draftId: draftId.toString(),
    errorCode: 'persistence_unavailable',
  })
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
  assert.equal(state.calls.filter(([kind]) => kind === 'recordOutcome').length, 1)
  assert.equal(state.calls.find(([kind]) => kind === 'recordOutcome')[1].providerMessageId, 'wamid.safe-test-id')
})

test('concurrent duplicate send requests reserve at most once and call provider once', async () => {
  let providerStarted
  let releaseProvider
  const started = new Promise((resolve) => { providerStarted = resolve })
  const blocked = new Promise((resolve) => { releaseProvider = resolve })
  let reserved = false
  const { dependencies, state } = makeDependencies({
    async reserve() {
      if (reserved) return { kind: 'conflict' }
      reserved = true
      state.job.status = 'sending'
      state.conversation.activeAiSendJobId = draftId
      return {
        kind: 'reserved',
        sendAttemptId: 'attempt-12345678-1234-4234-8234-123456789abc',
        approvedText,
        conversationId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    async sendText() {
      providerStarted()
      await blocked
      return { providerMessageId: 'wamid.safe-test-id' }
    },
  })
  const service = createAiReplySendService(dependencies)
  const firstSend = service(sendInput)
  await started
  const duplicate = await service(sendInput)
  assert.equal(duplicate.kind, 'conflict')
  releaseProvider()
  const first = await firstSend

  assert.equal(first.kind, 'sent')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
})

test('already-sent drafts return already_sent without provider calls', async () => {
  const { dependencies, state } = makeDependencies()
  state.job.status = 'sent'
  state.job.outboundMessageId = new Types.ObjectId()
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.deepEqual(result, { kind: 'already_sent', draftId: draftId.toString() })
  assert.equal(state.calls.length, 0)
})

test('owner-approved draft sending remains available in ai_draft mode', async () => {
  const { dependencies, state } = makeDependencies()
  state.conversation.responseMode = 'ai_draft'
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.equal(result.kind, 'sent')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
})

test('an uncertain draft cannot trigger a second provider call', async () => {
  const { dependencies, state } = makeDependencies()
  state.job.status = 'send_uncertain'
  const service = createAiReplySendService(dependencies)

  const firstRequest = await service(sendInput)
  const laterRequest = await service(sendInput)

  assert.equal(firstRequest.kind, 'conflict')
  assert.equal(laterRequest.kind, 'conflict')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 0)
})

test('unapproved, Human-mode, stale, unconfigured, and inaccessible records block sending', async (context) => {
  const cases = [
    ['unapproved draft', { job: { status: 'draft_ready' } }, { kind: 'conflict', reason: 'not_approved' }],
    ['rejected draft', { job: { status: 'rejected' } }, { kind: 'conflict', reason: 'not_approved' }],
    ['Human mode', { conversation: { responseMode: 'human' } }, { kind: 'conflict', reason: 'mode_changed' }],
    ['Automatic mode is not an approved draft mode', { conversation: { responseMode: 'ai_automatic' } }, { kind: 'conflict', reason: 'mode_changed' }],
    ['stale approval', { conversation: { aiControlVersion: 8 } }, { kind: 'conflict', reason: 'stale_approval' }],
    ['missing WhatsApp configuration', { providerConfigured: false }, { kind: 'not_configured' }],
    ['missing phone number ID', { business: { whatsapp: { phoneNumberId: undefined } } }, { kind: 'not_configured' }],
    ['missing customer', { customer: null }, { kind: 'not_found' }],
    ['missing owner business', { business: null }, { kind: 'not_found' }],
  ]

  for (const [label, scenario, expected] of cases) {
    await context.test(label, async () => {
      const overrides = {}
      const { dependencies, state } = makeDependencies({
        ...overrides,
        ...(scenario.job ? { async findJob() { return { ...state.job, ...scenario.job } } } : {}),
        ...(scenario.conversation ? {
          async findConversation() { return { ...state.conversation, ...scenario.conversation } },
        } : {}),
        ...(scenario.providerConfigured === false ? { isProviderConfigured() { return false } } : {}),
        ...(Object.hasOwn(scenario, 'customer') ? { async findCustomer() { return scenario.customer } } : {}),
        ...(Object.hasOwn(scenario, 'business') ? {
          async findBusiness() {
            if (scenario.business && scenario.business.whatsapp) {
              return { ...state.business, whatsapp: scenario.business.whatsapp }
            }
            return scenario.business
          },
        } : {}),
      })
      const result = await createAiReplySendService(dependencies)(sendInput)
      assert.deepEqual(result, expected)
      assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 0)
      assert.equal(state.calls.filter(([kind]) => kind === 'reserve').length, 0)
    })
  }
})

test('provider is called only after repository reservation has resolved', async () => {
  let reservationCommitted = false
  const { dependencies } = makeDependencies({
    async reserve() {
      reservationCommitted = true
      return {
        kind: 'reserved',
        sendAttemptId: 'attempt-12345678-1234-4234-8234-123456789abc',
        approvedText,
        conversationId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    async sendText(_business, _phone, text) {
      assert.equal(reservationCommitted, true)
      assert.equal(text, approvedText)
      return { providerMessageId: 'wamid.safe-test-id' }
    },
  })

  assert.equal((await createAiReplySendService(dependencies)(sendInput)).kind, 'sent')
})

test('failure to record a provider outcome leaves the attempt uncertain and is not retried', async () => {
  const { dependencies, state } = makeDependencies({
    async sendText() { throw new WhatsAppCloudApiError('provider_timeout') },
    async recordOutcome() { throw new Error('private database details') },
  })
  const result = await createAiReplySendService(dependencies)(sendInput)

  assert.equal(result.kind, 'outcome_uncertain')
  assert.equal(result.errorCode, 'persistence_unavailable')
  assert.equal(state.calls.filter(([kind]) => kind === 'sendText').length, 1)
})
