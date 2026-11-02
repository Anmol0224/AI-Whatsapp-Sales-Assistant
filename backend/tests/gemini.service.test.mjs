import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '@google/genai'
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

test('GeminiServiceError always exposes the optional safe diagnostic contract', () => {
  const withoutDiagnostic = new GeminiServiceError('timeout')
  assert.equal(withoutDiagnostic.diagnostic, undefined)

  const withDiagnostic = new GeminiServiceError('provider_error', {
    category: 'provider_5xx',
    httpStatus: 504,
  })
  assert.deepEqual(withDiagnostic.diagnostic, {
    category: 'provider_5xx',
    httpStatus: 504,
  })
})

test('maps provider timeouts to a safe timeout category', async () => {
  const timeout = Object.assign(new Error('private provider detail'), { name: 'APIConnectionTimeoutError' })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw timeout } }))

  await assert.rejects(service.generateText({ prompt: 'Hello' }), (error) => {
    assert.equal(error.category, 'timeout')
    assert.deepEqual(error.diagnostic, { category: 'timeout' })
    return true
  })
})

test('maps rate-limit responses safely', async () => {
  const error = new ApiError({ status: 429, message: 'private provider detail' })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))

  await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
    assert.equal(caught.category, 'rate_limited')
    assert.deepEqual(caught.diagnostic, { category: 'rate_limited', httpStatus: 429 })
    assert.equal(JSON.stringify(caught.diagnostic).includes('private provider detail'), false)
    return true
  })
})

test('maps authentication and permission failures separately', async (context) => {
  for (const [status, category] of [[401, 'authentication_failed'], [403, 'permission_denied']]) {
    await context.test(String(status), async () => {
      const error = new ApiError({ status, message: 'private provider detail' })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
        assert.equal(caught.category, category)
        assert.deepEqual(caught.diagnostic, { category, httpStatus: status })
        return true
      })
    })
  }
})

test('reports only selected provider 5xx statuses', async (context) => {
  for (const status of [500, 502, 503, 504]) {
    await context.test(String(status), async () => {
      const error = Object.assign(new Error('private provider body'), {
        name: 'InternalServerError', status, statusCode: status,
        body: 'private body', headers: { authorization: 'private header' },
      })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'synthetic prompt' }), (caught) => {
        assert.equal(caught.category, 'provider_error')
        assert.deepEqual(caught.diagnostic, { category: 'provider_5xx', httpStatus: status })
        assert.equal(JSON.stringify(caught.diagnostic).includes('private'), false)
        return true
      })
    })
  }
})

test('omits unrecognized and malformed HTTP statuses', async (context) => {
  for (const [label, fields] of [
    ['unknown numeric status', { status: 418, statusCode: 418 }],
    ['out of range status', { status: 599, statusCode: 599 }],
    ['string status', { status: '429', statusCode: '429' }],
    ['conflicting statuses', { status: 429, statusCode: 503 }],
  ]) {
    await context.test(label, async () => {
      const error = Object.assign(new Error('private message'), { name: 'APIError', ...fields })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
        assert.equal(caught.category, 'provider_error')
        assert.deepEqual(caught.diagnostic, { category: 'provider_error' })
        return true
      })
    })
  }
})

test('does not trust status-shaped fields on non-SDK errors', async () => {
  const error = Object.assign(new Error('private detail'), { status: 429, statusCode: 503 })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))

  await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
    assert.equal(caught.category, 'provider_error')
    assert.deepEqual(caught.diagnostic, { category: 'provider_error' })
    return true
  })
})

test('adds timeout diagnostics for HTTP 408 without changing the service error category', async () => {
  const error = Object.assign(new Error('private provider detail'), {
    name: 'APIError', status: 408, statusCode: 408,
  })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))

  await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
    assert.equal(caught.category, 'provider_error')
    assert.deepEqual(caught.diagnostic, { category: 'timeout', httpStatus: 408 })
    return true
  })
})

test('classifies only exact SDK timeout and connection names', async (context) => {
  for (const [name, category] of [
    ['APIConnectionTimeoutError', 'timeout'],
    ['RequestTimeoutError', 'timeout'],
    ['APIConnectionError', 'network_error'],
    ['ConnectionError', 'network_error'],
  ]) {
    await context.test(name, async () => {
      const error = Object.assign(new Error('private provider detail'), { name })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
        assert.equal(caught.diagnostic.category, category)
        return true
      })
    })
  }

  for (const name of ['SomeTimeoutError', 'AbortError', 'TimeoutLikeError']) {
    await context.test(`does not infer from ${name}`, async () => {
      const error = Object.assign(new Error('private provider detail'), { name, code: 'ETIMEDOUT' })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'Hello' }), (caught) => {
        assert.equal(caught.category, 'provider_error')
        assert.deepEqual(caught.diagnostic, { category: 'provider_error' })
        return true
      })
    })
  }
})

test('extracts only allowlisted network codes through at most two causes', async (context) => {
  for (const [label, cause, expected] of [
    ['direct cause', Object.assign(new Error('private cause'), { code: 'ECONNRESET' }), 'ECONNRESET'],
    ['second cause', Object.assign(new Error('private inner'), { cause: Object.assign(new Error('private cause'), { code: 'EAI_AGAIN' }) }), 'EAI_AGAIN'],
    ['unknown code', Object.assign(new Error('private cause'), { code: 'PRIVATE_CODE' }), undefined],
    ['third-level code', Object.assign(new Error('depth one'), { cause: Object.assign(new Error('depth two'), { cause: Object.assign(new Error('depth three'), { code: 'ETIMEDOUT' }) }) }), undefined],
  ]) {
    await context.test(label, async () => {
      const error = Object.assign(new Error('private provider detail'), { name: 'APIConnectionError', cause })
      const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))
      await assert.rejects(service.generateText({ prompt: 'synthetic prompt' }), (caught) => {
        assert.equal(caught.category, 'provider_error')
        assert.deepEqual(caught.diagnostic, {
          category: 'network_error',
          ...(expected === undefined ? {} : { networkCode: expected }),
        })
        assert.equal(JSON.stringify(caught.diagnostic).includes('private'), false)
        return true
      })
    })
  }
})

test('diagnostics never contain provider messages, payloads, headers, prompts, or response bodies', async () => {
  const error = Object.assign(new Error('private provider message'), {
    name: 'InternalServerError',
    status: 503,
    statusCode: 503,
    body: 'private response body',
    error: { message: 'private payload' },
    headers: { authorization: 'private authorization header' },
    rawResponse: 'private raw response',
  })
  const service = createGeminiService(testOptions, () => ({ generateContent: async () => { throw error } }))

  await assert.rejects(service.generateText({ prompt: 'private prompt' }), (caught) => {
    assert.deepEqual(caught.diagnostic, { category: 'provider_5xx', httpStatus: 503 })
    const diagnostic = JSON.stringify(caught.diagnostic)
    for (const secret of ['private provider message', 'private response body', 'private payload', 'private authorization header', 'private raw response', 'private prompt']) {
      assert.equal(diagnostic.includes(secret), false)
    }
    assert.equal(caught.message.includes('private'), false)
    return true
  })
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
