import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import mongoose, { Types } from 'mongoose'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Message } from '../dist/models/message.model.js'
import {
  createAiDraftsRouter,
  createConversationAiDraftsRouter,
} from '../dist/routes/v1/ai-drafts.routes.js'
import {
  listAiReplyDrafts,
  listAiReplyDraftsForConversation,
} from '../dist/services/ai-reply-job.repository.js'

const businessId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const userId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const draftId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const now = new Date('2026-11-02T10:00:00.000Z')

function sampleDraft(overrides = {}) {
  return {
    _id: draftId,
    conversationId,
    inboundMessageId,
    sourceMessage: { _id: inboundMessageId, text: 'Do you have this in blue?', createdAt: now },
    status: 'draft_ready',
    generatedDraft: 'Suggested customer response',
    createdAt: now,
    updatedAt: now,
    attemptCount: 3,
    leaseExpiresAt: now,
    sendAttemptId: 'must-not-serialize',
    providerMessageId: 'must-not-serialize',
    providerError: { details: 'must-not-serialize' },
    ...overrides,
  }
}

function routeHarness(overrides = {}) {
  const calls = []
  const dependencies = {
    async listDrafts(input) {
      calls.push({ operation: 'list', input })
      return overrides.listResult ?? { drafts: [], totalItems: 0 }
    },
    async listConversationDrafts(input) {
      calls.push({ operation: 'conversation-list', input })
      return overrides.conversationListResult ?? { drafts: [], totalItems: 0 }
    },
    async findDraft(ownerBusinessId, id) {
      calls.push({ operation: 'detail', ownerBusinessId, id })
      return overrides.findDraft ? overrides.findDraft(ownerBusinessId, id) : null
    },
    async approveDraft(input) {
      calls.push({ operation: 'approve', input })
      return overrides.approveResult ?? { kind: 'approved', approvedText: input.approvedText ?? 'Generated draft', approvedControlVersion: 8 }
    },
    async rejectDraft(input) {
      calls.push({ operation: 'reject', input })
      return overrides.rejectResult ?? { kind: 'rejected' }
    },
    async sendDraft(input) {
      calls.push({ operation: 'send', input })
      return overrides.sendResult ?? {
        kind: 'sent',
        draftId: input.draftId.toString(),
        message: {
          id: new Types.ObjectId().toString(),
          text: 'Approved owner-reviewed reply',
          status: 'sent',
          createdAt: now.toISOString(),
        },
      }
    },
    async conversationExists(id, ownerBusinessId) {
      calls.push({ operation: 'conversation-exists', ownerBusinessId, id })
      return overrides.conversationExists?.(id, ownerBusinessId) ?? false
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
      request.auth = { userId: new Types.ObjectId().toString(), businessId: otherBusinessId.toString(), role: 'owner' }
      next()
      return
    }
    response.status(401).json({ success: false, message: 'Authentication required.' })
  }
  const app = express()
  app.use(express.json())
  app.use('/ai-drafts', createAiDraftsRouter(dependencies, authenticateTestOwner))
  app.use('/conversations/:conversationId/ai-drafts', createConversationAiDraftsRouter(dependencies, authenticateTestOwner))
  app.use((error, _request, response, _next) => {
    response.status(500).json({ success: false, message: 'Internal error.' })
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
    await new Promise((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()))
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

test('owner can list business drafts with default filters and safe response serialization', async () => {
  await withServer({ listResult: { drafts: [sampleDraft()], totalItems: 1 } }, async (baseUrl, calls) => {
    const { response, body } = await get(baseUrl, '/ai-drafts')
    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(body.drafts[0].id, draftId.toString())
    assert.equal(body.drafts[0].generatedDraft, 'Suggested customer response')
    assert.deepEqual(body.drafts[0].sourceMessage, {
      id: inboundMessageId.toString(),
      text: 'Do you have this in blue?',
      createdAt: now.toISOString(),
    })
    assert.equal(body.drafts[0].attemptCount, undefined)
    assert.equal(body.drafts[0].leaseExpiresAt, undefined)
    assert.equal(body.drafts[0].sendAttemptId, undefined)
    assert.equal(body.drafts[0].providerMessageId, undefined)
    assert.equal(body.drafts[0].providerError, undefined)
    assert.deepEqual(body.pagination, { page: 1, limit: 20, totalItems: 1, totalPages: 1 })
    assert.deepEqual(calls[0], {
      operation: 'list', input: { businessId, page: 1, limit: 20, status: 'draft_ready' },
    })
  })
})

test('unauthenticated list and detail requests are rejected', async () => {
  await withServer({}, async (baseUrl) => {
    const list = await get(baseUrl, '/ai-drafts', null)
    const detail = await get(baseUrl, `/ai-drafts/${draftId}`, null)
    assert.equal(list.response.status, 401)
    assert.equal(detail.response.status, 401)
  })
})

test('status filter and bounded pagination are passed from validated query parameters', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const { response } = await get(baseUrl, '/ai-drafts?page=2&limit=10&status=approved')
    assert.equal(response.status, 200)
    assert.deepEqual(calls[0].input, { businessId, page: 2, limit: 10, status: 'approved' })
  })
})

test('invalid pagination, unsupported status and unknown query fields are rejected', async () => {
  await withServer({}, async (baseUrl) => {
    for (const path of [
      '/ai-drafts?page=0',
      '/ai-drafts?limit=101',
      '/ai-drafts?status=unknown',
      '/ai-drafts?businessId=other',
      '/conversations/' + conversationId + '/ai-drafts?page=not-a-number',
    ]) {
      const { response, body } = await get(baseUrl, path)
      assert.equal(response.status, 400, path)
      assert.equal(body.success, false)
    }
  })
})

test('draft detail validates IDs and hides cross-business existence', async () => {
  await withServer({ findDraft: (ownerBusinessId) => ownerBusinessId.equals(businessId) ? sampleDraft() : null }, async (baseUrl, calls) => {
    const invalid = await get(baseUrl, '/ai-drafts/not-an-object-id')
    assert.equal(invalid.response.status, 400)

    const ownDraft = await get(baseUrl, `/ai-drafts/${draftId}`)
    assert.equal(ownDraft.response.status, 200)
    assert.equal(ownDraft.body.draft.conversationId, conversationId.toString())
    assert.equal(ownDraft.body.draft.sourceMessage.text, 'Do you have this in blue?')

    const otherBusinessDraft = await get(baseUrl, `/ai-drafts/${draftId}`, 'Bearer other-owner-test-token')
    assert.equal(otherBusinessDraft.response.status, 404)
    assert.deepEqual(otherBusinessDraft.body, { success: false, message: 'AI draft not found.' })
    assert.equal(calls.at(-1).ownerBusinessId.toString(), otherBusinessId.toString())
  })
})

test('conversation list verifies business ownership and returns a valid empty result', async () => {
  await withServer({ conversationExists: (_id, ownerBusinessId) => ownerBusinessId.equals(businessId) }, async (baseUrl, calls) => {
    const invalid = await get(baseUrl, '/conversations/not-an-object-id/ai-drafts')
    assert.equal(invalid.response.status, 400)

    const missing = await get(baseUrl, `/conversations/${conversationId}/ai-drafts`, 'Bearer other-owner-test-token')
    assert.equal(missing.response.status, 404)
    assert.deepEqual(missing.body, { success: false, message: 'Conversation not found.' })
    assert.equal(calls.some((call) => call.operation === 'conversation-list'), false)

    const empty = await get(baseUrl, `/conversations/${conversationId}/ai-drafts`)
    assert.equal(empty.response.status, 200)
    assert.deepEqual(empty.body.drafts, [])
    assert.equal(empty.body.pagination.totalPages, 0)
    assert.deepEqual(calls.at(-1).input, {
      businessId, conversationId, page: 1, limit: 20, status: 'draft_ready',
    })
  })
})

test('approve route supports unchanged and edited drafts and takes identity only from auth claims', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const unchanged = await post(baseUrl, `/ai-drafts/${draftId}/approve`, {})
    assert.equal(unchanged.response.status, 200)
    assert.equal(unchanged.body.draft.status, 'approved')
    assert.equal(calls.at(-1).input.businessId.toString(), businessId.toString())
    assert.equal(calls.at(-1).input.userId.toString(), userId.toString())
    assert.equal(calls.at(-1).input.approvedText, undefined)

    const edited = await post(baseUrl, `/ai-drafts/${draftId}/approve`, { approvedText: '  Edited response  ' })
    assert.equal(edited.response.status, 200)
    assert.equal(calls.at(-1).input.approvedText, 'Edited response')

    const invalid = await post(baseUrl, `/ai-drafts/${draftId}/approve`, { approvedText: '   ' })
    assert.equal(invalid.response.status, 400)
    const unknownField = await post(baseUrl, `/ai-drafts/${draftId}/approve`, { approvedText: 'ok', businessId: otherBusinessId.toString() })
    assert.equal(unknownField.response.status, 400)
    const unauthenticated = await post(baseUrl, `/ai-drafts/${draftId}/approve`, {}, null)
    assert.equal(unauthenticated.response.status, 401)
  })
})

test('approval conflicts and rejection are single-use review transitions', async () => {
  await withServer({ approveResult: { kind: 'conflict' }, rejectResult: { kind: 'conflict' } }, async (baseUrl, calls) => {
    const approveConflict = await post(baseUrl, `/ai-drafts/${draftId}/approve`, {})
    assert.equal(approveConflict.response.status, 409)

    const reject = await post(baseUrl, `/ai-drafts/${draftId}/reject`, { reason: '  Not appropriate  ' })
    assert.equal(reject.response.status, 409)
    assert.equal(calls.at(-1).input.reason, 'Not appropriate')

    const invalidReason = await post(baseUrl, `/ai-drafts/${draftId}/reject`, { reason: 'x'.repeat(501) })
    assert.equal(invalidReason.response.status, 400)
    const invalidId = await post(baseUrl, '/ai-drafts/not-an-id/approve', {})
    assert.equal(invalidId.response.status, 400)
  })
})

test('rejection success returns a safe terminal summary; stale approval maps to conflict', async () => {
  await withServer({
    rejectResult: { kind: 'rejected' },
    approveResult: { kind: 'stale' },
  }, async (baseUrl) => {
    const rejected = await post(baseUrl, `/ai-drafts/${draftId}/reject`, {})
    assert.equal(rejected.response.status, 200)
    assert.deepEqual(rejected.body.draft, { id: draftId.toString(), status: 'rejected' })

    const stale = await post(baseUrl, `/ai-drafts/${draftId}/approve`, {})
    assert.equal(stale.response.status, 409)
    assert.equal(stale.body.code, 'stale')
  })
})

test('AI draft send requires owner authentication, a valid ID, and an empty JSON body', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const unauthenticated = await post(baseUrl, `/ai-drafts/${draftId}/send`, {}, null)
    assert.equal(unauthenticated.response.status, 401)

    const invalidId = await post(baseUrl, '/ai-drafts/not-an-id/send', {})
    assert.equal(invalidId.response.status, 400)

    for (const body of [
      { text: 'attacker-supplied message' },
      { businessId: otherBusinessId.toString() },
      { customerId: new Types.ObjectId().toString() },
      { conversationId: new Types.ObjectId().toString() },
      { unexpected: true },
    ]) {
      const invalidBody = await post(baseUrl, `/ai-drafts/${draftId}/send`, body)
      assert.equal(invalidBody.response.status, 400)
    }

    assert.equal(calls.filter((call) => call.operation === 'send').length, 0)
  })
})

test('AI draft send derives owner and business scope from JWT and returns a safe sent response', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const { response, body } = await post(baseUrl, `/ai-drafts/${draftId}/send`, {})
    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      success: true,
      message: 'Approved AI draft sent successfully.',
      draft: { id: draftId.toString(), status: 'sent' },
      data: {
        message: {
          id: body.data.message.id,
          text: 'Approved owner-reviewed reply',
          status: 'sent',
          createdAt: now.toISOString(),
        },
      },
    })
    assert.deepEqual(calls[0], {
      operation: 'send',
      input: { businessId, draftId, ownerUserId: userId },
    })
    assert.match(body.data.message.id, /^[a-f\d]{24}$/i)
    assert.equal(JSON.stringify(body).includes('wamid'), false)
    assert.equal(JSON.stringify(body).includes('phoneNumber'), false)
  })
})

test('AI draft send hides cross-business drafts and maps send outcomes safely', async (context) => {
  await context.test('cross-business draft is not found', async () => {
    await withServer({ sendResult: { kind: 'not_found' } }, async (baseUrl, calls) => {
      const { response, body } = await post(baseUrl, `/ai-drafts/${draftId}/send`, {}, 'Bearer other-owner-test-token')
      assert.equal(response.status, 404)
      assert.deepEqual(body, { success: false, message: 'AI draft not found.' })
      assert.equal(calls[0].input.businessId.toString(), otherBusinessId.toString())
    })
  })

  const cases = [
    ['already sent', { kind: 'already_sent', draftId: draftId.toString() }, 200, 'sent', true],
    ['in progress', { kind: 'conflict', reason: 'already_sending' }, 409, undefined, false],
    ['unapproved', { kind: 'conflict', reason: 'not_approved' }, 409, undefined, false],
    ['stale approval', { kind: 'conflict', reason: 'stale_approval' }, 409, undefined, false],
    ['Human mode', { kind: 'conflict', reason: 'mode_changed' }, 409, undefined, false],
    ['definitive failure', { kind: 'send_failed', draftId: draftId.toString(), errorCode: 'provider_rejected' }, 502, 'send_failed', false],
    ['uncertain outcome', { kind: 'outcome_uncertain', draftId: draftId.toString(), errorCode: 'provider_timeout' }, 202, 'outcome_uncertain', false],
  ]

  for (const [label, sendResult, status, draftStatus, alreadySent] of cases) {
    await context.test(label, async () => {
      await withServer({ sendResult }, async (baseUrl) => {
        const { response, body } = await post(baseUrl, `/ai-drafts/${draftId}/send`, {})
        assert.equal(response.status, status)
        if (draftStatus) assert.equal(body.draft.status, draftStatus)
        if (alreadySent) assert.equal(body.draft.alreadySent, true)
        if (label === 'uncertain outcome') {
          assert.match(body.message, /could not be confirmed/i)
          assert.match(body.message, /will not be retried automatically/i)
          assert.equal(JSON.stringify(body).includes('provider_timeout'), false)
        }
        assert.equal(JSON.stringify(body).includes('credentials'), false)
        assert.equal(JSON.stringify(body).includes('phoneNumber'), false)
      })
    })
  }
})

test('repository applies business and conversation filters, projection, deterministic order and pagination', async () => {
  const originalFind = AiReplyJob.find
  const originalFindOne = AiReplyJob.findOne
  const originalCountDocuments = AiReplyJob.countDocuments
  const originalMessageFind = Message.find
  const calls = { find: undefined, detail: undefined, count: undefined }
  const query = (value) => ({
    select(fields) { this.fields = fields; return this },
    sort(sort) { this.sorting = sort; return this },
    skip(offset) { this.offset = offset; return this },
    limit(limit) { this.limitValue = limit; return this },
    lean() { return this },
    async exec() { return value },
  })

  try {
    AiReplyJob.find = (filter) => {
      calls.find = query([sampleDraft()])
      calls.find.filter = filter
      return calls.find
    }
    AiReplyJob.countDocuments = (filter) => {
      calls.count = filter
      return { async exec() { return 21 } }
    }
    AiReplyJob.findOne = (filter) => {
      calls.detail = filter
      return query(sampleDraft())
    }
    Message.find = (filter) => {
      calls.messageFilter = filter
      const messageQuery = query([{
        _id: inboundMessageId,
        businessId,
        conversationId,
        text: 'Do you have this in blue?',
        createdAt: now,
      }])
      messageQuery.lean = function () { return this }
      return messageQuery
    }

    const result = await listAiReplyDrafts({ businessId, page: 2, limit: 10, status: 'approved' })
    assert.equal(result.totalItems, 21)
    assert.deepEqual(calls.find.filter, { businessId, status: 'approved' })
    assert.deepEqual(calls.count, calls.find.filter)
    assert.deepEqual(calls.find.sorting, { createdAt: -1, _id: -1 })
    assert.equal(calls.find.offset, 10)
    assert.equal(calls.find.limitValue, 10)
    assert.deepEqual(calls.messageFilter, {
      businessId,
      direction: 'inbound',
      _id: { $in: [inboundMessageId] },
      conversationId: { $in: [conversationId] },
    })
    assert.deepEqual(result.drafts[0].sourceMessage, {
      _id: inboundMessageId,
      text: 'Do you have this in blue?',
      createdAt: now,
    })
    assert.equal(calls.find.fields.inboundMessageId, 1)
    for (const forbidden of ['attemptCount', 'leaseExpiresAt', 'sendAttemptId', 'providerMessageId']) {
      assert.equal(calls.find.fields[forbidden], undefined)
    }

    await listAiReplyDraftsForConversation({ businessId, conversationId, page: 1, limit: 20 })
    assert.deepEqual(calls.find.filter, { businessId, conversationId, status: 'draft_ready' })
  } finally {
    AiReplyJob.find = originalFind
    AiReplyJob.findOne = originalFindOne
    AiReplyJob.countDocuments = originalCountDocuments
    Message.find = originalMessageFind
  }
})

test('repository returns null when the source inbound message is missing or outside its business', async () => {
  const originalFindOne = AiReplyJob.findOne
  const originalMessageFind = Message.find
  const query = (value) => ({
    select() { return this },
    lean() { return this },
    async exec() { return value },
  })
  try {
    AiReplyJob.findOne = () => query(sampleDraft())
    Message.find = (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      return query([])
    }
    const result = await (await import('../dist/services/ai-reply-job.repository.js')).findAiReplyDraft(businessId, draftId)
    assert.equal(result.sourceMessage, null)
  } finally {
    AiReplyJob.findOne = originalFindOne
    Message.find = originalMessageFind
  }
})
