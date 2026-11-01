import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { createBusinessContextService } from '../dist/services/business-context.service.js'

const businessId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const customerId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const otherCustomerId = new Types.ObjectId()
const triggerCreatedAt = new Date('2026-10-01T12:00:00.000Z')

function makeHistoryMessage({
  business = businessId,
  conversation = conversationId,
  customer = customerId,
  direction = 'inbound',
  status = 'received',
  text = 'Earlier customer message',
  createdAt,
  id = new Types.ObjectId(),
} = {}) {
  return {
    _id: id,
    businessId: business,
    conversationId: conversation,
    customerId: customer,
    direction,
    messageType: 'text',
    status,
    text,
    createdAt: createdAt ?? new Date(triggerCreatedAt.getTime() - 60_000),
  }
}

function makeRepository(overrides = {}) {
  const calls = {}
  const repository = {
    async findBusiness(requestedBusinessId) {
      calls.businessId = requestedBusinessId
      return {
        _id: businessId,
        name: 'Northwind Bikes',
        industry: 'Bicycles',
        description: 'A local bicycle shop.',
        contactDetails: {
          phone: '+911234567890',
          email: 'hello@example.test',
          website: 'https://example.test',
          address: '12 Market Road',
          apiKey: 'DO_NOT_INCLUDE_CONTACT_SECRET',
        },
        whatsapp: { credentialRef: 'DO_NOT_INCLUDE_WA_SECRET' },
        aiSettings: {
          modelConfiguration: { apiKey: 'DO_NOT_INCLUDE_MODEL_SECRET' },
          communicationPreferences: 'DO_NOT_INCLUDE_UNVALIDATED_PREFERENCE',
        },
      }
    },
    async findConversation(requestedBusinessId, requestedConversationId) {
      calls.conversation = { businessId: requestedBusinessId, conversationId: requestedConversationId }
      return { _id: conversationId, businessId, customerId }
    },
    async findCustomer(requestedBusinessId, requestedCustomerId) {
      calls.customer = { businessId: requestedBusinessId, customerId: requestedCustomerId }
      return { _id: customerId, businessId, profileName: 'Asha' }
    },
    async findInboundMessage(input) {
      calls.trigger = input
      return {
        _id: inboundMessageId,
        businessId,
        conversationId,
        customerId,
        direction: 'inbound',
        messageType: 'text',
        text: 'Do you have a commuter bicycle under ₹20,000?',
        createdAt: triggerCreatedAt,
      }
    },
    async listActiveCatalogItems(requestedBusinessId, limit) {
      calls.catalog = { businessId: requestedBusinessId, limit }
      return [
        {
          _id: new Types.ObjectId(), businessId, isActive: true, kind: 'product',
          name: 'City 1', description: 'Light city bicycle.', priceInPaise: 18_000_00, currency: 'INR',
          availability: 'Owner note: usually available.',
        },
        {
          _id: new Types.ObjectId(), businessId, isActive: false, kind: 'product', name: 'Retired model',
        },
        {
          _id: new Types.ObjectId(), businessId: otherBusinessId, isActive: true, kind: 'product', name: 'Other business item',
        },
      ]
    },
    async listActiveFaqs(requestedBusinessId, limit) {
      calls.faq = { businessId: requestedBusinessId, limit }
      return [
        { _id: new Types.ObjectId(), businessId, isActive: true, question: 'Do you deliver?', answer: 'Delivery is available locally.' },
        { _id: new Types.ObjectId(), businessId, isActive: false, question: 'Hidden FAQ', answer: 'Hidden answer' },
        { _id: new Types.ObjectId(), businessId: otherBusinessId, isActive: true, question: 'Other FAQ', answer: 'Other answer' },
      ]
    },
    async listRecentMessages(input) {
      calls.history = input
      return []
    },
  }
  return { repository: { ...repository, ...overrides }, calls }
}

function runContext(repository, options = {}) {
  return createBusinessContextService(repository, options).retrieve({
    businessId,
    conversationId,
    inboundMessageId,
  })
}

test('retrieves a safe, business-scoped profile and customer display name', async () => {
  const { repository, calls } = makeRepository()
  const result = await runContext(repository)

  assert.equal(result.status, 'ready')
  assert.equal(result.context.business.name, 'Northwind Bikes')
  assert.equal(result.context.business.industry, 'Bicycles')
  assert.equal(result.context.customer.displayName, 'Asha')
  assert.equal(calls.businessId, businessId)
  assert.equal(calls.conversation.businessId, businessId)
  assert.equal(calls.customer.businessId, businessId)
  assert.equal(calls.trigger.businessId, businessId)
  assert.equal(JSON.stringify(result.context).includes('DO_NOT_INCLUDE'), false)
})

test('includes only active catalogue and FAQ records from the requested business', async () => {
  const { repository, calls } = makeRepository()
  const result = await runContext(repository)

  assert.equal(result.status, 'ready')
  assert.deepEqual(result.context.catalogItems.map((item) => item.name), ['City 1'])
  assert.equal(result.context.catalogItems[0].priceInPaise, 1_800_000)
  assert.equal(result.context.catalogItems[0].availabilityNote, 'Owner note: usually available.')
  assert.deepEqual(result.context.faqs.map((faq) => faq.question), ['Do you deliver?'])
  assert.equal(calls.catalog.businessId, businessId)
  assert.equal(calls.faq.businessId, businessId)
})

test('rejects a cross-business conversation without requesting its customer or knowledge', async () => {
  const { repository } = makeRepository({
    async findConversation(requestedBusinessId) {
      return { _id: conversationId, businessId: otherBusinessId, customerId }
    },
  })
  const result = await runContext(repository)

  assert.deepEqual(result, { status: 'unavailable', reason: 'conversation_not_found' })
})

test('rejects a customer or trigger message that does not match the scoped conversation', async (context) => {
  await context.test('cross-business customer', async () => {
    const { repository } = makeRepository({
      async findCustomer() { return { _id: customerId, businessId: otherBusinessId, profileName: 'Other' } },
    })
    assert.deepEqual(await runContext(repository), { status: 'unavailable', reason: 'conversation_not_found' })
  })

  await context.test('wrong customer trigger', async () => {
    const { repository } = makeRepository({
      async findInboundMessage() {
        return {
          _id: inboundMessageId, businessId, conversationId, customerId: otherCustomerId,
          direction: 'inbound', messageType: 'text', text: 'Hello', createdAt: triggerCreatedAt,
        }
      },
    })
    assert.deepEqual(await runContext(repository), { status: 'unavailable', reason: 'trigger_message_not_found' })
  })
})

test('keeps recent history scoped, excludes the trigger and failed outbound messages, and orders chronologically', async () => {
  const history = Array.from({ length: 15 }, (_, index) => makeHistoryMessage({
    text: `Earlier ${index}`,
    createdAt: new Date(triggerCreatedAt.getTime() - (15 - index) * 1_000),
  }))
  history.push(makeHistoryMessage({ business: otherBusinessId, text: 'Cross business' }))
  history.push(makeHistoryMessage({ customer: otherCustomerId, text: 'Cross customer' }))
  history.push(makeHistoryMessage({ direction: 'outbound', status: 'failed', text: 'Not delivered' }))
  history.push(makeHistoryMessage({ text: 'Not before trigger', createdAt: new Date(triggerCreatedAt.getTime() + 1_000) }))

  const { repository, calls } = makeRepository({ async listRecentMessages(input) { calls.history = input; return history } })
  const result = await runContext(repository)

  assert.equal(result.status, 'ready')
  assert.equal(calls.history.businessId, businessId)
  assert.equal(calls.history.conversationId, conversationId)
  assert.equal(calls.history.customerId, customerId)
  assert.equal(calls.history.limit, 12)
  assert.equal(result.context.recentMessages.length, 12)
  assert.deepEqual(result.context.recentMessages.map((message) => message.text),
    Array.from({ length: 12 }, (_, index) => `Earlier ${index + 3}`))
  assert.equal(result.context.recentMessages[0].createdAt < result.context.recentMessages.at(-1).createdAt, true)
})

test('applies hard record caps and the 16 KB serialized context budget', async () => {
  const catalog = Array.from({ length: 40 }, (_, index) => ({
    _id: new Types.ObjectId(), businessId, isActive: true, kind: 'product',
    name: `Item ${String(index).padStart(2, '0')}`, description: 'x'.repeat(400),
  }))
  const faqs = Array.from({ length: 25 }, (_, index) => ({
    _id: new Types.ObjectId(), businessId, isActive: true,
    question: `Question ${String(index).padStart(2, '0')}`, answer: 'y'.repeat(600),
  }))
  const { repository } = makeRepository({
    async listActiveCatalogItems() { return catalog },
    async listActiveFaqs() { return faqs },
    async listRecentMessages() {
      return Array.from({ length: 12 }, (_, index) => makeHistoryMessage({ text: 'z'.repeat(600), createdAt: new Date(triggerCreatedAt.getTime() - (12 - index) * 1_000) }))
    },
  })
  const result = await runContext(repository)

  assert.equal(result.status, 'ready')
  assert.ok(result.context.catalogItems.length <= 30)
  assert.ok(result.context.faqs.length <= 20)
  assert.ok(result.context.recentMessages.length <= 12)
  assert.ok(result.serializedBytes <= 16_384)
  assert.equal(result.context.coverage.catalogMayBeIncomplete, true)
  assert.equal(result.context.coverage.faqsMayBeIncomplete, true)
})

test('returns a controlled not-ready result when business knowledge is missing', async () => {
  const { repository } = makeRepository({
    async findBusiness() { return { _id: businessId, name: 'Northwind Bikes' } },
    async listActiveCatalogItems() { return [] },
    async listActiveFaqs() { return [] },
  })
  assert.deepEqual(await runContext(repository), {
    status: 'unavailable',
    reason: 'insufficient_business_knowledge',
  })
})

test('returns a sanitized unavailable result for retrieval failures and oversized trigger input', async (context) => {
  await context.test('retrieval exception', async () => {
    const { repository } = makeRepository({ async listActiveFaqs() { throw new Error('private database detail') } })
    assert.deepEqual(await runContext(repository), { status: 'unavailable', reason: 'context_unavailable' })
  })

  await context.test('trigger exceeds byte cap', async () => {
    const { repository } = makeRepository({
      async findInboundMessage() {
        return {
          _id: inboundMessageId, businessId, conversationId, customerId,
          direction: 'inbound', messageType: 'text', text: '😀'.repeat(2_000), createdAt: triggerCreatedAt,
        }
      },
    })
    assert.deepEqual(await runContext(repository), { status: 'unavailable', reason: 'trigger_message_too_large' })
  })
})
