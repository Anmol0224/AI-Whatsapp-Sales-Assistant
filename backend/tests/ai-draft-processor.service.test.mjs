import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { createAiDraftProcessor } from '../dist/services/ai-draft-processor.service.js'
import { GeminiServiceError } from '../dist/services/gemini.service.js'

const businessId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const jobId = new Types.ObjectId()
const now = new Date('2026-10-01T12:00:00.000Z')
const readyContext = {
  status: 'ready',
  serializedBytes: 200,
  context: {},
}
const readyPrompt = { status: 'ready', request: { prompt: 'bounded prompt' }, promptBytes: 100 }

function makeFakeRepository(overrides = {}) {
  const state = {
    mode: 'ai',
    status: 'queued',
    attemptCount: 0,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(now.getTime() - 1),
    generatedDraft: undefined,
    aiControlVersion: 0,
    errorCode: undefined,
    recoveryCalls: [],
    modeReads: 0,
    retryAt: undefined,
    ...overrides.state,
  }
  const calls = { claimed: 0, saved: 0, failed: 0, cancelled: 0, retried: 0 }

  const repository = {
    async recoverExpired(timestamp, maxAttempts) {
      state.recoveryCalls.push({ timestamp, maxAttempts })
      if (state.status === 'processing' && state.leaseExpiresAt <= timestamp) {
        if (state.attemptCount >= maxAttempts) {
          state.status = 'failed'
          state.errorCode = 'internal_error'
        } else {
          state.status = 'queued'
          state.nextAttemptAt = timestamp
        }
        state.leaseExpiresAt = null
      }
      return 1
    },
    async claimNext(timestamp) {
      if (state.status !== 'queued' || state.nextAttemptAt > timestamp || state.attemptCount >= 3) return null
      state.status = 'processing'
      state.attemptCount += 1
      state.leaseExpiresAt = new Date(timestamp.getTime() + 60_000)
      calls.claimed += 1
      return {
        _id: jobId,
        businessId,
        conversationId,
        inboundMessageId,
        attemptCount: state.attemptCount,
      }
    },
    async findConversationMode() {
      state.modeReads += 1
      return state.mode
    },
    async cancelCurrentAttempt(_business, _job, attemptCount, timestamp) {
      if (state.status !== 'processing' || state.attemptCount !== attemptCount || state.leaseExpiresAt <= timestamp) return null
      state.status = 'cancelled'
      state.leaseExpiresAt = null
      calls.cancelled += 1
      return { status: state.status }
    },
    async scheduleRetry(_business, _job, attemptCount, nextAttemptAt, errorCode, timestamp) {
      if (state.status !== 'processing' || state.attemptCount !== attemptCount || state.leaseExpiresAt <= timestamp) return null
      state.status = 'queued'
      state.nextAttemptAt = nextAttemptAt
      state.errorCode = errorCode
      state.leaseExpiresAt = null
      state.retryAt = nextAttemptAt
      calls.retried += 1
      return { status: state.status }
    },
    async markFailed(_business, _job, attemptCount, errorCode, timestamp) {
      if (state.status !== 'processing' || state.attemptCount !== attemptCount || state.leaseExpiresAt <= timestamp) return null
      state.status = 'failed'
      state.errorCode = errorCode
      state.leaseExpiresAt = null
      calls.failed += 1
      return { status: state.status }
    },
    async saveDraft(_business, _conversation, _job, attemptCount, draft) {
      if (state.mode !== 'ai' && state.mode !== 'ai_draft') return { kind: 'mode_changed' }
      if (state.status !== 'processing' || state.attemptCount !== attemptCount || state.leaseExpiresAt <= now) return { kind: 'stale' }
      state.status = 'draft_ready'
      state.generatedDraft = draft
      state.aiControlVersion += 1
      state.leaseExpiresAt = null
      calls.saved += 1
      return { kind: 'saved' }
    },
    ...overrides.repository,
  }
  return { repository, state, calls }
}

function makeProcessor({ repository, state, generator, contextResult = readyContext, promptResult = readyPrompt, nowFn = () => now }) {
  return createAiDraftProcessor({
    repository,
    contextService: { async retrieve() { return contextResult } },
    promptBuilder() { return promptResult },
    generator,
    now: nowFn,
  })
}

test('processes an AI-mode job and persists only the bounded owner-review draft', async () => {
  const { repository, state, calls } = makeFakeRepository()
  let generationRequest
  const processor = makeProcessor({
    repository,
    generator: { async generateText(request) { generationRequest = request; return { text: '  Here is a suggested reply.  ', model: 'configured-model' } } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'draft_ready' })
  assert.deepEqual(generationRequest, readyPrompt.request)
  assert.equal(state.status, 'draft_ready')
  assert.equal(state.generatedDraft, 'Here is a suggested reply.')
  assert.equal(calls.saved, 1)
  assert.equal(state.modeReads, 2)
})

test('ai_draft mode uses the existing owner-review generation path', async () => {
  const { repository, state } = makeFakeRepository({ state: { mode: 'ai_draft' } })
  let generated = 0
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { generated += 1; return { text: 'Draft for owner review' } } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'draft_ready' })
  assert.equal(generated, 1)
  assert.equal(state.status, 'draft_ready')
  assert.equal(state.generatedDraft, 'Draft for owner review')
})

test('claimed ai_automatic workflow is dispatched to the automatic processor, never the draft path', async () => {
  const { repository, calls } = makeFakeRepository()
  repository.claimNext = async () => ({
    _id: jobId, businessId, conversationId, inboundMessageId, attemptCount: 1,
    workflow: 'ai_automatic', status: 'processing',
  })
  let automaticCalls = 0
  let generatorCalls = 0
  const processor = createAiDraftProcessor({
    repository,
    contextService: { async retrieve() { assert.fail('automatic workflow must use its own pipeline') } },
    promptBuilder() { assert.fail('automatic workflow must not fall through to the draft prompt path') },
    generator: { async generateText() { generatorCalls += 1; return { text: 'No' } } },
    automaticProcessor: { async process(job) { automaticCalls += 1; assert.equal(job.workflow, 'ai_automatic'); return { kind: 'sent' } } },
    now: () => now,
  })
  assert.deepEqual(await processor.processNext(), { kind: 'sent' })
  assert.equal(automaticCalls, 1)
  assert.equal(generatorCalls, 0)
  assert.equal(calls.saved, 0)
})

test('human mode cancels a claimed job without generating', async () => {
  const { repository, state, calls } = makeFakeRepository({ state: { mode: 'human' } })
  let generated = false
  const processor = makeProcessor({ repository, generator: { async generateText() { generated = true; return { text: 'No' } } } })

  assert.deepEqual(await processor.processNext(), { kind: 'cancelled' })
  assert.equal(generated, false)
  assert.equal(state.status, 'cancelled')
  assert.equal(calls.cancelled, 1)
})

test('missing business context fails closed without generation', async () => {
  const { repository, state, calls } = makeFakeRepository()
  let generated = false
  const processor = makeProcessor({
    repository,
    contextResult: { status: 'unavailable', reason: 'insufficient_business_knowledge' },
    generator: { async generateText() { generated = true; return { text: 'Unsupported' } } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'context_unavailable' })
  assert.equal(generated, false)
  assert.equal(state.generatedDraft, undefined)
  assert.equal(calls.failed, 1)
})

test('retries a Gemini timeout with exponential backoff', async () => {
  const { repository, state } = makeFakeRepository()
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { throw new GeminiServiceError('timeout') } },
  })

  assert.deepEqual(await processor.processNext(), {
    kind: 'retry_scheduled',
    nextAttemptAt: new Date(now.getTime() + 1_000),
  })
  assert.equal(state.status, 'queued')
  assert.equal(state.errorCode, 'provider_timeout')
})

test('increases retry delay after the second generation attempt', async () => {
  const { repository } = makeFakeRepository({ state: { attemptCount: 1 } })
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { throw new GeminiServiceError('timeout') } },
  })

  const result = await processor.processNext()
  assert.equal(result.kind, 'retry_scheduled')
  assert.equal(result.nextAttemptAt.getTime(), now.getTime() + 2_000)
})

test('retries transient retrieval and database errors without exposing provider details', async (context) => {
  await context.test('context service reports a transient retrieval failure', async () => {
    const { repository, state } = makeFakeRepository()
    const processor = makeProcessor({
      repository,
      contextResult: { status: 'unavailable', reason: 'context_unavailable' },
      generator: { async generateText() { assert.fail('generation must not run') } },
    })
    assert.equal((await processor.processNext()).kind, 'retry_scheduled')
    assert.equal(state.errorCode, 'database_unavailable')
  })

  await context.test('conversation mode read reports a transient database failure', async () => {
    const { repository, state } = makeFakeRepository({
      repository: { async findConversationMode() { const error = new Error('private database detail'); error.name = 'MongoServerSelectionError'; throw error } },
    })
    const processor = makeProcessor({ repository, generator: { async generateText() { assert.fail('generation must not run') } } })
    assert.equal((await processor.processNext()).kind, 'retry_scheduled')
    assert.equal(state.errorCode, 'database_unavailable')
  })

  await context.test('transient draft persistence failure is scheduled for retry', async () => {
    const { repository, state } = makeFakeRepository({
      repository: { async saveDraft() { const error = new Error('private database detail'); error.name = 'MongoNetworkError'; throw error } },
    })
    const processor = makeProcessor({ repository, generator: { async generateText() { return { text: 'Suggested reply' } } } })
    assert.equal((await processor.processNext()).kind, 'retry_scheduled')
    assert.equal(state.errorCode, 'database_unavailable')
  })
})

test('ambiguous save acknowledgement does not schedule a duplicate generation after draft commit', async () => {
  const { repository, state } = makeFakeRepository({
    repository: {
      async saveDraft() {
        state.status = 'draft_ready'
        state.generatedDraft = 'Committed draft'
        const error = new Error('private database detail')
        error.name = 'MongoNetworkError'
        throw error
      },
    },
  })
  let generations = 0
  const processor = makeProcessor({ repository, generator: { async generateText() { generations += 1; return { text: 'Committed draft' } } } })

  assert.deepEqual(await processor.processNext(), { kind: 'stale' })
  assert.equal(state.status, 'draft_ready')
  assert.equal(generations, 1)
})

test('retries a provider rate limit but does not retry permanent authentication failures', async (context) => {
  await context.test('rate limit', async () => {
    const { repository, state } = makeFakeRepository()
    const processor = makeProcessor({ repository, generator: { async generateText() { throw new GeminiServiceError('rate_limited') } } })
    assert.equal((await processor.processNext()).kind, 'retry_scheduled')
    assert.equal(state.errorCode, 'provider_unavailable')
  })

  await context.test('authentication failure', async () => {
    const { repository, state } = makeFakeRepository()
    const processor = makeProcessor({ repository, generator: { async generateText() { throw new GeminiServiceError('authentication_failed') } } })
    assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'provider_unavailable' })
    assert.equal(state.status, 'failed')
    assert.equal(state.retryAt, undefined)
  })

  await context.test('missing credentials', async () => {
    const { repository, state } = makeFakeRepository()
    const processor = makeProcessor({ repository, generator: { async generateText() { throw new GeminiServiceError('missing_credentials') } } })
    assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'provider_unavailable' })
    assert.equal(state.status, 'failed')
    assert.equal(state.retryAt, undefined)
  })
})

test('logs safe Gemini diagnostics, retryability and generation duration without provider details', async (context) => {
  const originalInfo = console.info
  const lines = []
  console.info = (line) => lines.push(line)

  try {
    await context.test('provider 504 is categorized and retryable', async () => {
      const { repository } = makeFakeRepository()
      const processor = makeProcessor({
        repository,
        generator: {
          async generateText() {
            throw new GeminiServiceError('provider_error', {
              category: 'provider_5xx',
              httpStatus: 504,
            })
          },
        },
      })

      assert.equal((await processor.processNext()).kind, 'retry_scheduled')
      const event = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'ai_pipeline.gemini_request')
      assert.equal(event.outcome, 'provider_unavailable')
      assert.equal(event.providerCategory, 'provider_5xx')
      assert.equal(event.providerHttpStatus, 504)
      assert.equal(event.retryable, true)
      assert.equal(Number.isFinite(event.durationMs), true)
    })

    lines.length = 0
    await context.test('network failure retains only allowlisted code and is retryable', async () => {
      const { repository } = makeFakeRepository()
      const processor = makeProcessor({
        repository,
        generator: {
          async generateText() {
            throw new GeminiServiceError('provider_error', {
              category: 'network_error',
              networkCode: 'ECONNRESET',
            })
          },
        },
      })

      assert.equal((await processor.processNext()).kind, 'retry_scheduled')
      const event = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'ai_pipeline.gemini_request')
      assert.equal(event.providerCategory, 'network_error')
      assert.equal(event.providerNetworkCode, 'ECONNRESET')
      assert.equal(event.retryable, true)
    })

    lines.length = 0
    await context.test('authentication failure is safely categorized as non-retryable', async () => {
      const { repository } = makeFakeRepository()
      const processor = makeProcessor({
        repository,
        generator: {
          async generateText() {
            throw new GeminiServiceError('authentication_failed', {
              category: 'authentication_failed',
              httpStatus: 401,
            })
          },
        },
      })

      assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'provider_unavailable' })
      const event = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'ai_pipeline.gemini_request')
      assert.equal(event.providerCategory, 'authentication_failed')
      assert.equal(event.providerHttpStatus, 401)
      assert.equal(event.retryable, false)
    })
  } finally {
    console.info = originalInfo
  }

  const serialized = lines.join('\n')
  for (const privateValue of ['private provider detail', 'prompt', 'Authorization', 'api-key']) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('rejects empty, malformed, control-character, and over-limit model output without retry', async (context) => {
  for (const invalidText of ['', '   ', null, `x`.repeat(4_097), 'unsafe\u0000text']) {
    await context.test(String(invalidText).slice(0, 24), async () => {
      const { repository, state } = makeFakeRepository()
      const processor = makeProcessor({ repository, generator: { async generateText() { return { text: invalidText } } } })
      assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'invalid_output' })
      assert.equal(state.status, 'failed')
      assert.equal(state.retryAt, undefined)
    })
  }
})

test('human takeover during generation cancels the active attempt before persistence', async () => {
  const { repository, state, calls } = makeFakeRepository()
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { state.mode = 'human'; return { text: 'Suggested reply' } } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'cancelled' })
  assert.equal(state.generatedDraft, undefined)
  assert.equal(calls.saved, 0)
  assert.equal(calls.cancelled, 1)
})

test('attempt-count fencing prevents an older worker from saving over a newer attempt', async () => {
  const { repository, state, calls } = makeFakeRepository()
  const processor = makeProcessor({
    repository: { ...repository, async saveDraft() { state.attemptCount += 1; return null } },
    generator: { async generateText() { return { text: 'Suggested reply' } } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'stale' })
  assert.equal(state.generatedDraft, undefined)
  assert.equal(calls.saved, 0)
})

test('recovery runs before claim and reclaims an expired lease within the attempt limit', async () => {
  const { repository, state } = makeFakeRepository({
    state: {
      status: 'processing',
      attemptCount: 1,
      leaseExpiresAt: new Date(now.getTime() - 1),
    },
  })
  const processor = makeProcessor({ repository, generator: { async generateText() { return { text: 'Recovered draft' } } } })

  assert.deepEqual(await processor.processNext(), { kind: 'draft_ready' })
  assert.equal(state.recoveryCalls[0].maxAttempts, 3)
  assert.equal(state.attemptCount, 2)
})

test('expired lease after the maximum attempt count is failed rather than requeued', async () => {
  const { repository, state } = makeFakeRepository({
    state: {
      status: 'processing',
      attemptCount: 3,
      leaseExpiresAt: new Date(now.getTime() - 1),
    },
  })
  let generated = false
  const processor = makeProcessor({ repository, generator: { async generateText() { generated = true; return { text: 'Not expected' } } } })

  assert.deepEqual(await processor.processNext(), { kind: 'idle' })
  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'internal_error')
  assert.equal(generated, false)
})

test('does not exceed three claimed generation attempts', async () => {
  const { repository, state, calls } = makeFakeRepository({ state: { attemptCount: 2 } })
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { throw new GeminiServiceError('timeout') } },
  })

  assert.deepEqual(await processor.processNext(), { kind: 'failed', errorCode: 'provider_timeout' })
  assert.equal(state.attemptCount, 3)
  assert.equal(calls.retried, 0)
  assert.equal(calls.failed, 1)
})

test('concurrent processing calls cannot claim the same active job', async () => {
  const { repository, state, calls } = makeFakeRepository()
  let releaseGeneration
  const generationPending = new Promise((resolve) => { releaseGeneration = resolve })
  const processor = makeProcessor({
    repository,
    generator: { async generateText() { await generationPending; return { text: 'One draft' } } },
  })

  const first = processor.processNext()
  await new Promise((resolve) => setImmediate(resolve))
  const second = await processor.processNext()
  assert.deepEqual(second, { kind: 'idle' })
  assert.equal(calls.claimed, 1)
  releaseGeneration()
  assert.deepEqual(await first, { kind: 'draft_ready' })
  assert.equal(state.generatedDraft, 'One draft')
})
