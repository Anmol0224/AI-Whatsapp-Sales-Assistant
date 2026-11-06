import test from 'node:test'
import assert from 'node:assert/strict'
import { Types } from 'mongoose'
import { createAiAutomaticReplyProcessor } from '../dist/services/ai-automatic-reply-processor.service.js'
import { GeminiServiceError } from '../dist/services/gemini.service.js'
import { createAutomaticReplySafetyService } from '../dist/services/automatic-reply-safety.service.js'

const ids = {
  businessId: new Types.ObjectId(),
  conversationId: new Types.ObjectId(),
  inboundMessageId: new Types.ObjectId(),
  jobId: new Types.ObjectId(),
}
const now = new Date('2026-11-06T12:00:00.000Z')
const policyVersion = 'policy-v1'
const leaseExpiresAt = new Date(now.getTime() + 60_000)
const eligible = {
  decision: 'safe_to_auto_reply',
  reasonCode: 'faq_exact_answer',
  evidence: [{ kind: 'faq', recordId: new Types.ObjectId().toString() }],
  policyVersion,
  expectedPolicyVersion: policyVersion,
  controlVersion: 2,
  expectedControlVersion: 2,
  safeReplyText: 'Returns are accepted within 14 days.',
}

function job(overrides = {}) {
  return {
    _id: ids.jobId,
    businessId: ids.businessId,
    conversationId: ids.conversationId,
    inboundMessageId: ids.inboundMessageId,
    workflow: 'ai_automatic',
    status: 'queued',
    attemptCount: 1,
    leaseExpiresAt,
    automaticPolicyVersion: policyVersion,
    workflowControlVersion: 2,
    ...overrides,
  }
}

function fixture(overrides = {}) {
  const calls = { eligibility: [], context: 0, generation: [], validation: [], persistence: [], escalations: [], finish: [], retry: [], failed: [], send: [] }
  const dependencies = {
    contextService: { async retrieve(input) { calls.context += 1; return { status: 'ready', context: {}, serializedBytes: 1 } } },
    promptBuilder() { return { status: 'ready', request: { prompt: 'synthetic' }, promptBytes: 1 } },
    generator: { async generateText(request) { calls.generation.push(request); return { text: eligible.safeReplyText } } },
    checkEligibility: async (input) => { calls.eligibility.push(input); return { eligible: true, validation: { ...eligible, safeReplyText: undefined } } },
    validate: async (input) => { calls.validation.push(input); return eligible },
    persistEscalation: async (input, validation) => { calls.escalations.push({ input, validation }); return 'created' },
    persist: async (input) => { calls.persistence.push(input); return { kind: 'ready', workflowControlVersion: 3 } },
    finish: async (input) => { calls.finish.push(input); return { status: input.status } },
    retry: async (...input) => { calls.retry.push(input); return { status: 'queued' } },
    fail: async (...input) => { calls.failed.push(input); return { status: 'failed' } },
    send: async (input) => { calls.send.push(input); return { kind: 'sent' } },
    isAutomaticSendEnabled: () => true,
    now: () => now,
    log() {},
    ...overrides,
  }
  return { processor: createAiAutomaticReplyProcessor(dependencies), calls }
}

test('safe validated reply persists only deterministic text and enters existing reservation/send orchestration', async () => {
  const { processor, calls } = fixture()
  assert.deepEqual(await processor.process(job()), { kind: 'sent' })
  assert.equal(calls.generation.length, 1)
  assert.equal(calls.persistence.length, 1)
  assert.equal(calls.persistence[0].safeReplyText, eligible.safeReplyText)
  assert.deepEqual(calls.persistence[0].evidence, eligible.evidence)
  assert.equal(calls.send.length, 1)
  assert.deepEqual(calls.send[0].workerLease, { attemptCount: 1, leaseExpiresAt })
  assert.equal(JSON.stringify(calls).includes('synthetic'), true)
})

test('real deterministic FAQ and catalog validator controls the exact text passed to persistence', async (context) => {
  await context.test('exact FAQ answer', async () => {
    const faqId = new Types.ObjectId()
    const inboundText = 'What is your return policy?'
    const answer = 'Returns are accepted within 14 days.'
    const safety = createAutomaticReplySafetyService({
      repository: {
        async findBusinessPolicy() { return { automaticRepliesEnabled: true, automaticRepliesPolicyVersion: policyVersion } },
        async findConversation() { return { _id: ids.conversationId, businessId: ids.businessId, responseMode: 'ai_automatic', aiControlVersion: 2 } },
        async findInboundMessage() { return { _id: ids.inboundMessageId, businessId: ids.businessId, conversationId: ids.conversationId, direction: 'inbound', messageType: 'text', text: inboundText } },
        async listActiveFaqs() { return [{ _id: faqId, businessId: ids.businessId, question: inboundText, answer, isActive: true }] },
        async listActiveCatalogItems() { return [] },
        async recordEscalation() { return { kind: 'not_found' } },
      },
      isAutomaticSendEnabled: () => true,
      log() {},
    })
    const calls = { persistence: [], send: [] }
    const processor = createAiAutomaticReplyProcessor({
      contextService: { async retrieve() { return { status: 'ready', context: {}, serializedBytes: 1 } } },
      promptBuilder() { return { status: 'ready', request: { prompt: 'safe prompt' }, promptBytes: 10 } },
      generator: { async generateText() { return { text: answer } } },
      checkEligibility: safety.checkEligibility,
      validate: safety.validate,
      persistEscalation: safety.persistEscalation,
      persist: async (input) => { calls.persistence.push(input); return { kind: 'ready', workflowControlVersion: 3 } },
      send: async (input) => { calls.send.push(input); return { kind: 'sent' } },
      now: () => now,
      log() {},
    })
    assert.deepEqual(await processor.process(job()), { kind: 'sent' })
    assert.equal(calls.persistence[0].safeReplyText, answer)
    assert.equal(calls.persistence[0].evidence[0].recordId, faqId.toString())
    assert.equal(calls.send.length, 1)
  })

  await context.test('deterministic catalog price answer', async () => {
    const itemId = new Types.ObjectId()
    const answer = 'The listed price for Widget is ₹12.99.'
    const safety = createAutomaticReplySafetyService({
      repository: {
        async findBusinessPolicy() { return { automaticRepliesEnabled: true, automaticRepliesPolicyVersion: policyVersion } },
        async findConversation() { return { _id: ids.conversationId, businessId: ids.businessId, responseMode: 'ai_automatic', aiControlVersion: 2 } },
        async findInboundMessage() { return { _id: ids.inboundMessageId, businessId: ids.businessId, conversationId: ids.conversationId, direction: 'inbound', messageType: 'text', text: 'How much is Widget?' } },
        async listActiveFaqs() { return [] },
        async listActiveCatalogItems() { return [{ _id: itemId, businessId: ids.businessId, kind: 'product', name: 'Widget', priceInPaise: 1299, currency: 'INR', isActive: true }] },
        async recordEscalation() { return { kind: 'not_found' } },
      },
      isAutomaticSendEnabled: () => true,
      log() {},
    })
    const persisted = []
    const processor = createAiAutomaticReplyProcessor({
      contextService: { async retrieve() { return { status: 'ready', context: {}, serializedBytes: 1 } } },
      promptBuilder() { return { status: 'ready', request: { prompt: 'safe prompt' }, promptBytes: 10 } },
      generator: { async generateText() { return { text: answer } } },
      checkEligibility: safety.checkEligibility,
      validate: safety.validate,
      persistEscalation: safety.persistEscalation,
      persist: async (input) => { persisted.push(input); return { kind: 'ready', workflowControlVersion: 3 } },
      send: async () => ({ kind: 'sent' }),
      now: () => now,
      log() {},
    })
    assert.deepEqual(await processor.process(job()), { kind: 'sent' })
    assert.equal(persisted[0].safeReplyText, answer)
    assert.equal(persisted[0].evidence[0].recordId, itemId.toString())
  })
})

test('ineligible Human-mode job is escalated and never retrieves context or calls Gemini', async () => {
  const validation = {
    decision: 'policy_conflict', reasonCode: 'conversation_mode_mismatch', evidence: [],
    expectedPolicyVersion: policyVersion, expectedControlVersion: 2,
  }
  const { processor, calls } = fixture({
    checkEligibility: async () => ({ eligible: false, validation }),
  })
  assert.deepEqual(await processor.process(job()), { kind: 'escalated' })
  assert.equal(calls.context, 0)
  assert.equal(calls.generation.length, 0)
  assert.equal(calls.persistence.length, 0)
  assert.equal(calls.send.length, 0)
  assert.equal(calls.escalations.length, 1)
  assert.equal(calls.finish[0].status, 'cancelled')
})

test('unsupported or ambiguous validator result is idempotently escalated without sending', async () => {
  const validation = {
    decision: 'needs_owner_review', reasonCode: 'catalog_intent_unsupported', evidence: [],
    policyVersion, expectedPolicyVersion: policyVersion, controlVersion: 2, expectedControlVersion: 2,
  }
  const { processor, calls } = fixture({ validate: async () => validation })
  assert.deepEqual(await processor.process(job()), { kind: 'escalated' })
  assert.equal(calls.persistence.length, 0)
  assert.equal(calls.send.length, 0)
  assert.equal(calls.escalations.length, 1)
  assert.equal(calls.finish[0].automaticSafetyDecision, 'unsupported')
})

test('Human takeover during generation is caught by the final validator before persistence', async () => {
  const validation = {
    decision: 'policy_conflict', reasonCode: 'conversation_mode_mismatch', evidence: [],
    policyVersion, expectedPolicyVersion: policyVersion, controlVersion: 3, expectedControlVersion: 2,
  }
  const { processor, calls } = fixture({ validate: async () => validation })
  assert.deepEqual(await processor.process(job()), { kind: 'escalated' })
  assert.equal(calls.generation.length, 1)
  assert.equal(calls.persistence.length, 0)
  assert.equal(calls.send.length, 0)
})

test('business opt-out, policy change and emergency gate shutdown stop before persistence or send', async (context) => {
  const blockedCases = [
    ['business opt-out during generation', 'automatic_replies_disabled'],
    ['policy changed during generation', 'stale_policy_version'],
    ['global gate disabled during generation', 'automatic_replies_disabled'],
  ]
  for (const [name, reasonCode] of blockedCases) {
    await context.test(name, async () => {
      const validation = {
        decision: 'policy_conflict', reasonCode, evidence: [],
        policyVersion, expectedPolicyVersion: policyVersion, controlVersion: 2, expectedControlVersion: 2,
      }
      const { processor, calls } = fixture({ validate: async () => validation })
      assert.deepEqual(await processor.process(job()), { kind: 'escalated' })
      assert.equal(calls.generation.length, 1)
      assert.equal(calls.persistence.length, 0)
      assert.equal(calls.send.length, 0)
      assert.equal(calls.finish[0].status, 'cancelled')
    })
  }
})

test('persisted automatic_ready reply resumes without a second Gemini call', async () => {
  const { processor, calls } = fixture()
  assert.deepEqual(await processor.process(job({
    status: 'automatic_ready',
    automaticReplyTextSnapshot: eligible.safeReplyText,
    automaticSafetyDecision: 'eligible',
  })), { kind: 'sent' })
  assert.equal(calls.context, 0)
  assert.equal(calls.generation.length, 0)
  assert.equal(calls.persistence.length, 0)
  assert.equal(calls.send.length, 1)
})

test('uncertain provider outcome is terminal and is never automatically retried', async () => {
  const { processor, calls } = fixture({ send: async (input) => { calls.send.push(input); return { kind: 'send_uncertain', jobId: ids.jobId.toString(), reason: 'provider_timeout' } } })
  assert.deepEqual(await processor.process(job()), { kind: 'send_uncertain' })
  assert.equal(calls.send.length, 1)
  assert.equal(calls.retry.length, 0)
  assert.equal(calls.generation.length, 1)
})

test('transient Gemini generation failure uses bounded existing retry schedule without sending', async () => {
  const { processor, calls } = fixture({ generator: { async generateText() { throw new GeminiServiceError('timeout') } } })
  const result = await processor.process(job())
  assert.equal(result.kind, 'retry_scheduled')
  assert.equal(result.nextAttemptAt.getTime(), now.getTime() + 1_000)
  assert.equal(calls.send.length, 0)
  assert.equal(calls.persistence.length, 0)
})

test('permanent Gemini failure is recorded safely and does not reach WhatsApp', async () => {
  const { processor, calls } = fixture({ generator: { async generateText() { throw new GeminiServiceError('authentication_failed') } } })
  assert.deepEqual(await processor.process(job({ attemptCount: 3 })), { kind: 'failed', errorCode: 'provider_unavailable' })
  assert.equal(calls.send.length, 0)
  assert.equal(calls.retry.length, 0)
  assert.equal(calls.escalations.length, 1)
  assert.equal(calls.escalations[0].validation.reasonCode, 'provider_generation_failed')
  assert.equal(calls.finish[0].status, 'failed')
})
