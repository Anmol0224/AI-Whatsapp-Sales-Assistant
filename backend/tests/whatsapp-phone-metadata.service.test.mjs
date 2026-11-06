import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWhatsAppPhoneMetadataVerifier,
  WhatsAppPhoneMetadataError,
} from '../dist/services/whatsapp-cloud-api.service.js'

const configuration = { accessToken: 'temporary-test-token', graphApiVersion: 'v26.0' }

test('metadata verifier makes one authenticated read-only GET and returns only allowlisted fields', async () => {
  let captured
  const verify = createWhatsAppPhoneMetadataVerifier({
    ...configuration,
    fetchImpl: async (url, options) => {
      captured = { url: new URL(url), options }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: '1234567890',
            display_phone_number: '+919876543210',
            verified_name: 'Example Business',
            quality_rating: 'GREEN',
            access_token: 'MUST_NOT_ESCAPE',
            private_field: 'MUST_NOT_ESCAPE',
          }
        },
      }
    },
  })

  const result = await verify('1234567890')
  assert.equal(captured.url.origin, 'https://graph.facebook.com')
  assert.equal(captured.url.pathname, '/v26.0/1234567890')
  assert.equal(captured.url.searchParams.get('fields'), 'id,display_phone_number,verified_name,quality_rating')
  assert.equal(captured.options.method, 'GET')
  assert.equal(captured.options.body, undefined)
  assert.equal(captured.options.headers.authorization, 'Bearer temporary-test-token')
  assert.deepEqual(result, {
    id: '1234567890',
    displayPhoneNumber: '+919876543210',
    verifiedName: 'Example Business',
    qualityRating: 'GREEN',
  })
  assert.equal(JSON.stringify(result).includes('MUST_NOT_ESCAPE'), false)
})

test('metadata verifier safely rejects missing configuration and malformed phone IDs without fetching', async () => {
  let fetches = 0
  const fetchImpl = async () => { fetches += 1; throw new Error('should not be called') }
  for (const [options, phoneId, category] of [
    [{ graphApiVersion: 'v26.0', fetchImpl }, '1234567890', 'missing_access_token'],
    [{ accessToken: 'token', fetchImpl }, '1234567890', 'missing_graph_api_version'],
    [{ ...configuration, fetchImpl }, 'not-a-number', 'invalid_phone_number_id'],
  ]) {
    const verify = createWhatsAppPhoneMetadataVerifier(options)
    await assert.rejects(verify(phoneId), (error) => error instanceof WhatsAppPhoneMetadataError && error.category === category)
  }
  assert.equal(fetches, 0)
})

test('Meta authentication, permission, invalid-ID, rate-limit, and server errors are safely categorized', async () => {
  const cases = [
    [401, 'provider_authentication_failed'],
    [403, 'missing_permissions'],
    [404, 'invalid_phone_number_id_at_provider'],
    [429, 'provider_rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ]
  for (const [status, category] of cases) {
    const verify = createWhatsAppPhoneMetadataVerifier({
      ...configuration,
      fetchImpl: async () => ({ ok: false, status, async json() { return { error: { message: 'SECRET_PROVIDER_BODY' } } } }),
    })
    await assert.rejects(verify('1234567890'), (error) =>
      error instanceof WhatsAppPhoneMetadataError && error.category === category && !error.message.includes('SECRET_PROVIDER_BODY'))
  }
})

test('known numeric Graph API error codes map to fixed categories without exposing response text', async () => {
  for (const [providerCode, category] of [
    [190, 'provider_authentication_failed'],
    [10, 'missing_permissions'],
    [200, 'missing_permissions'],
    [100, 'invalid_phone_number_id_at_provider'],
  ]) {
    const verify = createWhatsAppPhoneMetadataVerifier({
      ...configuration,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async json() { return { error: { code: providerCode, message: 'PRIVATE_PROVIDER_MESSAGE', token: 'SECRET' } } },
      }),
    })
    await assert.rejects(verify('1234567890'), (error) =>
      error.category === category && !error.message.includes('PRIVATE') && !error.message.includes('SECRET'))
  }
})

test('network, timeout, unexpected status, malformed payload, and missing required metadata stay safe', async () => {
  const networkVerifier = createWhatsAppPhoneMetadataVerifier({
    ...configuration,
    fetchImpl: async () => { throw new Error('SECRET_NETWORK_DETAILS') },
  })
  await assert.rejects(networkVerifier('1234567890'), (error) => error.category === 'provider_network_error' && !error.message.includes('SECRET'))

  const timeoutVerifier = createWhatsAppPhoneMetadataVerifier({
    ...configuration,
    fetchImpl: async () => { throw Object.assign(new Error('SECRET_TIMEOUT'), { name: 'TimeoutError' }) },
  })
  await assert.rejects(timeoutVerifier('1234567890'), (error) => error.category === 'provider_timeout')

  for (const response of [
    { ok: false, status: 400, async json() { return {} } },
    { ok: true, status: 200, async json() { throw new Error('SECRET_BODY') } },
    { ok: true, status: 200, async json() { return { display_phone_number: '+919876543210' } } },
    { ok: true, status: 200, async json() { return { id: '1234567890', verified_name: 'x'.repeat(257) } } },
  ]) {
    const verify = createWhatsAppPhoneMetadataVerifier({ ...configuration, fetchImpl: async () => response })
    await assert.rejects(verify('1234567890'), (error) => error.category === 'unexpected_provider_response')
  }
})
