import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiDraftWorkerRuntime } from '../dist/workers/ai-draft.worker.js'

test('disabled worker does not claim jobs', async () => {
  let cycles = 0
  const worker = createAiDraftWorkerRuntime({
    pollingIntervalMs: 250,
    async processNext() { cycles += 1; return { kind: 'idle' } },
  })

  assert.equal(worker.start(), false)
  await worker.stop()
  assert.equal(cycles, 0)
})

test('graceful shutdown stops new polling and waits for the current job cycle', async () => {
  let cycles = 0
  let announceStarted
  let releaseCycle
  const started = new Promise((resolve) => { announceStarted = resolve })
  const pendingCycle = new Promise((resolve) => { releaseCycle = resolve })
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 250,
    async processNext() {
      cycles += 1
      announceStarted()
      await pendingCycle
      return { kind: 'draft_ready' }
    },
  })

  assert.equal(worker.start(), true)
  await started
  const stopping = worker.stop()
  assert.equal(cycles, 1)
  releaseCycle()
  await stopping
  assert.equal(cycles, 1)
  assert.equal(worker.start(), true)
  await worker.stop()
})

test('worker reports only a safe generic iteration error and continues polling', async () => {
  let cycles = 0
  let errors = 0
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 250,
    async processNext() {
      cycles += 1
      if (cycles === 1) throw new Error('private provider response')
      return { kind: 'idle' }
    },
    onError() { errors += 1 },
  })

  worker.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await worker.stop()
  assert.equal(cycles, 1)
  assert.equal(errors, 1)
})
