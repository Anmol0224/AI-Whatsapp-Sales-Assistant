import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import { AiReplyEscalation } from '../dist/models/ai-reply-escalation.model.js'
import { CatalogItem } from '../dist/models/catalog-item.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Customer } from '../dist/models/customer.model.js'
import { Faq } from '../dist/models/faq.model.js'
import { Message } from '../dist/models/message.model.js'
import { createAiEscalationsRouter } from '../dist/routes/v1/ai-escalations.routes.js'
import {
  countAiReplyEscalationsByStatus,
  findAiReplyEscalation,
  listAiReplyEscalations,
  resolveAiReplyEscalation,
} from '../dist/services/ai-reply-escalation.repository.js'

const businessId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const userId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const customerId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const escalationId = new Types.ObjectId()
const faqId = new Types.ObjectId()
const catalogItemId = new Types.ObjectId()
const now = new Date('2026-11-06T12:00:00.000Z')
const resolvedAt = new Date('2026-11-06T12:30:00.000Z')

function sampleEscalation(overrides = {}) {
  return {
    _id: escalationId,
    businessId,
    conversationId,
    inboundMessageId,
    conversation: {
      _id: conversationId,
      status: 'open',
      customer: { profileName: 'Priya Sharma', phoneNumber: '919876543210' },
    },
    inboundMessage: {
      _id: inboundMessageId,
      text: 'Can you deliver a custom bulk order by tomorrow morning?',
      timestamp: now,
      createdAt: now,
    },
    category: 'unsupported_information',
    reasonCode: 'evidence_incomplete',
    policyVersion: 'policy-v1',
    controlVersion: 2,
    status: 'open',
    resolvedByUserId: userId,
    createdAt: now,
    updatedAt: now,
    evidence: [
      { kind: 'faq', recordId: faqId, label: 'What are your delivery hours?' },
      { kind: 'catalog_item', recordId: catalogItemId, label: 'Starter Pack' },
    ],
    ...overrides,
  }
}

function routeHarness(overrides = {}) {
  const calls = []
  const dependencies = {
    async listEscalations(input) {
      calls.push({ operation: 'list', input })
      return overrides.listResult
        ? await overrides.listResult(input)
        : { escalations: [], totalItems: 0 }
    },
    async countEscalations(ownerBusinessId) {
      calls.push({ operation: 'counts', ownerBusinessId })
      return overrides.countsResult ?? { open: 1, resolved: 2, dismissed: 1 }
    },
    async findEscalation(ownerBusinessId, id) {
      calls.push({ operation: 'detail', ownerBusinessId, id })
      return overrides.findEscalation ? overrides.findEscalation(ownerBusinessId, id) : null
    },
    async resolveEscalation(input) {
      calls.push({ operation: 'resolve', input })
      return overrides.resolveEscalation
        ? overrides.resolveEscalation(input)
        : {
            kind: 'resolved',
            escalation: {
              _id: input.escalationId,
              status: input.outcome,
              resolvedAt,
              ...(input.note ? { resolutionNote: input.note } : {}),
            },
          }
    },
  }

  const authenticateTestOwner = (request, response, next) => {
    const token = request.get('authorization')
    if (token === 'Bearer owner-test-token') {
      request.auth = { userId: userId.toString(), businessId: businessId.toString(), role: 'owner' }
      next()
      return
    }
    if (token === 'Bearer other-owner-test-token') {
      request.auth = {
        userId: new Types.ObjectId().toString(),
        businessId: otherBusinessId.toString(),
        role: 'owner',
      }
      next()
      return
    }
    response.status(401).json({ success: false, message: 'Authentication required.' })
  }

  const app = express()
  app.use(express.json())
  app.use('/ai-escalations', createAiEscalationsRouter(dependencies, authenticateTestOwner))
  app.use((_error, _request, response, _next) => {
    response.status(500).json({ success: false, message: 'Internal server error' })
  })
  const server = createServer(app)
  return { calls, server }
}

async function withServer(overrides, run) {
  const harness = routeHarness(overrides)
  await new Promise((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
  const address = harness.server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, harness.calls)
  } finally {
    await new Promise((resolve, reject) =>
      harness.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

async function get(baseUrl, path, token = 'Bearer owner-test-token') {
  const headers = token ? { authorization: token } : {}
  const response = await fetch(`${baseUrl}${path}`, { headers })
  return { response, body: await response.json() }
}

async function post(baseUrl, path, body, token = 'Bearer owner-test-token') {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) }
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { response, body: await response.json() }
}

test('authenticated owner lists business escalations with default pending filter, counts and safe fields', async () => {
  await withServer(
    {
      listResult: async () => ({ escalations: [sampleEscalation()], totalItems: 1 }),
      countsResult: { open: 3, resolved: 5, dismissed: 2 },
    },
    async (baseUrl, calls) => {
      const { response, body } = await get(baseUrl, '/ai-escalations')
      assert.equal(response.status, 200)
      assert.equal(body.success, true)
      assert.deepEqual(body.counts, { pending: 3, resolved: 5, dismissed: 2, total: 10 })
      assert.deepEqual(body.pagination, { page: 1, limit: 20, totalItems: 1, totalPages: 1 })
      assert.equal(body.escalations.length, 1)
      assert.equal(body.escalations[0].id, escalationId.toString())
      assert.equal(body.escalations[0].conversationId, conversationId.toString())
      assert.equal(body.escalations[0].category, 'unsupported_information')
      assert.equal(body.escalations[0].reasonCode, 'evidence_incomplete')
      assert.equal(body.escalations[0].status, 'open')
      assert.deepEqual(body.escalations[0].conversation, {
        id: conversationId.toString(),
        status: 'open',
        customer: { profileName: 'Priya Sharma', phoneNumber: '919876543210' },
      })
      assert.deepEqual(body.escalations[0].inboundMessage, {
        id: inboundMessageId.toString(),
        text: 'Can you deliver a custom bulk order by tomorrow morning?',
        timestamp: now.toISOString(),
        createdAt: now.toISOString(),
      })
      // Internal identifiers and evidence list are not exposed on list items.
      assert.equal(body.escalations[0].businessId, undefined)
      assert.equal(body.escalations[0].resolvedByUserId, undefined)
      assert.equal(body.escalations[0].evidence, undefined)

      assert.deepEqual(calls[0], {
        operation: 'list',
        input: { businessId, page: 1, limit: 20, status: 'open' },
      })
      assert.deepEqual(calls[1], {
        operation: 'counts',
        ownerBusinessId: businessId,
      })
    },
  )
})

test('status filters (open, resolved, dismissed, all) and pagination are validated and forwarded', async () => {
  await withServer({}, async (baseUrl, calls) => {
    for (const status of ['open', 'resolved', 'dismissed', 'all']) {
      const { response } = await get(baseUrl, `/ai-escalations?page=2&limit=15&status=${status}`)
      assert.equal(response.status, 200)
    }
    assert.deepEqual(
      calls.filter((call) => call.operation === 'list').map((call) => call.input),
      [
        { businessId, page: 2, limit: 15, status: 'open' },
        { businessId, page: 2, limit: 15, status: 'resolved' },
        { businessId, page: 2, limit: 15, status: 'dismissed' },
        { businessId, page: 2, limit: 15, status: 'all' },
      ],
    )
  })
})

test('invalid query parameters and client-supplied businessId are rejected', async () => {
  await withServer({}, async (baseUrl, calls) => {
    for (const query of [
      '?page=0',
      '?limit=0',
      '?limit=51',
      '?status=pending',
      `?businessId=${otherBusinessId}`,
    ]) {
      const { response } = await get(baseUrl, `/ai-escalations${query}`)
      assert.equal(response.status, 400)
    }
    assert.equal(calls.length, 0)
  })
})

test('unauthenticated requests are rejected across list, detail and resolve endpoints', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const list = await get(baseUrl, '/ai-escalations', null)
    const detail = await get(baseUrl, `/ai-escalations/${escalationId}`, null)
    const resolve = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {}, null)
    assert.equal(list.response.status, 401)
    assert.equal(detail.response.status, 401)
    assert.equal(resolve.response.status, 401)
    assert.equal(calls.length, 0)
  })
})

test('owner can inspect escalation detail for their business and cross-business access returns 404', async () => {
  await withServer(
    {
      findEscalation: async (ownerBusinessId, id) =>
        ownerBusinessId.equals(businessId) && id.equals(escalationId) ? sampleEscalation() : null,
    },
    async (baseUrl, calls) => {
      const invalidId = await get(baseUrl, '/ai-escalations/not-an-id')
      assert.equal(invalidId.response.status, 400)

      const own = await get(baseUrl, `/ai-escalations/${escalationId}`)
      assert.equal(own.response.status, 200)
      assert.equal(own.body.escalation.id, escalationId.toString())
      assert.deepEqual(own.body.escalation.evidence, [
        { kind: 'faq', recordId: faqId.toString(), label: 'What are your delivery hours?' },
        { kind: 'catalog_item', recordId: catalogItemId.toString(), label: 'Starter Pack' },
      ])
      assert.equal(own.body.escalation.businessId, undefined)
      assert.equal(own.body.escalation.resolvedByUserId, undefined)

      const crossBusiness = await get(
        baseUrl,
        `/ai-escalations/${escalationId}`,
        'Bearer other-owner-test-token',
      )
      assert.equal(crossBusiness.response.status, 404)
      assert.equal(crossBusiness.body.message, 'Escalation not found.')
      assert.equal(calls[1].ownerBusinessId.toString(), otherBusinessId.toString())
    },
  )
})

test('owner can resolve or dismiss an open escalation and invalid or duplicate resolutions are rejected', async () => {
  let alreadyClosed = false
  await withServer(
    {
      resolveEscalation: async (input) => {
        if (!input.businessId.equals(businessId)) return { kind: 'not_found' }
        if (alreadyClosed) return { kind: 'already_closed', status: 'resolved' }
        alreadyClosed = true
        return {
          kind: 'resolved',
          escalation: {
            _id: input.escalationId,
            status: input.outcome,
            resolvedAt,
            ...(input.note ? { resolutionNote: input.note } : {}),
          },
        }
      },
    },
    async (baseUrl, calls) => {
      // Invalid body shapes are rejected before calling the repository.
      const invalidOutcome = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {
        outcome: 'open',
      })
      assert.equal(invalidOutcome.response.status, 400)

      const tooLongNote = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {
        outcome: 'resolved',
        note: 'x'.repeat(501),
      })
      assert.equal(tooLongNote.response.status, 400)

      const extraField = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {
        outcome: 'resolved',
        businessId: otherBusinessId.toString(),
      })
      assert.equal(extraField.response.status, 400)
      assert.equal(calls.length, 0)

      // Cross-business resolution attempt returns 404.
      const crossBusiness = await post(
        baseUrl,
        `/ai-escalations/${escalationId}/resolve`,
        { outcome: 'resolved' },
        'Bearer other-owner-test-token',
      )
      assert.equal(crossBusiness.response.status, 404)

      // First owner resolution succeeds and records audit context without sending WhatsApp messages.
      const first = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {
        outcome: 'resolved',
        note: '  Replied manually in Inbox with bulk quote.  ',
      })
      assert.equal(first.response.status, 200)
      assert.deepEqual(first.body, {
        success: true,
        message: 'Escalation marked as resolved. No WhatsApp message was sent.',
        escalation: {
          id: escalationId.toString(),
          status: 'resolved',
          resolvedAt: resolvedAt.toISOString(),
          resolutionNote: 'Replied manually in Inbox with bulk quote.',
        },
      })
      assert.deepEqual(calls[1], {
        operation: 'resolve',
        input: {
          businessId,
          escalationId,
          userId,
          outcome: 'resolved',
          note: 'Replied manually in Inbox with bulk quote.',
        },
      })

      // Repeated submission is rejected with 409 and does not overwrite the earlier resolution.
      const duplicate = await post(baseUrl, `/ai-escalations/${escalationId}/resolve`, {
        outcome: 'dismissed',
      })
      assert.equal(duplicate.response.status, 409)
      assert.equal(duplicate.body.code, 'already_closed')
    },
  )
})

test('repository scopes queries by businessId, attaches safe context and enforces conditional open-to-closed resolution', async () => {
  const originalFind = AiReplyEscalation.find
  const originalFindOne = AiReplyEscalation.findOne
  const originalCountDocuments = AiReplyEscalation.countDocuments
  const originalUpdateOne = AiReplyEscalation.updateOne
  const originalConversationFind = Conversation.find
  const originalCustomerFind = Customer.find
  const originalMessageFind = Message.find
  const originalFaqFind = Faq.find
  const originalCatalogFind = CatalogItem.find

  const observed = { counts: [], updates: [] }
  const query = (value) => ({
    select(fields) { this.fields = fields; return this },
    sort(sorting) { this.sorting = sorting; return this },
    skip(offset) { this.offset = offset; return this },
    limit(limitValue) { this.limitValue = limitValue; return this },
    lean() { return this },
    async exec() { return value },
  })

  try {
    AiReplyEscalation.find = (filter) => {
      observed.findFilter = filter
      observed.findQuery = query([sampleEscalation()])
      return observed.findQuery
    }
    AiReplyEscalation.countDocuments = (filter) => {
      observed.counts.push(filter)
      const count = filter.status === 'open' ? 4 : filter.status === 'resolved' ? 7 : 1
      return { async exec() { return count } }
    }
    AiReplyEscalation.findOne = (filter) => {
      observed.findOneFilter = filter
      return query(sampleEscalation({
        evidence: [
          { kind: 'faq', recordId: faqId },
          { kind: 'catalog_item', recordId: catalogItemId },
        ],
      }))
    }
    Conversation.find = (filter) => {
      observed.conversationFilter = filter
      return query([{ _id: conversationId, customerId, status: 'open' }])
    }
    Customer.find = (filter) => {
      observed.customerFilter = filter
      return query([{ _id: customerId, profileName: 'Priya Sharma', phoneNumber: '919876543210' }])
    }
    Message.find = (filter) => {
      observed.messageFilter = filter
      return query([
        {
          _id: inboundMessageId,
          conversationId,
          text: 'Can you deliver a custom bulk order by tomorrow morning?',
          timestamp: now,
          createdAt: now,
        },
      ])
    }
    Faq.find = (filter) => {
      observed.faqFilter = filter
      return query([{ _id: faqId, question: 'What are your delivery hours?' }])
    }
    CatalogItem.find = (filter) => {
      observed.catalogFilter = filter
      return query([{ _id: catalogItemId, name: 'Starter Pack' }])
    }

    const listResult = await listAiReplyEscalations({
      businessId,
      page: 1,
      limit: 20,
      status: 'open',
    })
    assert.deepEqual(observed.findFilter, { businessId, status: 'open' })
    assert.deepEqual(observed.findQuery.sorting, { createdAt: -1, _id: -1 })
    assert.equal(observed.findQuery.fields.businessId, undefined)
    assert.equal(observed.findQuery.fields.resolvedByUserId, undefined)
    assert.equal(observed.conversationFilter.businessId.toString(), businessId.toString())
    assert.equal(observed.customerFilter.businessId.toString(), businessId.toString())
    assert.equal(observed.messageFilter.businessId.toString(), businessId.toString())
    assert.equal(listResult.escalations[0].conversation?.customer?.profileName, 'Priya Sharma')

    const allResult = await listAiReplyEscalations({
      businessId,
      page: 1,
      limit: 10,
      status: 'all',
    })
    assert.deepEqual(observed.findFilter, { businessId })
    assert.equal(allResult.escalations.length, 1)

    const counts = await countAiReplyEscalationsByStatus(businessId)
    assert.deepEqual(counts, { open: 4, resolved: 7, dismissed: 1 })

    const detail = await findAiReplyEscalation(businessId, escalationId)
    assert.deepEqual(observed.findOneFilter, { _id: escalationId, businessId })
    assert.equal(observed.faqFilter.businessId.toString(), businessId.toString())
    assert.equal(observed.catalogFilter.businessId.toString(), businessId.toString())
    assert.deepEqual(detail?.evidence, [
      { kind: 'faq', recordId: faqId, label: 'What are your delivery hours?' },
      { kind: 'catalog_item', recordId: catalogItemId, label: 'Starter Pack' },
    ])

    let matchedCount = 1
    AiReplyEscalation.updateOne = (filter, update, options) => {
      observed.updates.push({ filter, update, options })
      return { async exec() { return { matchedCount } } }
    }
    AiReplyEscalation.findOne = (filter) => {
      observed.closedCheckFilter = filter
      return query({ _id: escalationId, status: 'resolved' })
    }

    const resolved = await resolveAiReplyEscalation({
      businessId,
      escalationId,
      userId,
      outcome: 'resolved',
      note: 'Handled in Inbox',
      now: resolvedAt,
    })
    assert.equal(resolved.kind, 'resolved')
    assert.deepEqual(observed.updates[0], {
      filter: { _id: escalationId, businessId, status: 'open' },
      update: {
        $set: {
          status: 'resolved',
          resolvedAt,
          resolvedByUserId: userId,
          resolutionNote: 'Handled in Inbox',
        },
      },
      options: { runValidators: true },
    })

    matchedCount = 0
    const repeat = await resolveAiReplyEscalation({
      businessId,
      escalationId,
      userId,
      outcome: 'dismissed',
      now: resolvedAt,
    })
    assert.deepEqual(repeat, { kind: 'already_closed', status: 'resolved' })
  } finally {
    AiReplyEscalation.find = originalFind
    AiReplyEscalation.findOne = originalFindOne
    AiReplyEscalation.countDocuments = originalCountDocuments
    AiReplyEscalation.updateOne = originalUpdateOne
    Conversation.find = originalConversationFind
    Customer.find = originalCustomerFind
    Message.find = originalMessageFind
    Faq.find = originalFaqFind
    CatalogItem.find = originalCatalogFind
  }
})
