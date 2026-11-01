import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import { createConversationsRouter } from '../dist/routes/v1/conversations.routes.js'

const businessId = new Types.ObjectId()
const userId = new Types.ObjectId()
const conversationId = new Types.ObjectId()

async function withServer(changeResponseMode, run, readResponseMode = async () => ({ responseMode: 'ai' })) {
  const calls = []
  const dependencies = {
    async listConversations() { return { items: [], totalItems: 0 } },
    async findConversation() { return null },
    async listMessages() { return { items: [], totalItems: 0 } },
    async findCustomer() { return null },
    async findBusiness() { return null },
    async getResponseMode(id, ownerBusinessId) {
      calls.push({ operation: 'get', businessId: ownerBusinessId, conversationId: id })
      return readResponseMode(id, ownerBusinessId)
    },
    async sendText() { throw new Error('not called') },
    async createMessage() { throw new Error('not called') },
    async findMessageByProviderId() { return null },
    async updateConversationSummary() { return false },
    async changeResponseMode(ownerBusinessId, id, mode) {
      calls.push({ businessId: ownerBusinessId, conversationId: id, mode })
      return changeResponseMode(mode)
    },
  }
  const auth = (request, response, next) => {
    if (request.get('authorization') !== 'Bearer owner-test-token') {
      response.status(401).json({ success: false, message: 'Authentication required.' })
      return
    }
    request.auth = { businessId: businessId.toString(), userId: userId.toString(), role: 'owner' }
    next()
  }
  const app = express()
  app.use(express.json())
  app.use('/conversations', createConversationsRouter(dependencies, auth))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, calls)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function patch(baseUrl, path, body, token = 'Bearer owner-test-token') {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

async function get(baseUrl, path, token = 'Bearer owner-test-token') {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: token } : {},
  })
  return { response, body: await response.json() }
}

test('response-mode GET returns the owned conversation mode without changing it', async () => {
  await withServer(() => { throw new Error('GET must not change mode') }, async (baseUrl, calls) => {
    const result = await get(baseUrl, `/conversations/${conversationId}/response-mode`)
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body, {
      success: true,
      conversation: { id: conversationId.toString(), responseMode: 'ai' },
    })
    assert.equal(calls[0].operation, 'get')
    assert.equal(calls[0].businessId.toString(), businessId.toString())
    assert.equal(calls[0].conversationId.toString(), conversationId.toString())

    const unauthorized = await get(baseUrl, `/conversations/${conversationId}/response-mode`, null)
    assert.equal(unauthorized.response.status, 401)
    const invalidId = await get(baseUrl, '/conversations/not-an-id/response-mode')
    assert.equal(invalidId.response.status, 400)
  })
})

test('response-mode GET hides inaccessible conversations', async () => {
  await withServer(() => ({ kind: 'updated', responseMode: 'ai' }), async (baseUrl, calls) => {
    const result = await get(baseUrl, `/conversations/${conversationId}/response-mode`)
    assert.equal(result.response.status, 404)
    assert.deepEqual(result.body, { success: false, message: 'Conversation not found.' })
    assert.equal(calls[0].businessId.toString(), businessId.toString())
  }, async () => null)
})

test('response-mode endpoint validates owner request and scopes conversation by JWT business', async () => {
  await withServer((mode) => ({ kind: 'updated', responseMode: mode }), async (baseUrl, calls) => {
    const human = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, { responseMode: 'human' })
    assert.equal(human.response.status, 200)
    assert.equal(human.body.conversation.responseMode, 'human')
    assert.equal(calls[0].businessId.toString(), businessId.toString())
    assert.equal(calls[0].conversationId.toString(), conversationId.toString())

    const unauthenticated = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, { responseMode: 'ai' }, null)
    assert.equal(unauthenticated.response.status, 401)
    const invalidId = await patch(baseUrl, '/conversations/not-an-id/response-mode', { responseMode: 'ai' })
    assert.equal(invalidId.response.status, 400)
    const invalidMode = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, { responseMode: 'auto' })
    assert.equal(invalidMode.response.status, 400)
    const unknownField = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, {
      responseMode: 'ai', businessId: new Types.ObjectId().toString(),
    })
    assert.equal(unknownField.response.status, 400)
  })
})

test('active reservation returns conflict and AI resume reports the resulting mode', async () => {
  await withServer((mode) => mode === 'human'
    ? { kind: 'send_in_progress' }
    : { kind: 'updated', responseMode: 'ai' }, async (baseUrl) => {
    const activeSend = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, { responseMode: 'human' })
    assert.equal(activeSend.response.status, 409)
    assert.equal(activeSend.body.code, 'send_in_progress')

    const resumed = await patch(baseUrl, `/conversations/${conversationId}/response-mode`, { responseMode: 'ai' })
    assert.equal(resumed.response.status, 200)
    assert.equal(resumed.body.conversation.responseMode, 'ai')
  })
})
