import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiDraftWorkerRuntime } from '../dist/workers/ai-draft.worker.js'
import { wakeAiDraftWorker } from '../dist/services/ai-draft-worker-wake.js'

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

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

test('worker immediately attempts the next job after a completed job', async () => {
  let cycles = 0
  let announceSecondCycle
  const secondCycle = new Promise((resolve) => { announceSecondCycle = resolve })
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 250,
    async processNext() {
      cycles += 1
      if (cycles === 2) announceSecondCycle()
      return cycles === 1 ? { kind: 'draft_ready' } : { kind: 'idle' }
    },
  })

  worker.start()
  await secondCycle
  await worker.stop()
  assert.equal(cycles, 2)
})

test('default idle polling remains five seconds', async () => {
  const originalSetTimeout = globalThis.setTimeout
  let observedDelay
  globalThis.setTimeout = function (callback, delay, ...args) {
    if (delay === 5_000) observedDelay = delay
    return originalSetTimeout(callback, delay, ...args)
  }

  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    async processNext() { return { kind: 'idle' } },
  })

  try {
    worker.start()
    for (let attempt = 0; attempt < 20 && observedDelay === undefined; attempt += 1) {
      await nextTurn()
    }
    assert.equal(observedDelay, 5_000)
  } finally {
    await worker.stop()
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a committed-job wake interrupts an idle polling wait', async () => {
  let cycles = 0
  let announceIdleCycle
  let announceWakeCycle
  const idleCycle = new Promise((resolve) => { announceIdleCycle = resolve })
  const wakeCycle = new Promise((resolve) => { announceWakeCycle = resolve })
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 5_000,
    async processNext() {
      cycles += 1
      if (cycles === 1) announceIdleCycle()
      if (cycles === 2) announceWakeCycle()
      return { kind: 'idle' }
    },
  })

  worker.start()
  await idleCycle
  wakeAiDraftWorker()
  await wakeCycle
  await worker.stop()
  assert.equal(cycles, 2)
})

test('wake signals during processing are coalesced without overlapping cycles or being lost', async () => {
  let cycles = 0
  let activeCycles = 0
  let maximumActiveCycles = 0
  let announceFirstCycle
  let releaseFirstCycle
  let announceSecondCycle
  const firstCycle = new Promise((resolve) => { announceFirstCycle = resolve })
  const secondCycle = new Promise((resolve) => { announceSecondCycle = resolve })
  const firstCycleGate = new Promise((resolve) => { releaseFirstCycle = resolve })
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 5_000,
    async processNext() {
      activeCycles += 1
      maximumActiveCycles = Math.max(maximumActiveCycles, activeCycles)
      cycles += 1
      try {
        if (cycles === 1) {
          announceFirstCycle()
          await firstCycleGate
          return { kind: 'idle' }
        }
        if (cycles === 2) announceSecondCycle()
        return { kind: 'idle' }
      } finally {
        activeCycles -= 1
      }
    },
  })

  worker.start()
  await firstCycle
  wakeAiDraftWorker()
  wakeAiDraftWorker()
  assert.equal(cycles, 1)
  releaseFirstCycle()
  await secondCycle
  await worker.stop()

  assert.equal(cycles, 2)
  assert.equal(maximumActiveCycles, 1)
})

test('idle polling discovers queued work when no wake signal is received', async () => {
  let cycles = 0
  let announceJob
  const jobProcessed = new Promise((resolve) => { announceJob = resolve })
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 250,
    async processNext() {
      cycles += 1
      if (cycles === 3) announceJob()
      return cycles < 3 ? { kind: 'idle' } : { kind: 'draft_ready' }
    },
  })

  worker.start()
  await jobProcessed
  await worker.stop()
  assert.equal(cycles, 3)
})

test('retry-scheduled work is not reprocessed before nextAttemptAt', async () => {
  let cycles = 0
  let retryAttemptAt
  let announceRetry
  const retryAttempted = new Promise((resolve) => { announceRetry = resolve })
  let nextAttemptAt = 0
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 250,
    async processNext() {
      cycles += 1
      if (cycles === 1) {
        nextAttemptAt = Date.now() + 600
        return { kind: 'retry_scheduled', nextAttemptAt: new Date(nextAttemptAt) }
      }
      if (Date.now() < nextAttemptAt) return { kind: 'idle' }
      retryAttemptAt = Date.now()
      announceRetry()
      return { kind: 'draft_ready' }
    },
  })

  worker.start()
  await retryAttempted
  await worker.stop()
  assert.ok(retryAttemptAt >= nextAttemptAt)
  assert.ok(cycles >= 3)
})

test('wake after shutdown does not start another claim cycle', async () => {
  let cycles = 0
  const worker = createAiDraftWorkerRuntime({
    enabled: true,
    pollingIntervalMs: 5_000,
    async processNext() { cycles += 1; return { kind: 'idle' } },
  })

  worker.start()
  await nextTurn()
  await worker.stop()
  const cyclesAtStop = cycles
  wakeAiDraftWorker()
  await nextTurn()
  assert.equal(cycles, cyclesAtStop)
})
