import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGeminiService,
  GeminiServiceError,
  GEMINI_MAX_INPUT_BYTES,
  GEMINI_MAX_OUTPUT_CHARACTERS,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_REQUEST_TIMEOUT_MS,
} from '../dist/services/gemini.service.js'

const testOptions = { apiKey: 'test-only-placeholder', model: 'gemini-test-model' }

function providerReturning(response) {
  return () => ({ generateContent: async () => response })
}

async function assertCategory(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GeminiServiceError)
    assert.equal(error.category, category)
    return true
  })
}

test('normalizes a successful provider text response and applies bounded request settings', async () => {
  let observedRequest
  const service = createGeminiService(testOptions, () => ({
    generateContent: async (request) => {
      observedRequest = request
      return { text: '  Draft reply  ' }
    },
  }))

  const result = await service.generateText({ prompt: '  Customer asks about hours.  ' })

  assert.deepEqual(result, { text: 'Draft reply', model: testOptions.model })
  assert.equal(observedRequest.model, testOptions.model)
  assert.equal(observedRequest.contents, 'Customer asks about hours.')
  assert.equal(observedRequest.config.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS)
  assert.equal(observedRequest.config.automaticContinuation, false)
  assert.equal(observedRequest.config.httpOptions.timeout, GEMINI_REQUEST_TIMEOUT_MS)
  assert.deepEqual(observedRequest.config.httpOptions.retryOptions, { attempts: 1 })
})

test('reports missing credentials without creating a provider client', async () => {
  let providerCreated = false
  const service = createGeminiService({ model: testOptions.model }, () => {
    providerCreated = true
    return { generateContent: async () => ({ text: 'unused' }) }
  })

  await assertCategory(service.generateText({ prompt: 'Hello' }), 'missing_credentials')
  assert.equal(providerCreated, false)
})

test('maps provider timeouts to a safe timeout category', async () => {
  const timeout = Object.assign(new Error('private provider detail'), { name: 'RequestTimeoutError' })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw timeout } }))

  await assertCategory(service.generateText({ prompt: 'Hello' }), 'timeout')
})

test('maps rate-limit responses safely', async () => {
  const error = Object.assign(new Error('private provider detail'), { status: 429 })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))

  await assertCategory(service.generateText({ prompt: 'Hello' }), 'rate_limited')
})

test('maps authentication and permission failures separately', async (context) => {
  for (const [status, category] of [[401, 'authentication_failed'], [403, 'permission_denied']]) {
    await context.test(String(status), async () => {
      const error = Object.assign(new Error('private provider detail'), { status })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assertCategory(service.generateText({ prompt: 'Hello' }), category)
    })
  }
})

test('rejects empty and malformed provider responses', async (context) => {
  for (const [response, category] of [[{ text: '  ' }, 'empty_response'], [{ text: 42 }, 'invalid_response'], [null, 'invalid_response']]) {
    await context.test(category, async () => {
      const service = createGeminiService(testOptions, providerReturning(response))
      await assertCategory(service.generateText({ prompt: 'Hello' }), category)
    })
  }
})

test('maps unexpected provider errors without returning raw details', async () => {
  const service = createGeminiService(testOptions, () => ({
    generateContent: async () => { throw new Error('private provider detail') },
  }))

  await assert.rejects(service.generateText({ prompt: 'Hello' }), (error) => {
    assert.equal(error.category, 'provider_error')
    assert.equal(error.message.includes('private provider detail'), false)
    return true
  })
})

test('rejects oversized requests before calling the provider', async () => {
  let called = false
  const service = createGeminiService(testOptions, () => ({
    generateContent: async () => { called = true; return { text: 'unused' } },
  }))

  await assertCategory(
    service.generateText({ prompt: 'x'.repeat(GEMINI_MAX_INPUT_BYTES + 1) }),
    'input_too_large',
  )
  assert.equal(called, false)
})

test('rejects oversized output rather than silently truncating it', async () => {
  const service = createGeminiService(
    testOptions,
    providerReturning({ text: 'x'.repeat(GEMINI_MAX_OUTPUT_CHARACTERS + 1) }),
  )

  await assertCategory(service.generateText({ prompt: 'Hello' }), 'output_too_large')
})
