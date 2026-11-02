import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose, { Types } from 'mongoose'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Message } from '../dist/models/message.model.js'
import {
  approveAiReplyDraft,
  completeAiReplySend,
  recoverExpiredAiReplySendReservations,
  rejectAiReplyDraft,
  recordAiReplySendOutcome,
  reserveAiReplyDraftForSending,
  setConversationResponseMode,
  takeOverConversation,
} from '../dist/services/ai-reply-job.repository.js'

const businessId = new Types.ObjectId()
const otherBusinessId = new Types.ObjectId()
const userId = new Types.ObjectId()
const jobId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const customerId = new Types.ObjectId()
const inboundMessageId = new Types.ObjectId()
const now = new Date('2026-11-01T12:00:00.000Z')

function matches(document, filter) {
  if (!document) return false
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!expected.some((condition) => matches(document, condition))) return false
    } else if (key === '$and') {
      if (!expected.every((condition) => matches(document, condition))) return false
    } else if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId) && !(expected instanceof Date)) {
      if ('$exists' in expected) {
        if ((document[key] !== undefined) !== expected.$exists) return false
      } else if ('$lte' in expected) {
        if (!(document[key] instanceof Date) || document[key] > expected.$lte) return false
      } else if ('$gt' in expected) {
        if (!(document[key] instanceof Date) || document[key] <= expected.$gt) return false
      } else if (document[key]?.toString() !== expected.toString()) return false
    } else if (document[key]?.toString() !== expected?.toString()) return false
  }
  return true
}

function makeQuery(resolveValue) {
  return {
    select() { return this },
    session() { return this },
    lean() { return this },
    sort() { return this },
    limit() { return this },
    async exec() { return resolveValue() },
    then(resolve, reject) { return Promise.resolve(resolveValue()).then(resolve, reject) },
  }
}

async function withRepositoryMocks(run, overrides = {}) {
  const originals = {
    startSession: mongoose.startSession,
    jobFindOne: AiReplyJob.findOne,
    jobFindOneAndUpdate: AiReplyJob.findOneAndUpdate,
    jobUpdateOne: AiReplyJob.updateOne,
    jobExists: AiReplyJob.exists,
    jobFind: AiReplyJob.find,
    conversationFindOne: Conversation.findOne,
    conversationFindOneAndUpdate: Conversation.findOneAndUpdate,
    conversationUpdateOne: Conversation.updateOne,
    messageCreate: Message.create,
    messageFindOne: Message.findOne,
  }
  const state = {
    conversation: {
      _id: conversationId, businessId, customerId, responseMode: 'ai', aiControlVersion: 3,
    },
    job: {
      _id: jobId, businessId, conversationId, inboundMessageId, status: 'draft_ready',
      draftControlVersion: 3,
      generatedDraft: '  Hello there  ', approvedControlVersion: undefined,
    },
    latestInboundMessageId: inboundMessageId,
    messages: [],
  }

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      const snapshot = structuredClone(state)
      try { return await callback() } catch (error) {
        state.conversation = snapshot.conversation
        state.job = snapshot.job
        state.messages = snapshot.messages
        throw error
      }
    },
    async endSession() {},
  })
  AiReplyJob.findOne = (filter) => makeQuery(() => matches(state.job, filter) ? { ...state.job } : null)
  Conversation.findOne = (filter) => makeQuery(() => matches(state.conversation, filter) ? { ...state.conversation } : null)
  Conversation.findOneAndUpdate = (filter, update) => makeQuery(() => {
    if (!matches(state.conversation, filter)) return null
    if (update.$set) Object.assign(state.conversation, update.$set)
    if (update.$unset) for (const key of Object.keys(update.$unset)) delete state.conversation[key]
    if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) state.conversation[key] = (state.conversation[key] ?? 0) + value
    return { ...state.conversation }
  })
  AiReplyJob.updateOne = (filter, update) => makeQuery(() => {
    if (!matches(state.job, filter)) return { matchedCount: 0 }
    if (update.$set) Object.assign(state.job, update.$set)
    if (update.$unset) for (const key of Object.keys(update.$unset)) delete state.job[key]
    return { matchedCount: 1 }
  })
  AiReplyJob.exists = (filter) => makeQuery(() => matches(state.job, filter) ? { _id: jobId } : null)
  AiReplyJob.find = (filter) => makeQuery(() => matches(state.job, filter)
    ? [{ _id: jobId, businessId: state.job.businessId, conversationId: state.job.conversationId, sendAttemptId: state.job.sendAttemptId }]
    : [])
  Conversation.updateOne = (filter, update) => makeQuery(() => {
    if (!matches(state.conversation, filter)) return { matchedCount: 0 }
    if (update.$set) Object.assign(state.conversation, update.$set)
    if (update.$unset) for (const key of Object.keys(update.$unset)) delete state.conversation[key]
    if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) state.conversation[key] = (state.conversation[key] ?? 0) + value
    return { matchedCount: 1 }
  })
  Message.create = async (documents) => {
    const message = { ...documents[0], _id: new Types.ObjectId(), createdAt: now, updatedAt: now }
    state.messages.push(message)
    return [message]
  }
  Message.findOne = (filter) => makeQuery(() =>
    filter.businessId.toString() === state.job.businessId.toString() &&
    filter.conversationId.toString() === state.job.conversationId.toString() &&
    filter.direction === 'inbound'
      ? { _id: state.latestInboundMessageId }
      : null)

  try { await run(state) } finally {
    mongoose.startSession = originals.startSession
    AiReplyJob.findOne = originals.jobFindOne
    AiReplyJob.findOneAndUpdate = originals.jobFindOneAndUpdate
    AiReplyJob.updateOne = originals.jobUpdateOne
    AiReplyJob.exists = originals.jobExists
    AiReplyJob.find = originals.jobFind
    Conversation.findOne = originals.conversationFindOne
    Conversation.findOneAndUpdate = originals.conversationFindOneAndUpdate
    Conversation.updateOne = originals.conversationUpdateOne
    Message.create = originals.messageCreate
    Message.findOne = originals.messageFindOne
  }
}

test('approve unchanged and edited drafts once; terminal approval is rejected', async () => {
  await withRepositoryMocks(async (state) => {
    const unchanged = await approveAiReplyDraft({ businessId, userId, jobId, now })
    assert.deepEqual(unchanged, { kind: 'approved', approvedText: 'Hello there', approvedControlVersion: 4 })
    assert.equal(state.job.generatedDraft, '  Hello there  ')
    assert.equal(state.job.approvalEdited, false)
    assert.equal(state.job.approvedByUserId.toString(), userId.toString())
    assert.deepEqual(await approveAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'conflict' })
  })

  await withRepositoryMocks(async (state) => {
    const edited = await approveAiReplyDraft({ businessId, userId, jobId, approvedText: ' A tailored reply ', now })
    assert.equal(edited.kind, 'approved')
    assert.equal(state.job.approvedText, 'A tailored reply')
    assert.equal(state.job.approvalEdited, true)
  })
})

test('approval requires AI mode and business-scoped job ownership', async () => {
  await withRepositoryMocks(async (state) => {
    state.conversation.responseMode = 'human'
    assert.deepEqual(await approveAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'mode_changed' })
    assert.equal(state.job.status, 'draft_ready')
  })

  await withRepositoryMocks(async () => {
    assert.deepEqual(await approveAiReplyDraft({ businessId: otherBusinessId, userId, jobId, now }), { kind: 'not_found' })
  })
})

test('approval rejects a source inbound message that is no longer current', async () => {
  await withRepositoryMocks(async (state) => {
    state.latestInboundMessageId = new Types.ObjectId()
    assert.deepEqual(await approveAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'stale' })
    assert.equal(state.conversation.aiControlVersion, 3)
    assert.equal(state.job.status, 'draft_ready')
  })
})

test('reject is single-use and records bounded owner audit information', async () => {
  await withRepositoryMocks(async (state) => {
    assert.deepEqual(await rejectAiReplyDraft({ businessId, userId, jobId, reason: 'Not suitable', now }), { kind: 'rejected' })
    assert.equal(state.job.status, 'rejected')
    assert.equal(state.job.rejectionReason, 'Not suitable')
    assert.deepEqual(await rejectAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'conflict' })
  })
})

test('rejection cannot overwrite an approved draft', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'approved'
    assert.deepEqual(await rejectAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'conflict' })
    assert.equal(state.job.status, 'approved')
  })
})

test('send reservation is unique and prevents human takeover until resolved', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'approved'
    state.job.approvedText = 'Approved text'
    state.job.approvedControlVersion = 3
    const reserved = await reserveAiReplyDraftForSending({ businessId, jobId, now })
    assert.equal(reserved.kind, 'reserved')
    assert.equal(state.job.status, 'sending')
    assert.equal(state.conversation.activeAiSendJobId.toString(), jobId.toString())
    assert.deepEqual(await reserveAiReplyDraftForSending({ businessId, jobId, now }), { kind: 'conflict' })
    assert.deepEqual(await takeOverConversation(businessId, conversationId), { kind: 'send_in_progress' })
  })
})

test('human takeover before reservation prevents sending', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'approved'
    state.job.approvedText = 'Approved text'
    state.job.approvedControlVersion = 3
    assert.deepEqual(await takeOverConversation(businessId, conversationId), { kind: 'taken_over' })
    assert.deepEqual(await reserveAiReplyDraftForSending({ businessId, jobId, now }), { kind: 'mode_changed' })
    assert.equal(state.job.status, 'approved')
  })
})

test('new inbound fence after approval invalidates the approved reservation', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'approved'
    state.job.approvedText = 'Approved text'
    state.job.approvedControlVersion = 4
    state.conversation.aiControlVersion = 5
    assert.deepEqual(await reserveAiReplyDraftForSending({ businessId, jobId, now }), { kind: 'mode_changed' })
    assert.equal(state.job.status, 'approved')
    assert.equal(state.conversation.activeAiSendJobId, undefined)
  })
})

test('resuming AI mode increments the fence and leaves older drafts stale', async () => {
  await withRepositoryMocks(async (state) => {
    state.conversation.responseMode = 'human'
    state.conversation.aiControlVersion = 4
    assert.deepEqual(await setConversationResponseMode(businessId, conversationId, 'ai'), {
      kind: 'updated', responseMode: 'ai',
    })
    assert.equal(state.conversation.aiControlVersion, 5)
    assert.deepEqual(await approveAiReplyDraft({ businessId, userId, jobId, now }), { kind: 'stale' })
  })
})

test('legacy conversations without responseMode use Human as the default and can switch to AI', async () => {
  await withRepositoryMocks(async (state) => {
    delete state.conversation.responseMode
    state.conversation.aiControlVersion = 4

    assert.deepEqual(await takeOverConversation(businessId, conversationId), { kind: 'already_human' })
    assert.deepEqual(await setConversationResponseMode(businessId, conversationId, 'ai'), {
      kind: 'updated', responseMode: 'ai',
    })
    assert.equal(state.conversation.responseMode, 'ai')
    assert.equal(state.conversation.aiControlVersion, 5)
  })
})

test('confirmed send persists provenance and clears the active marker atomically', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'sending'
    state.job.sendAttemptId = 'attempt-1'
    state.job.approvedText = 'Approved outbound text'
    state.conversation.activeAiSendJobId = jobId
    const result = await completeAiReplySend({ businessId, jobId, sendAttemptId: 'attempt-1', providerMessageId: 'wamid.test', now })
    assert.equal(result.kind, 'sent')
    assert.equal(state.job.status, 'sent')
    assert.equal(state.job.providerMessageId, 'wamid.test')
    assert.equal(state.messages[0].aiReplyJobId.toString(), jobId.toString())
    assert.equal(state.messages[0].text, 'Approved outbound text')
    assert.equal(state.conversation.activeAiSendJobId, undefined)
    assert.equal(state.conversation.lastMessagePreview, 'Approved outbound text')
  })
})

test('definitive and ambiguous provider outcomes are terminal and clear the reservation', async () => {
  for (const outcome of ['rejected', 'uncertain']) {
    await withRepositoryMocks(async (state) => {
      state.job.status = 'sending'
      state.job.sendAttemptId = 'attempt-1'
      state.conversation.activeAiSendJobId = jobId
      const result = await recordAiReplySendOutcome({
        businessId, jobId, sendAttemptId: 'attempt-1', outcome,
        errorCode: outcome === 'rejected' ? 'provider_rejected' : 'provider_timeout',
        providerStatusCode: outcome === 'rejected' ? 400 : undefined,
        now,
      })
      assert.deepEqual(result, { kind: 'recorded' })
      assert.equal(state.job.status, outcome === 'rejected' ? 'send_failed' : 'send_uncertain')
      assert.equal(state.conversation.activeAiSendJobId, undefined)
    })
  }
})

test('expired send lease becomes uncertain and is not queued for another attempt', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'sending'
    state.job.sendAttemptId = 'attempt-expired'
    state.job.sendLeaseExpiresAt = new Date(now.getTime() - 1)
    state.conversation.activeAiSendJobId = jobId
    assert.equal(await recoverExpiredAiReplySendReservations(now), 1)
    assert.equal(state.job.status, 'send_uncertain')
    assert.equal(state.job.sendOutcome, 'uncertain')
    assert.equal(state.job.sendErrorCode, 'send_lease_expired')
    assert.equal(state.conversation.activeAiSendJobId, undefined)
    assert.deepEqual(await reserveAiReplyDraftForSending({ businessId, jobId, now }), { kind: 'conflict' })
  })
})

test('send recovery leaves a non-expired reservation and its marker unchanged', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'sending'
    state.job.sendAttemptId = 'attempt-live'
    state.job.sendLeaseExpiresAt = new Date(now.getTime() + 1)
    state.conversation.activeAiSendJobId = jobId

    assert.equal(await recoverExpiredAiReplySendReservations(now), 0)
    assert.equal(state.job.status, 'sending')
    assert.equal(state.conversation.activeAiSendJobId, jobId)
  })
})

test('send recovery cannot clear a conversation marker belonging to another business', async () => {
  await withRepositoryMocks(async (state) => {
    state.job.status = 'sending'
    state.job.businessId = otherBusinessId
    state.job.sendAttemptId = 'attempt-other-business'
    state.job.sendLeaseExpiresAt = new Date(now.getTime() - 1)
    state.conversation.activeAiSendJobId = jobId

    assert.equal(await recoverExpiredAiReplySendReservations(now), 0)
    assert.equal(state.job.status, 'sending')
    assert.ok(state.conversation.activeAiSendJobId)
  })
})

test('stale or terminal jobs cannot complete or be recovered', async () => {
  await withRepositoryMocks(async (state) => {
    assert.deepEqual(await completeAiReplySend({ businessId, jobId, sendAttemptId: 'stale', providerMessageId: 'wamid.test', now }), { kind: 'stale' })
    assert.equal(state.messages.length, 0)
    assert.equal(await recoverExpiredAiReplySendReservations(now), 0)
  })
})
