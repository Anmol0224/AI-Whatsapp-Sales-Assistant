import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { Types } from 'mongoose'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import {
  createAiReplyDraftTransitions,
  saveAiReplyDraft,
  takeOverConversation,
} from '../dist/services/ai-reply-job.repository.js'

const businessId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const jobId = new Types.ObjectId()
const now = new Date('2026-10-01T12:00:00.000Z')

function cloneState(state) {
  return {
    conversation: { ...state.conversation },
    job: { ...state.job },
  }
}

function makeTransitionHarness({ pauseAfterFence = null, failJobWriteOnce = false } = {}) {
  const state = {
    conversation: {
      businessId,
      id: conversationId,
      responseMode: 'ai',
      aiControlVersion: 0,
    },
    job: {
      businessId,
      conversationId,
      id: jobId,
      inboundMessageId: new Types.ObjectId(),
      status: 'processing',
      attemptCount: 2,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      generatedDraft: undefined,
    },
  }
  const metrics = { transactionAttempts: 0, endedSessions: 0, takeoverWrites: 0, draftWrites: 0 }
  let shouldFailJobWrite = failJobWriteOnce
  let lockTail = Promise.resolve()

  async function withLock(callback) {
    const previous = lockTail
    let release
    lockTail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await callback()
    } finally {
      release()
    }
  }

  const operations = {
    async startSession() {
      return {
        async withTransaction(callback) {
          return withLock(async () => {
            while (true) {
              metrics.transactionAttempts += 1
              const snapshot = cloneState(state)
              try {
                return await callback()
              } catch (error) {
                state.conversation = snapshot.conversation
                state.job = snapshot.job
                if (error?.transient === true && metrics.transactionAttempts < 2) continue
                throw error
              }
            }
          })
        },
        async endSession() { metrics.endedSessions += 1 },
      }
    },
    async incrementConversationFenceIfAi(input) {
      if (input.businessId.toString() !== state.conversation.businessId.toString() ||
        input.conversationId.toString() !== state.conversation.id.toString() ||
        state.conversation.responseMode !== 'ai') return null
      state.conversation.aiControlVersion += 1
      await pauseAfterFence?.()
      return state.conversation.aiControlVersion
    },
    async saveJobIfCurrent(input) {
      if (shouldFailJobWrite) {
        shouldFailJobWrite = false
        const error = new Error('simulated transient write conflict')
        error.transient = true
        throw error
      }
      if (input.businessId.toString() !== state.job.businessId.toString() ||
        input.conversationId.toString() !== state.job.conversationId.toString() ||
        input.jobId.toString() !== state.job.id.toString() ||
        state.job.status !== 'processing' ||
        state.job.attemptCount !== input.attemptCount ||
        state.job.leaseExpiresAt <= input.now) return false
      state.job.status = 'draft_ready'
      state.job.generatedDraft = input.draft
      state.job.draftControlVersion = input.draftControlVersion
      state.job.leaseExpiresAt = null
      metrics.draftWrites += 1
      return true
    },
    async takeOverConversation(input) {
      return withLock(async () => {
        if (input.businessId.toString() !== state.conversation.businessId.toString() ||
          input.conversationId.toString() !== state.conversation.id.toString()) return { kind: 'not_found' }
        if (state.conversation.responseMode !== 'ai') return { kind: 'already_human' }
        state.conversation.responseMode = 'human'
        state.conversation.aiControlVersion += 1
        metrics.takeoverWrites += 1
        return { kind: 'taken_over' }
      })
    },
    now: () => now,
  }

  return {
    transitions: createAiReplyDraftTransitions(operations),
    state,
    metrics,
    withLock,
  }
}

function draftInput(overrides = {}) {
  return {
    businessId,
    conversationId,
    jobId,
    attemptCount: 2,
    draft: 'Suggested reply',
    ...overrides,
  }
}

test('draft transaction commits first and takeover afterward preserves the owner-review draft', async () => {
  const { transitions, state, metrics } = makeTransitionHarness()

  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'saved' })
  assert.deepEqual(await transitions.takeOverConversation({ businessId, conversationId }), { kind: 'taken_over' })
  assert.equal(state.conversation.responseMode, 'human')
  assert.equal(state.conversation.aiControlVersion, 2)
  assert.equal(state.job.status, 'draft_ready')
  assert.equal(state.job.generatedDraft, 'Suggested reply')
  assert.equal(metrics.draftWrites, 1)
  assert.equal(metrics.takeoverWrites, 1)
})

test('takeover commits first and prevents draft persistence', async () => {
  const { transitions, state, metrics } = makeTransitionHarness()
  assert.deepEqual(await transitions.takeOverConversation({ businessId, conversationId }), { kind: 'taken_over' })

  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'mode_changed' })
  assert.equal(state.conversation.responseMode, 'human')
  assert.equal(state.job.status, 'processing')
  assert.equal(state.job.generatedDraft, undefined)
  assert.equal(metrics.draftWrites, 0)
})

test('concurrent draft and takeover serialize on the same conversation fence', async () => {
  let announceFence
  let releaseFence
  const fenceReached = new Promise((resolve) => { announceFence = resolve })
  const holdFence = new Promise((resolve) => { releaseFence = resolve })
  const { transitions, state, metrics } = makeTransitionHarness({
    async pauseAfterFence() { announceFence(); await holdFence },
  })

  const draftCommit = transitions.saveDraft(draftInput())
  await fenceReached
  const takeover = transitions.takeOverConversation({ businessId, conversationId })
  releaseFence()

  assert.deepEqual(await draftCommit, { kind: 'saved' })
  assert.deepEqual(await takeover, { kind: 'taken_over' })
  assert.equal(state.job.status, 'draft_ready')
  assert.equal(state.conversation.responseMode, 'human')
  assert.equal(state.conversation.aiControlVersion, 2)
  assert.equal(metrics.transactionAttempts, 1)
})

test('transient transaction write conflict retries the callback without duplicating external work', async () => {
  const { transitions, state, metrics } = makeTransitionHarness({ failJobWriteOnce: true })

  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'saved' })
  assert.equal(metrics.transactionAttempts, 2)
  assert.equal(metrics.endedSessions, 1)
  assert.equal(metrics.draftWrites, 1)
  assert.equal(state.conversation.aiControlVersion, 1)
  assert.equal(state.job.generatedDraft, 'Suggested reply')
})

test('stale attempt cannot persist a draft and rolls back the conversation fence write', async () => {
  const { transitions, state, metrics } = makeTransitionHarness()

  assert.deepEqual(await transitions.saveDraft(draftInput({ attemptCount: 1 })), { kind: 'stale' })
  assert.equal(state.conversation.aiControlVersion, 0)
  assert.equal(state.job.status, 'processing')
  assert.equal(state.job.generatedDraft, undefined)
  assert.equal(metrics.draftWrites, 0)
})

test('expired lease cannot persist a draft and rolls back the conversation fence write', async () => {
  const { transitions, state } = makeTransitionHarness()
  state.job.leaseExpiresAt = new Date(now.getTime() - 1)

  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'stale' })
  assert.equal(state.conversation.aiControlVersion, 0)
  assert.equal(state.job.generatedDraft, undefined)
})

test('another business cannot take over or fence this conversation', async () => {
  const { transitions, state, metrics } = makeTransitionHarness()

  assert.deepEqual(await transitions.takeOverConversation({ businessId: otherBusinessId, conversationId }), { kind: 'not_found' })
  assert.deepEqual(await transitions.saveDraft(draftInput({ businessId: otherBusinessId })), { kind: 'mode_changed' })
  assert.equal(state.conversation.responseMode, 'ai')
  assert.equal(state.conversation.aiControlVersion, 0)
  assert.equal(state.job.status, 'processing')
  assert.equal(metrics.takeoverWrites, 0)
})

test('a second takeover after draft completion leaves the completed draft intact', async () => {
  const { transitions, state } = makeTransitionHarness()
  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'saved' })

  assert.deepEqual(await transitions.takeOverConversation({ businessId, conversationId }), { kind: 'taken_over' })
  assert.deepEqual(await transitions.saveDraft(draftInput()), { kind: 'mode_changed' })
  assert.equal(state.job.status, 'draft_ready')
  assert.equal(state.job.generatedDraft, 'Suggested reply')
})

test('production transaction adapter passes the same Mongo session and full ownership fences to both writes', async () => {
  const originalStartSession = mongoose.startSession
  const originalConversationUpdate = Conversation.findOneAndUpdate
  const originalJobUpdate = AiReplyJob.findOneAndUpdate
  const calls = { conversation: undefined, job: undefined, ended: false }
  const session = {
    async withTransaction(callback) { return callback() },
    async endSession() { calls.ended = true },
  }
  const query = (value) => ({
    select() { return this },
    lean() { return this },
    async exec() { return value },
  })

  try {
    mongoose.startSession = async () => session
    Conversation.findOneAndUpdate = (...args) => { calls.conversation = args; return query({ _id: conversationId, aiControlVersion: 1 }) }
    AiReplyJob.findOneAndUpdate = (...args) => { calls.job = args; return query({ _id: jobId }) }

    assert.deepEqual(
      await saveAiReplyDraft(businessId, conversationId, jobId, 2, 'Suggested reply'),
      { kind: 'saved' },
    )
    assert.equal(calls.conversation[0].businessId, businessId)
    assert.equal(calls.conversation[0]._id, conversationId)
    assert.deepEqual(calls.conversation[0].responseMode, { $in: ['ai', 'ai_draft'] })
    assert.deepEqual(calls.conversation[1], { $inc: { aiControlVersion: 1 } })
    assert.deepEqual(calls.conversation[0].responseMode, { $in: ['ai', 'ai_draft'] })
    assert.ok(Array.isArray(calls.conversation[0].$or))
    assert.equal(calls.conversation[2].session, session)
    assert.equal(calls.job[0].businessId, businessId)
    assert.equal(calls.job[0].conversationId, conversationId)
    assert.equal(calls.job[0]._id, jobId)
    assert.equal(calls.job[0].attemptCount, 2)
    assert.equal(calls.job[0].leaseExpiresAt.$gt instanceof Date, true)
    assert.ok(Math.abs(calls.job[0].leaseExpiresAt.$gt.getTime() - Date.now()) < 5_000)
    assert.equal(calls.job[0].status, 'processing')
    assert.equal(calls.job[1].$set.draftControlVersion, 1)
    assert.equal(calls.job[2].session, session)
    assert.equal(calls.ended, true)

    Conversation.findOneAndUpdate = (...args) => { calls.conversation = args; return query({ _id: conversationId }) }
    assert.deepEqual(await takeOverConversation(businessId, conversationId), { kind: 'taken_over' })
    assert.equal(calls.conversation[0].businessId, businessId)
    assert.equal(calls.conversation[0]._id, conversationId)
    assert.deepEqual(calls.conversation[0].responseMode, { $in: ['ai', 'ai_draft', 'ai_automatic'] })
    assert.deepEqual(calls.conversation[1], {
      $set: { responseMode: 'human' },
      $inc: { aiControlVersion: 1 },
    })
  } finally {
    mongoose.startSession = originalStartSession
    Conversation.findOneAndUpdate = originalConversationUpdate
    AiReplyJob.findOneAndUpdate = originalJobUpdate
  }
})
