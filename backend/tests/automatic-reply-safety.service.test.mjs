import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose, { Types } from 'mongoose'
import { AiReplyEscalation } from '../dist/models/ai-reply-escalation.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Message } from '../dist/models/message.model.js'
import { logAiPipelineTiming } from '../dist/services/ai-pipeline-telemetry.js'
import {
  createAutomaticReplySafetyService,
  recordAutomaticReplyEscalation,
} from '../dist/services/automatic-reply-safety.service.js'

const businessId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const faqId = new Types.ObjectId()
const catalogId = new Types.ObjectId()
const policyVersion = 'policy-v1'
const controlVersion = 12

function baseState(overrides = {}) {
  return {
    policy: { automaticRepliesEnabled: true, automaticRepliesPolicyVersion: policyVersion },
    conversation: {
      _id: conversationId, businessId, responseMode: 'ai_automatic', aiControlVersion: controlVersion,
    },
    inbound: {
      _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text',
      text: 'What is your return policy?',
    },
    faqs: [{
      _id: faqId, businessId, question: 'What is your return policy?', answer: 'Returns are accepted within 14 days.', isActive: true,
    }],
    catalog: [],
    escalations: new Map(),
    ...overrides,
  }
}

function makeService(state = baseState(), options = {}) {
  const logs = []
  const repository = {
    async findBusinessPolicy(id) {
      assert.equal(id.toString(), businessId.toString())
      return state.policy
    },
    async findConversation(id, conversation) {
      assert.equal(id.toString(), businessId.toString())
      assert.equal(conversation.toString(), conversationId.toString())
      return state.conversation
    },
    async findInboundMessage(input) {
      assert.equal(input.businessId.toString(), businessId.toString())
      assert.equal(input.conversationId.toString(), conversationId.toString())
      assert.equal(input.inboundMessageId.toString(), inboundMessageId.toString())
      return state.inbound
    },
    async listActiveFaqs(id, limit) {
      assert.equal(id.toString(), businessId.toString())
      assert.equal(limit, 21)
      if (options.faqFailure) throw new Error('private database error')
      return state.faqs
    },
    async listActiveCatalogItems(id, limit) {
      assert.equal(id.toString(), businessId.toString())
      assert.equal(limit, 31)
      return state.catalog
    },
    async recordEscalation(input) {
      assert.equal(input.businessId.toString(), businessId.toString())
      assert.equal(input.conversationId.toString(), conversationId.toString())
      assert.equal(input.inboundMessageId.toString(), inboundMessageId.toString())
      const key = `${input.businessId}:${input.inboundMessageId}`
      const existing = state.escalations.get(key)
      if (existing) return { kind: 'exists', escalationId: existing._id }
      const escalation = { ...input, _id: new Types.ObjectId(), status: 'open', createdAt: new Date() }
      state.escalations.set(key, escalation)
      return { kind: 'created', escalationId: escalation._id }
    },
  }
  const service = createAutomaticReplySafetyService({
    repository,
    isAutomaticSendEnabled: () => options.globalEnabled !== false,
    log(event) { logs.push(event) },
  })
  return { service, logs, state }
}

function input(generatedResponse, overrides = {}) {
  return {
    businessId,
    conversationId,
    inboundMessageId,
    expectedPolicyVersion: policyVersion,
    expectedControlVersion: controlVersion,
    generatedResponse,
    ...overrides,
  }
}

test('exact active FAQ answer is authorized and carries its evidence and policy fence', async () => {
  const { service, logs } = makeService()
  const result = await service.validate(input('Returns are accepted within 14 days.'))
  assert.equal(result.decision, 'safe_to_auto_reply')
  assert.equal(result.reasonCode, 'faq_exact_answer')
  assert.equal(result.safeReplyText, 'Returns are accepted within 14 days.')
  assert.deepEqual(result.evidence, [{ kind: 'faq', recordId: faqId.toString() }])
  assert.equal(result.policyVersion, policyVersion)
  assert.equal(result.controlVersion, controlVersion)
  assert.equal(logs[0].event, 'ai_pipeline.automatic_reply_validation')
  assert.equal(logs[0].outcome, 'safe_to_auto_reply')
})

test('FAQ response that differs from the exact answer is unsupported', async () => {
  const { service } = makeService()
  const result = await service.validate(input('Returns are accepted within 30 days.'))
  assert.equal(result.decision, 'unsupported_information')
  assert.equal(result.reasonCode, 'generated_response_mismatch')
  assert.equal(result.safeReplyText, undefined)
})

test('catalog price response is deterministic and uses integer paise from active data', async () => {
  const state = baseState({
    inbound: { _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text', text: 'Price of Blue Widget?' },
    faqs: [],
    catalog: [{
      _id: catalogId, businessId, kind: 'product', name: 'Blue Widget', priceInPaise: 45050, currency: 'INR', isActive: true,
    }],
  })
  const { service } = makeService(state)
  const result = await service.validate(input('The listed price for Blue Widget is ₹450.50.'))
  assert.equal(result.decision, 'safe_to_auto_reply')
  assert.equal(result.reasonCode, 'catalog_price_response')
  assert.equal(result.safeReplyText, 'The listed price for Blue Widget is ₹450.50.')
  assert.deepEqual(result.evidence, [{ kind: 'catalog_item', recordId: catalogId.toString() }])
})

test('catalog listing is deterministically derived from current active items', async () => {
  const secondCatalogId = new Types.ObjectId()
  const state = baseState({
    inbound: { _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text', text: 'What do you sell?' },
    faqs: [],
    catalog: [
      { _id: secondCatalogId, businessId, kind: 'service', name: 'Setup', isActive: true },
      { _id: catalogId, businessId, kind: 'product', name: 'Blue Widget', isActive: true },
    ],
  })
  const { service } = makeService(state)
  const expected = 'Our active catalogue includes: Blue Widget, Setup.'
  const result = await service.validate(input(expected))
  assert.equal(result.decision, 'safe_to_auto_reply')
  assert.equal(result.safeReplyText, expected)
  assert.equal(result.evidence.length, 2)
})

test('unsupported questions are escalated for owner review', async () => {
  const state = baseState({
    inbound: {
      _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text',
      text: 'Can you guarantee delivery tomorrow?',
    },
  })
  const { service } = makeService(state)
  const result = await service.validate(input('We deliver tomorrow for free.'))
  assert.equal(result.decision, 'needs_owner_review')
  assert.equal(result.reasonCode, 'catalog_intent_unsupported')
})

test('ambiguous catalog names and conflicting exact FAQs fail closed', async (context) => {
  await context.test('duplicate catalog item name', async () => {
    const duplicateId = new Types.ObjectId()
    const state = baseState({
      inbound: { _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text', text: 'Price of Blue Widget?' },
      faqs: [],
      catalog: [
        { _id: catalogId, businessId, kind: 'product', name: 'Blue Widget', priceInPaise: 100, currency: 'INR', isActive: true },
        { _id: duplicateId, businessId, kind: 'service', name: 'Blue Widget', priceInPaise: 200, currency: 'INR', isActive: true },
      ],
    })
    const { service } = makeService(state)
    const result = await service.validate(input('The listed price for Blue Widget is ₹1.00.'))
    assert.equal(result.decision, 'ambiguous_request')
    assert.equal(result.reasonCode, 'catalog_item_ambiguous')
  })

  await context.test('conflicting FAQ answers', async () => {
    const conflictingFaqId = new Types.ObjectId()
    const state = baseState({ faqs: [
      { _id: faqId, businessId, question: 'What is your return policy?', answer: 'Returns in 14 days.', isActive: true },
      { _id: conflictingFaqId, businessId, question: 'What is your return policy?', answer: 'No returns.', isActive: true },
    ] })
    const { service } = makeService(state)
    const result = await service.validate(input('Returns in 14 days.'))
    assert.equal(result.decision, 'policy_conflict')
    assert.equal(result.reasonCode, 'faq_answers_conflict')
  })
})

test('missing catalog price, inactive records, and incomplete evidence do not authorize replies', async (context) => {
  await context.test('price missing', async () => {
    const state = baseState({
      inbound: { _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text', text: 'Price of Blue Widget?' },
      faqs: [],
      catalog: [{ _id: catalogId, businessId, kind: 'product', name: 'Blue Widget', isActive: true }],
    })
    const { service } = makeService(state)
    const result = await service.validate(input('The listed price for Blue Widget is ₹5.00.'))
    assert.equal(result.decision, 'missing_business_information')
    assert.equal(result.reasonCode, 'catalog_price_missing')
  })

  await context.test('inactive FAQ and catalog evidence are ignored', async () => {
    const state = baseState({
      faqs: [{ _id: faqId, businessId, question: 'What is your return policy?', answer: 'Returns in 14 days.', isActive: false }],
      catalog: [{ _id: catalogId, businessId, kind: 'product', name: 'Blue Widget', priceInPaise: 500, currency: 'INR', isActive: false }],
    })
    const { service } = makeService(state)
    const result = await service.validate(input('Returns in 14 days.'))
    assert.equal(result.decision, 'needs_owner_review')
    assert.equal(result.evidence.length, 0)
  })

  await context.test('truncated active FAQ evidence fails closed', async () => {
    const faqs = Array.from({ length: 21 }, (_, index) => ({
      _id: new Types.ObjectId(), businessId, question: `FAQ ${index}`, answer: `Answer ${index}`, isActive: true,
    }))
    faqs[0] = { ...faqs[0], question: 'What is your return policy?', answer: 'Returns in 14 days.' }
    const { service } = makeService(baseState({ faqs }))
    const result = await service.validate(input('Returns in 14 days.'))
    assert.equal(result.decision, 'missing_business_information')
    assert.equal(result.reasonCode, 'evidence_incomplete')
  })
})

test('stale mode, policy, control versions, disabled gates and cross-business evidence are rejected', async (context) => {
  await context.test('stale policy version', async () => {
    const { service } = makeService()
    const result = await service.validate(input('Returns are accepted within 14 days.', { expectedPolicyVersion: 'old-policy' }))
    assert.equal(result.decision, 'policy_conflict')
    assert.equal(result.reasonCode, 'stale_policy_version')
  })

  await context.test('stale control version', async () => {
    const state = baseState({ conversation: {
      _id: conversationId, businessId, responseMode: 'ai_automatic', aiControlVersion: controlVersion + 1,
    } })
    const { service } = makeService(state)
    const result = await service.validate(input('Returns are accepted within 14 days.'))
    assert.equal(result.reasonCode, 'stale_control_version')
  })

  await context.test('Human or draft mode is not eligible', async () => {
    const state = baseState({ conversation: {
      _id: conversationId, businessId, responseMode: 'ai_draft', aiControlVersion: controlVersion,
    } })
    const { service } = makeService(state)
    const result = await service.validate(input('Returns are accepted within 14 days.'))
    assert.equal(result.reasonCode, 'conversation_mode_mismatch')
  })

  await context.test('global feature gate off', async () => {
    const { service } = makeService(baseState(), { globalEnabled: false })
    const result = await service.validate(input('Returns are accepted within 14 days.'))
    assert.equal(result.reasonCode, 'automatic_replies_disabled')
  })

  await context.test('cross-business FAQ data cannot match', async () => {
    const state = baseState({ faqs: [{
      _id: faqId, businessId: otherBusinessId, question: 'What is your return policy?', answer: 'Cross-business answer.', isActive: true,
    }] })
    const { service } = makeService(state)
    const result = await service.validate(input('Cross-business answer.'))
    assert.equal(result.decision, 'needs_owner_review')
    assert.equal(result.evidence.length, 0)
  })
})

test('empty, malformed, oversized and control-character generated responses are rejected', async (context) => {
  for (const [label, generatedResponse] of [
    ['empty', '   '],
    ['malformed', { text: 'Returns are accepted within 14 days.', confidence: 1 }],
    ['oversized', 'x'.repeat(4_097)],
    ['control character', 'Returns\u0000 are accepted within 14 days.'],
  ]) {
    await context.test(label, async () => {
      const { service } = makeService()
      const result = await service.validate(input(generatedResponse))
      assert.equal(result.decision, 'invalid_or_empty_response')
      assert.equal(result.safeReplyText, undefined)
    })
  }
})

test('validator failures fail closed and telemetry excludes private text', async () => {
  const secretInbound = 'private customer body 79123'
  const secretGenerated = 'private generated reply 88342'
  const state = baseState({
    inbound: { _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text', text: secretInbound },
  })
  const { service, logs } = makeService(state, { faqFailure: true })
  const result = await service.validate(input(secretGenerated))
  assert.equal(result.decision, 'missing_business_information')
  assert.equal(result.reasonCode, 'business_evidence_unavailable')
  assert.equal(JSON.stringify(logs).includes(secretInbound), false)
  assert.equal(JSON.stringify(logs).includes(secretGenerated), false)
})

test('non-safe decision persistence is idempotent and stores audit references without message or reply text', async () => {
  const state = baseState({
    inbound: {
      _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text',
      text: 'Can you guarantee delivery tomorrow?',
    },
  })
  const { service } = makeService(state)
  const first = await service.validateAndEscalate(input('We guarantee delivery tomorrow.'))
  const second = await service.validateAndEscalate(input('We guarantee delivery tomorrow.'))
  assert.equal(first.validation.decision, 'needs_owner_review')
  assert.equal(first.escalation, 'created')
  assert.equal(second.escalation, 'already_exists')
  assert.equal(state.escalations.size, 1)
  const stored = [...state.escalations.values()][0]
  assert.equal(stored.category, 'needs_owner_review')
  assert.equal(stored.reasonCode, 'catalog_intent_unsupported')
  assert.equal(stored.policyVersion, policyVersion)
  assert.equal(stored.status, 'open')
  assert.equal('text' in stored, false)
  assert.equal('generatedResponse' in stored, false)
})

test('escalation persistence failure returns a safe not-persisted result', async () => {
  const secretError = 'private database failure with customer text 991827'
  const state = baseState({
    inbound: {
      _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text',
      text: 'Can you guarantee delivery tomorrow?',
    },
  })
  const logs = []
  const failingService = createAutomaticReplySafetyService({
    repository: {
      async findBusinessPolicy() { return state.policy },
      async findConversation() { return state.conversation },
      async findInboundMessage() { return state.inbound },
      async listActiveFaqs() { return state.faqs },
      async listActiveCatalogItems() { return state.catalog },
      async recordEscalation() { throw new Error(secretError) },
    },
    isAutomaticSendEnabled: () => true,
    log(event) { logs.push(event) },
  })
  const result = await failingService.validateAndEscalate(input('We guarantee delivery tomorrow.'))
  assert.equal(result.validation.decision, 'needs_owner_review')
  assert.equal(result.escalation, 'not_persisted')
  assert.equal(JSON.stringify(logs).includes(secretError), false)
})

function makeQuery(result) {
  return {
    select() { return this },
    lean() { return this },
    async exec() { return result },
  }
}

test('Mongo escalation writer validates ownership, records audit metadata and handles duplicate-key races', async () => {
  const originals = {
    conversationExists: Conversation.exists,
    messageExists: Message.exists,
    escalationFindOne: AiReplyEscalation.findOne,
    escalationCreate: AiReplyEscalation.create,
  }
  const stored = {
    _id: new Types.ObjectId(),
    businessId,
    conversationId,
    inboundMessageId,
  }
  let reads = 0
  let creates = 0

  try {
    Conversation.exists = async (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter._id.toString(), conversationId.toString())
      return { _id: conversationId }
    }
    Message.exists = async (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.conversationId.toString(), conversationId.toString())
      assert.equal(filter.direction, 'inbound')
      assert.equal(filter.messageType, 'text')
      return { _id: inboundMessageId }
    }
    AiReplyEscalation.findOne = (filter) => {
      reads += 1
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.inboundMessageId.toString(), inboundMessageId.toString())
      return makeQuery(reads === 1 ? null : stored)
    }
    AiReplyEscalation.create = async (documents) => {
      creates += 1
      const document = documents[0]
      assert.equal(document.businessId.toString(), businessId.toString())
      assert.equal(document.inboundMessageId.toString(), inboundMessageId.toString())
      assert.equal(document.status, 'open')
      assert.equal(document.policyVersion, policyVersion)
      assert.equal('text' in document, false)
      const duplicateError = new Error('duplicate')
      duplicateError.code = 11000
      throw duplicateError
    }

    const result = await recordAutomaticReplyEscalation({
      businessId, conversationId, inboundMessageId,
      category: 'unsupported_information',
      reasonCode: 'generated_response_mismatch',
      policyVersion,
      expectedPolicyVersion: policyVersion,
      controlVersion,
      expectedControlVersion: controlVersion,
      evidence: [{ kind: 'faq', recordId: faqId.toString() }],
    })
    assert.deepEqual(result, { kind: 'exists', escalationId: stored._id })
    assert.equal(creates, 1)
    assert.equal(reads, 2)
  } finally {
    Conversation.exists = originals.conversationExists
    Message.exists = originals.messageExists
    AiReplyEscalation.findOne = originals.escalationFindOne
    AiReplyEscalation.create = originals.escalationCreate
  }
})

test('escalation persistence refuses an inaccessible source message', async () => {
  const originalConversationExists = Conversation.exists
  const originalMessageExists = Message.exists
  const originalCreate = AiReplyEscalation.create
  try {
    Conversation.exists = async () => ({ _id: conversationId })
    Message.exists = async () => null
    AiReplyEscalation.create = async () => assert.fail('must not create an escalation without an owned inbound message')
    assert.deepEqual(await recordAutomaticReplyEscalation({
      businessId, conversationId, inboundMessageId,
      category: 'needs_owner_review', reasonCode: 'source_message_unavailable', evidence: [],
    }), { kind: 'not_found' })
  } finally {
    Conversation.exists = originalConversationExists
    Message.exists = originalMessageExists
    AiReplyEscalation.create = originalCreate
  }
})

test('escalation schema defaults open and declares unique business/inbound index', async () => {
  const escalation = new AiReplyEscalation({
    businessId, conversationId, inboundMessageId,
    category: 'needs_owner_review', reasonCode: 'catalog_intent_unsupported',
  })
  await escalation.validate()
  assert.equal(escalation.status, 'open')
  const index = AiReplyEscalation.schema.indexes().find(([, options]) =>
    options.name === 'ai_reply_escalations_business_inbound_unique',
  )
  assert.deepEqual(index[0], { businessId: 1, inboundMessageId: 1 })
  assert.equal(index[1].unique, true)
  assert.equal(AiReplyEscalation.schema.options.autoIndex, false)
  assert.equal(AiReplyEscalation.schema.options.autoCreate, false)
})

test('telemetry allowlist emits only decision metadata for validation events', () => {
  const originalInfo = console.info
  const events = []
  console.info = (line) => events.push(line)
  try {
    logAiPipelineTiming({
      event: 'ai_pipeline.automatic_reply_validation',
      stage: 'safety_validation',
      outcome: 'policy_conflict',
      faqEvidenceCount: 2,
      catalogEvidenceCount: 1,
      durationMs: 3.4,
    })
  } finally {
    console.info = originalInfo
  }
  assert.equal(events.length, 1)
  assert.deepEqual(JSON.parse(events[0]), {
    event: 'ai_pipeline.automatic_reply_validation',
    stage: 'safety_validation',
    outcome: 'policy_conflict',
    durationMs: 3,
    faqEvidenceCount: 2,
    catalogEvidenceCount: 1,
  })
})
