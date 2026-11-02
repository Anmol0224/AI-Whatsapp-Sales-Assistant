import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiSendRecoveryRuntime } from '../dist/services/ai-send-recovery.runtime.js'

function controlledSchedule() {
  let callback
  let cancelled = false
  return {
    schedule(next, intervalMs) {
      callback = next
      return () => { cancelled = true }
    },
    fire() { callback?.() },
    get cancelled() { return cancelled },
  }
}

test('recovery runtime prevents overlapping cycles and shutdown waits for active recovery', async () => {
  const clock = controlledSchedule()
  let calls = 0
  let announceStarted
  let releaseRecovery
  const started = new Promise((resolve) => { announceStarted = resolve })
  const blocked = new Promise((resolve) => { releaseRecovery = resolve })
  const runtime = createAiSendRecoveryRuntime({
    intervalMs: 30_000,
    batchLimit: 100,
    schedule: clock.schedule,
    async recover(_now, limit) {
      assert.equal(limit, 100)
      calls += 1
      announceStarted()
      await blocked
      return 1
    },
  })

  assert.equal(runtime.start(), true)
  await started
  clock.fire()
  clock.fire()
  assert.equal(calls, 1)

  let stopped = false
  const stopping = runtime.stop().then(() => { stopped = true })
  assert.equal(clock.cancelled, true)
  clock.fire()
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(stopped, false)

  releaseRecovery()
  await stopping
  assert.equal(stopped, true)
  assert.equal(runtime.start(), false)
})

test('recovery errors are safely reported and the next scheduled cycle can retry', async () => {
  const clock = controlledSchedule()
  const reported = []
  let attempts = 0
  let announceSecondAttempt
  const secondAttempt = new Promise((resolve) => { announceSecondAttempt = resolve })
  const runtime = createAiSendRecoveryRuntime({
    schedule: clock.schedule,
    async recover() {
      attempts += 1
      if (attempts === 1) throw new Error('private database details')
      announceSecondAttempt()
      return 0
    },
    onError(category) { reported.push(category) },
  })

  assert.equal(runtime.start(), true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(reported, ['database_recovery_failed'])

  clock.fire()
  await secondAttempt
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(attempts, 2)
  assert.deepEqual(reported, ['database_recovery_failed'])
  await runtime.stop()
})
