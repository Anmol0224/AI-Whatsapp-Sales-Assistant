import assert from 'node:assert/strict'
import test from 'node:test'
import { logAiPipelineTiming } from '../dist/services/ai-pipeline-telemetry.js'

test('pipeline timing logger serializes only allowlisted operational metadata', () => {
  const originalInfo = console.info
  const lines = []
  console.info = (line) => lines.push(line)

  try {
    logAiPipelineTiming({
      event: 'ai_pipeline.gemini_request',
      stage: 'gemini_generation',
      outcome: 'provider_timeout',
      durationMs: 15.4,
      jobId: '507f1f77bcf86cd799439011',
      attemptNumber: 2,
      prompt: 'PRIVATE_PROMPT',
      response: 'PRIVATE_RESPONSE',
      accessToken: 'PRIVATE_TOKEN',
      authorizationHeader: 'PRIVATE_HEADER',
      customerPhoneNumber: 'PRIVATE_PHONE',
      rawProviderError: new Error('PRIVATE_PROVIDER_ERROR'),
    })
  } finally {
    console.info = originalInfo
  }

  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'ai_pipeline.gemini_request',
    stage: 'gemini_generation',
    outcome: 'provider_timeout',
    durationMs: 15,
    jobId: '507f1f77bcf86cd799439011',
    attemptNumber: 2,
  })
  for (const privateValue of [
    'PRIVATE_PROMPT', 'PRIVATE_RESPONSE', 'PRIVATE_TOKEN', 'PRIVATE_HEADER',
    'PRIVATE_PHONE', 'PRIVATE_PROVIDER_ERROR',
  ]) {
    assert.equal(lines[0].includes(privateValue), false)
  }
})

test('pipeline timing logger drops malformed identifiers, categories and durations', () => {
  const originalInfo = console.info
  const lines = []
  console.info = (line) => lines.push(line)

  try {
    logAiPipelineTiming({
      event: 'ai_pipeline.queue_cycle',
      stage: 'queue_recovery_and_claim',
      outcome: 'idle',
      durationMs: Number.NaN,
      jobId: 'not-an-object-id',
      attemptNumber: 4,
      queueWaitMs: -1,
      recoveryDurationMs: 2,
      claimDurationMs: 3,
      rawQuery: 'must-not-appear',
    })
    logAiPipelineTiming({
      event: 'unexpected.event',
      stage: 'queue_recovery_and_claim',
      outcome: 'idle',
      durationMs: 1,
    })
  } finally {
    console.info = originalInfo
  }

  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'ai_pipeline.queue_cycle',
    stage: 'queue_recovery_and_claim',
    outcome: 'idle',
    recoveryDurationMs: 2,
    claimDurationMs: 3,
  })
  assert.equal(lines[0].includes('must-not-appear'), false)
})
