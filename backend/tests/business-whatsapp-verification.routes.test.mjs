import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import { createBusinessRouter } from '../dist/routes/v1/business.routes.js'
import { WhatsAppPhoneMetadataError } from '../dist/services/whatsapp-cloud-api.service.js'

const businessId = new Types.ObjectId()
const ownerUserId = new Types.ObjectId()

async function withServer(options, run) {
  const calls = []
  const state = {
    exists: options.businessExists !== false,
    whatsapp: options.whatsapp ?? {
      phoneNumberId: '1234567890',
      displayNumber: '+919876543210',
      connectionStatus: 'configured_not_verified',
    },
  }
  const owned = (requestBusinessId, requestOwnerId) =>
    requestBusinessId.equals(businessId) && requestOwnerId.equals(ownerUserId) && state.exists
  const verificationDependencies = {
    async findWhatsAppSettings(requestBusinessId, requestOwnerId) {
      calls.push({ operation: 'find', businessId: requestBusinessId, ownerUserId: requestOwnerId })
      return owned(requestBusinessId, requestOwnerId) ? { whatsapp: { ...state.whatsapp } } : null
    },
    async saveWhatsAppSettings(requestBusinessId, requestOwnerId, phoneNumberId, displayNumber) {
      calls.push({ operation: 'save', businessId: requestBusinessId, ownerUserId: requestOwnerId, phoneNumberId })
      if (!owned(requestBusinessId, requestOwnerId)) return null
      state.whatsapp = {
        phoneNumberId,
        ...(displayNumber ? { displayNumber } : state.whatsapp.displayNumber ? { displayNumber: state.whatsapp.displayNumber } : {}),
        connectionStatus: 'configured_not_verified',
      }
      return { whatsapp: { ...state.whatsapp } }
    },
    async beginWhatsAppVerification(requestBusinessId, requestOwnerId, phoneNumberId, attemptedAt) {
      calls.push({ operation: 'begin', businessId: requestBusinessId, ownerUserId: requestOwnerId, phoneNumberId })
      if (!owned(requestBusinessId, requestOwnerId) || state.whatsapp.phoneNumberId !== phoneNumberId) return false
      state.whatsapp = { phoneNumberId, displayNumber: state.whatsapp.displayNumber, connectionStatus: 'configured_not_verified', lastVerificationAt: attemptedAt }
      return true
    },
    async completeWhatsAppVerification(requestBusinessId, requestOwnerId, phoneNumberId, metadata, verifiedAt) {
      calls.push({ operation: 'complete', businessId: requestBusinessId, ownerUserId: requestOwnerId, phoneNumberId })
      if (!owned(requestBusinessId, requestOwnerId) || state.whatsapp.phoneNumberId !== phoneNumberId) return null
      state.whatsapp = {
        ...state.whatsapp,
        connectionStatus: 'verified',
        verifiedPhoneNumberId: metadata.id,
        lastVerificationAt: verifiedAt,
        ...(metadata.displayPhoneNumber ? { verifiedDisplayNumber: metadata.displayPhoneNumber } : {}),
        ...(metadata.verifiedName ? { verifiedName: metadata.verifiedName } : {}),
        ...(metadata.qualityRating ? { qualityRating: metadata.qualityRating } : {}),
      }
      return { whatsapp: { ...state.whatsapp } }
    },
    async failWhatsAppVerification(requestBusinessId, requestOwnerId, phoneNumberId, category, failedAt) {
      calls.push({ operation: 'fail', businessId: requestBusinessId, ownerUserId: requestOwnerId, phoneNumberId, category })
      if (!owned(requestBusinessId, requestOwnerId) || state.whatsapp.phoneNumberId !== phoneNumberId) return null
      state.whatsapp = {
        phoneNumberId,
        displayNumber: state.whatsapp.displayNumber,
        connectionStatus: 'verification_failed',
        verificationFailureCategory: category,
        lastVerificationAt: failedAt,
      }
      return { whatsapp: { ...state.whatsapp } }
    },
    async verifyPhoneNumber(phoneNumberId) {
      calls.push({ operation: 'provider', phoneNumberId })
      if (options.providerError) throw options.providerError
      if (options.changeNumberDuringProvider) state.whatsapp.phoneNumberId = '9999999999'
      return options.metadata ?? {
        id: phoneNumberId,
        displayPhoneNumber: '+919876543210',
        verifiedName: 'Example Business',
        qualityRating: 'GREEN',
      }
    },
  }
  const auth = (request, response, next) => {
    if (request.get('authorization') !== 'Bearer owner-test-token') {
      response.status(401).json({ success: false, message: 'Authentication required.' })
      return
    }
    request.auth = { businessId: businessId.toString(), userId: ownerUserId.toString(), role: 'owner' }
    next()
  }
  const app = express()
  app.use(express.json())
  app.use('/business', createBusinessRouter({ findAiSettings: async () => null, updateAutomaticReplies: async () => null }, auth, () => false, verificationDependencies))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, calls, state)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function request(baseUrl, path, method = 'POST', body = {}, token = 'Bearer owner-test-token') {
  const response = await fetch(`${baseUrl}/business${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { response, body: await response.json() }
}

test('WhatsApp verification authenticates owner scope and persists only safe matching Meta metadata', async () => {
  await withServer({}, async (baseUrl, calls, state) => {
    const result = await request(baseUrl, '/whatsapp/verify')
    assert.equal(result.response.status, 200)
    assert.equal(result.body.whatsapp.connectionStatus, 'verified')
    assert.equal(result.body.whatsapp.verifiedPhoneNumberId, '1234567890')
    assert.equal(result.body.whatsapp.verifiedDisplayNumber, '+919876543210')
    assert.equal(result.body.whatsapp.verifiedName, 'Example Business')
    assert.equal(result.body.whatsapp.qualityRating, 'GREEN')
    assert.equal('credentialRef' in result.body.whatsapp, false)
    assert.equal('accessToken' in result.body.whatsapp, false)
    assert.equal(calls.find((call) => call.operation === 'provider').phoneNumberId, '1234567890')
    assert.equal(calls.find((call) => call.operation === 'begin').businessId.toString(), businessId.toString())
    assert.equal(calls.find((call) => call.operation === 'begin').ownerUserId.toString(), ownerUserId.toString())
    assert.ok(state.whatsapp.lastVerificationAt instanceof Date)
  })
})

test('verification rejects unauthenticated, inaccessible, missing-number, and non-empty-body requests', async () => {
  await withServer({}, async (baseUrl, calls) => {
    assert.equal((await request(baseUrl, '/whatsapp/verify', 'POST', {}, null)).response.status, 401)
    assert.equal((await request(baseUrl, '/whatsapp/verify', 'POST', { phoneNumberId: '999' })).response.status, 400)
    assert.equal(calls.length, 0)
  })
  await withServer({ businessExists: false }, async (baseUrl) => {
    assert.equal((await request(baseUrl, '/whatsapp/verify')).response.status, 404)
  })
  await withServer({ whatsapp: { connectionStatus: 'not_configured' } }, async (baseUrl, calls) => {
    const result = await request(baseUrl, '/whatsapp/verify')
    assert.equal(result.response.status, 409)
    assert.equal(result.body.code, 'missing_phone_number_id')
    assert.equal(calls.some((call) => call.operation === 'provider'), false)
  })
})

test('provider authentication and permission failures clear any prior success metadata', async () => {
  for (const [category, status] of [
    ['missing_access_token', 422],
    ['provider_authentication_failed', 422],
    ['missing_permissions', 422],
  ]) {
    await withServer({
      whatsapp: {
        phoneNumberId: '1234567890', connectionStatus: 'verified', verifiedPhoneNumberId: '1234567890',
        verifiedName: 'Old Name', verifiedDisplayNumber: '+919999999999', qualityRating: 'GREEN',
      },
      providerError: new WhatsAppPhoneMetadataError(category),
    }, async (baseUrl, calls, state) => {
      const result = await request(baseUrl, '/whatsapp/verify')
      assert.equal(result.response.status, status)
      assert.equal(result.body.code, category)
      assert.equal(result.body.whatsapp.connectionStatus, 'verification_failed')
      assert.equal(result.body.whatsapp.verificationFailureCategory, category)
      assert.equal('verifiedName' in result.body.whatsapp, false)
      assert.equal('verifiedPhoneNumberId' in result.body.whatsapp, false)
      assert.equal(state.whatsapp.connectionStatus, 'verification_failed')
      assert.equal(calls.filter((call) => call.operation === 'provider').length, 1)
    })
  }
})

test('provider timeout and server failures return safe categories and persist failed status', async () => {
  for (const [category, status] of [['provider_timeout', 504], ['provider_unavailable', 502]]) {
    await withServer({ providerError: new WhatsAppPhoneMetadataError(category) }, async (baseUrl) => {
      const result = await request(baseUrl, '/whatsapp/verify')
      assert.equal(result.response.status, status)
      assert.equal(result.body.code, category)
      assert.equal(result.body.whatsapp.connectionStatus, 'verification_failed')
    })
  }
})

test('mismatched Meta ID is not marked verified and concurrent number changes reject stale verification', async () => {
  await withServer({ metadata: { id: '0000000000' } }, async (baseUrl) => {
    const mismatch = await request(baseUrl, '/whatsapp/verify')
    assert.equal(mismatch.response.status, 502)
    assert.equal(mismatch.body.code, 'phone_number_id_mismatch')
    assert.equal(mismatch.body.whatsapp.connectionStatus, 'verification_failed')
  })
  await withServer({ changeNumberDuringProvider: true }, async (baseUrl) => {
    const stale = await request(baseUrl, '/whatsapp/verify')
    assert.equal(stale.response.status, 409)
    assert.equal(stale.body.code, 'configuration_changed')
  })
})

test('saving settings invalidates an existing verification and never accepts verification metadata from the client', async () => {
  await withServer({ whatsapp: {
    phoneNumberId: '1234567890', displayNumber: '+919876543210', connectionStatus: 'verified',
    verifiedPhoneNumberId: '1234567890', verifiedName: 'Example Business', lastVerificationAt: new Date(),
  } }, async (baseUrl, calls) => {
    const result = await request(baseUrl, '/whatsapp', 'PATCH', {
      phoneNumberId: '9876543210', displayNumber: '+911234567890', verifiedName: 'Spoofed',
    })
    assert.equal(result.response.status, 400)
    const valid = await request(baseUrl, '/whatsapp', 'PATCH', { phoneNumberId: '9876543210' })
    assert.equal(valid.response.status, 200)
    assert.equal(valid.body.whatsapp.connectionStatus, 'configured_not_verified')
    assert.equal('verifiedName' in valid.body.whatsapp, false)
    assert.equal('lastVerificationAt' in valid.body.whatsapp, false)
    assert.equal(calls.some((call) => call.operation === 'provider'), false)
  })
})
