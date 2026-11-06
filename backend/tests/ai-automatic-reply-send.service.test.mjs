import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Types } from 'mongoose'
import { createAutomaticReplySendService } from '../dist/services/ai-automatic-reply-send.service.js'
import { WhatsAppCloudApiError } from '../dist/services/whatsapp-cloud-api.service.js'

const businessId = new Types.ObjectId()
const jobId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const validation = {
  decision: 'unsupported_information',
  reasonCode: 'generated_response_mismatch',
  evidence: [],
}
const reservation = {
  kind: 'reserved',
  sendAttemptId: '123e4567-e89b-42d3-a456-426614174000',
  automaticReplyText: 'The listed price for Blue Widget is ₹450.50.',
  conversationId,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  phoneNumberId: '1234567890',
  connectionStatus: 'configured_not_verified',
  recipientPhoneNumber: '919876543210',
}

function makeService(overrides = {}) {
  const calls = { reserve: 0, send: [], complete: 0, record: [], escalations: [] }
  const dependencies = {
    async reserve() { calls.reserve += 1; return reservation },
    async complete(input) { calls.complete += 1; return { kind: 'sent', message: { _id: jobId, text: reservation.automaticReplyText, createdAt: new Date() } } },
    async recordOutcome(input) { calls.record.push(input); return { kind: 'recorded' } },
    async sendText(business, recipient, text) {
      calls.send.push({ business, recipient, text })
      return { providerMessageId: 'wamid.safe-test-id' }
    },
    isProviderConfigured: () => true,
    isAutomaticSendEnabled: () => true,
    async persistEscalation(input, decision) { calls.escalations.push({ input, decision }); return 'created' },
    log() {},
    ...overrides,
  }
  return { send: createAutomaticReplySendService(dependencies), calls }
}

test('successful automatic send uses only the reserved deterministic response and waits for reservation commit', async () => {
  let reservationCommitted = false
  const { send, calls } = makeService({
    async reserve() {
      calls.reserve += 1
      reservationCommitted = true
      return reservation
    },
    async sendText(business, recipient, text) {
      assert.equal(reservationCommitted, true)
      calls.send.push({ business, recipient, text })
      return { providerMessageId: 'wamid.safe-test-id' }
    },
  })
  const result = await send({ businessId, jobId })
  assert.deepEqual(result, { kind: 'sent', jobId: jobId.toString(), providerMessageId: 'wamid.safe-test-id' })
  assert.equal(calls.send.length, 1)
  assert.equal(calls.send[0].text, reservation.automaticReplyText)
  assert.equal(calls.send[0].recipient, reservation.recipientPhoneNumber)
  assert.equal(calls.complete, 1)
})

test('definitive provider rejection is recorded as send_failed and never retried', async () => {
  const { send, calls } = makeService({
    async sendText() { calls.send.push('called'); throw new WhatsAppCloudApiError('provider_http_error', 400) },
  })
  const result = await send({ businessId, jobId })
  assert.equal(result.kind, 'send_failed')
  assert.equal(result.providerStatusCode, 400)
  assert.equal(calls.send.length, 1)
  assert.equal(calls.record[0].outcome, 'rejected')
})

for (const [name, error, expectedCode] of [
  ['timeout', new WhatsAppCloudApiError('provider_timeout'), 'provider_timeout'],
  ['network failure', new WhatsAppCloudApiError('provider_network_error'), 'provider_network_error'],
  ['provider 5xx', new WhatsAppCloudApiError('provider_http_error', 503), 'provider_unavailable'],
  ['malformed provider response', new WhatsAppCloudApiError('invalid_provider_response'), 'invalid_provider_response'],
]) {
  test(`${name} is recorded as uncertain and is not retried`, async () => {
    const { send, calls } = makeService({
      async sendText() { calls.send.push('called'); throw error },
    })
    const result = await send({ businessId, jobId })
    assert.equal(result.kind, 'send_uncertain')
    assert.equal(result.reason, expectedCode)
    assert.equal(calls.send.length, 1)
    assert.equal(calls.record[0].outcome, 'uncertain')
  })
}

test('provider acceptance followed by database completion failure becomes uncertain without another provider call', async () => {
  let status = 'automatic_ready'
  const { send, calls } = makeService({
    async reserve() {
      calls.reserve += 1
      if (status !== 'automatic_ready') return { kind: 'ineligible' }
      status = 'sending'
      return reservation
    },
    async sendText() {
      calls.send.push(reservation.automaticReplyText)
      return { providerMessageId: 'wamid.accepted' }
    },
    async complete() { calls.complete += 1; throw new Error('private database diagnostic') },
    async recordOutcome(input) {
      calls.record.push(input)
      status = 'send_uncertain'
      return { kind: 'recorded' }
    },
  })
  const first = await send({ businessId, jobId })
  assert.equal(first.kind, 'send_uncertain')
  assert.equal(first.reason, 'persistence_unavailable')
  const second = await send({ businessId, jobId })
  assert.equal(second.kind, 'ineligible')
  assert.equal(calls.send.length, 1)
})

test('already-sent, in-progress, ineligible and not-configured jobs never call the provider', async (context) => {
  for (const result of [
    { kind: 'already_sent' },
    { kind: 'in_progress' },
    { kind: 'ineligible' },
    { kind: 'not_configured' },
    { kind: 'not_found' },
  ]) {
    await context.test(result.kind, async () => {
      const { send, calls } = makeService({ async reserve() { calls.reserve += 1; return result } })
      await send({ businessId, jobId })
      assert.equal(calls.send.length, 0)
    })
  }
})

test('unsafe validation result is escalated idempotently and never sent', async () => {
  const { send, calls } = makeService({
    async reserve() {
      return { kind: 'safety_rejected', validation, conversationId, inboundMessageId }
    },
  })
  const result = await send({ businessId, jobId })
  assert.equal(result.kind, 'escalated')
  assert.equal(result.escalation, 'created')
  assert.equal(calls.escalations.length, 1)
  assert.equal(calls.send.length, 0)
})

test('missing provider configuration prevents reservation and send', async () => {
  const { send, calls } = makeService({ isProviderConfigured: () => false })
  assert.deepEqual(await send({ businessId, jobId }), { kind: 'not_configured' })
  assert.equal(calls.reserve, 0)
  assert.equal(calls.send.length, 0)
})
