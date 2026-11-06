import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import { createBusinessRouter } from '../dist/routes/v1/business.routes.js'

const businessId = new Types.ObjectId()
const ownerUserId = new Types.ObjectId()

async function withServer(options, run) {
  const calls = []
  const settings = options.settings ?? { automaticRepliesEnabled: false }
  const dependencies = {
    async findAiSettings(requestBusinessId, requestOwnerId) {
      calls.push({ operation: 'get', businessId: requestBusinessId, ownerUserId: requestOwnerId })
      if (!requestBusinessId.equals(businessId) || !requestOwnerId.equals(ownerUserId) || options.businessExists === false) {
        return null
      }
      return { aiSettings: { ...settings } }
    },
    async updateAutomaticReplies(requestBusinessId, requestOwnerId, enabled, changedAt, policyVersion) {
      calls.push({
        operation: 'patch', businessId: requestBusinessId, ownerUserId: requestOwnerId,
        enabled, changedAt, policyVersion,
      })
      if (!requestBusinessId.equals(businessId) || !requestOwnerId.equals(ownerUserId) || options.businessExists === false) {
        return null
      }
      if (enabled) {
        settings.automaticRepliesEnabled = true
        settings.automaticRepliesEnabledAt = changedAt
        settings.automaticRepliesEnabledByUserId = requestOwnerId
      } else {
        settings.automaticRepliesEnabled = false
        settings.automaticRepliesDisabledAt = changedAt
        settings.automaticRepliesDisabledByUserId = requestOwnerId
      }
      settings.automaticRepliesPolicyVersion = policyVersion
      return { aiSettings: { ...settings } }
    },
  }
  const authentication = (request, response, next) => {
    if (request.get('authorization') !== 'Bearer owner-test-token') {
      response.status(401).json({ success: false, message: 'Authentication required.' })
      return
    }
    request.auth = { businessId: businessId.toString(), userId: ownerUserId.toString(), role: 'owner' }
    next()
  }
  const app = express()
  app.use(express.json())
  app.use('/business', createBusinessRouter(dependencies, authentication, () => options.globalEnabled === true))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, calls, settings)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function request(baseUrl, method, body, token = 'Bearer owner-test-token') {
  const response = await fetch(`${baseUrl}/business/ai-settings`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { response, body: await response.json() }
}

test('AI settings GET is authenticated, scoped to JWT owner/workspace, and safely reports gate and opt-in defaults', async () => {
  await withServer({}, async (baseUrl, calls) => {
    const result = await request(baseUrl, 'GET')
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body, {
      success: true,
      aiSettings: { automaticRepliesEnabled: false },
      automaticSendAvailable: false,
    })
    assert.equal(calls[0].businessId.toString(), businessId.toString())
    assert.equal(calls[0].ownerUserId.toString(), ownerUserId.toString())

    const unauthenticated = await request(baseUrl, 'GET', undefined, null)
    assert.equal(unauthenticated.response.status, 401)
  })
})

test('AI settings GET hides a business that is not owned by the authenticated user', async () => {
  await withServer({ businessExists: false }, async (baseUrl) => {
    const result = await request(baseUrl, 'GET')
    assert.equal(result.response.status, 404)
    assert.deepEqual(result.body, { success: false, message: 'Business not found.' })
  })
})

test('enabling requires the global gate and records the owner audit and policy version', async () => {
  await withServer({ globalEnabled: false }, async (baseUrl, calls) => {
    const blocked = await request(baseUrl, 'PATCH', { automaticRepliesEnabled: true })
    assert.equal(blocked.response.status, 409)
    assert.equal(blocked.body.code, 'automatic_send_disabled')
    assert.equal(calls.length, 0)
  })

  await withServer({ globalEnabled: true }, async (baseUrl, calls, settings) => {
    const result = await request(baseUrl, 'PATCH', { automaticRepliesEnabled: true })
    assert.equal(result.response.status, 200)
    assert.equal(result.body.aiSettings.automaticRepliesEnabled, true)
    assert.equal(result.body.automaticSendAvailable, true)
    assert.ok(settings.automaticRepliesEnabledAt instanceof Date)
    assert.equal(settings.automaticRepliesEnabledByUserId.toString(), ownerUserId.toString())
    assert.match(calls[0].policyVersion, /^[a-f\d-]{36}$/i)
  })
})

test('disabling is allowed with the global gate off and records the owner audit', async () => {
  await withServer({
    globalEnabled: false,
    settings: { automaticRepliesEnabled: true, automaticRepliesEnabledAt: new Date('2026-10-01T00:00:00.000Z') },
  }, async (baseUrl, calls, settings) => {
    const result = await request(baseUrl, 'PATCH', { automaticRepliesEnabled: false })
    assert.equal(result.response.status, 200)
    assert.equal(result.body.aiSettings.automaticRepliesEnabled, false)
    assert.equal(result.body.automaticSendAvailable, false)
    assert.ok(settings.automaticRepliesDisabledAt instanceof Date)
    assert.equal(settings.automaticRepliesDisabledByUserId.toString(), ownerUserId.toString())
    assert.equal(calls[0].enabled, false)
  })
})

test('AI settings PATCH rejects client scope fields and non-boolean values', async () => {
  await withServer({ globalEnabled: true }, async (baseUrl, calls) => {
    for (const body of [
      { automaticRepliesEnabled: true, businessId: new Types.ObjectId().toString() },
      { automaticRepliesEnabled: 'true' },
      {},
    ]) {
      const result = await request(baseUrl, 'PATCH', body)
      assert.equal(result.response.status, 400)
    }
    const unauthenticated = await request(baseUrl, 'PATCH', { automaticRepliesEnabled: true }, null)
    assert.equal(unauthenticated.response.status, 401)
    assert.equal(calls.length, 0)
  })
})
