import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose, { Types } from 'mongoose'
import { Business } from '../dist/models/business.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Customer } from '../dist/models/customer.model.js'
import { Message } from '../dist/models/message.model.js'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { subscribeToAiDraftWorkerWake } from '../dist/services/ai-draft-worker-wake.js'
import { ingestWhatsAppPayload } from '../dist/services/whatsapp-ingestion.service.js'

const businessId = new Types.ObjectId()
const customerId = new Types.ObjectId()
const conversationId = new Types.ObjectId()
const phoneNumberId = '123456789012345'

function makeQuery(resolveValue) {
  return {
    select() { return this },
    limit() { return this },
    sort() { return this },
    session() { return this },
    lean() { return this },
    async exec() { return resolveValue() },
    then(resolve, reject) { return Promise.resolve(resolveValue()).then(resolve, reject) },
  }
}

function payload(providerMessageId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: phoneNumberId },
          contacts: [{ wa_id: '919876543210', profile: { name: 'Customer' } }],
          messages: [{
            from: '919876543210',
            id: providerMessageId,
            timestamp: '1793613600',
            type: 'text',
            text: { body: 'Is this available?' },
          }],
        },
      }],
    }],
  }
}

async function withMongoModelMocks(run, options = {}) {
  const originals = {
    startSession: mongoose.startSession,
    businessFind: Business.find,
    businessFindOne: Business.findOne,
    businessFindOneAndUpdate: Business.findOneAndUpdate,
    customerFindOneAndUpdate: Customer.findOneAndUpdate,
    conversationFindOneAndUpdate: Conversation.findOneAndUpdate,
    conversationFindOne: Conversation.findOne,
    conversationUpdateOne: Conversation.updateOne,
    messageFindOne: Message.findOne,
    messageCreate: Message.create,
    aiReplyJobFindOne: AiReplyJob.findOne,
    aiReplyJobCreate: AiReplyJob.create,
  }
  const state = {
    conversation: null,
    customer: null,
    messages: [],
    jobs: [],
    sessionsEnded: 0,
    transactionCommitted: false,
    business: {
      _id: businessId,
      aiSettings: {
        automaticRepliesEnabled: options.businessAutomaticRepliesEnabled ?? false,
        automaticRepliesPolicyVersion: options.automaticRepliesPolicyVersion ?? 'test-policy',
        automaticRepliesControlVersion: 0,
      },
    },
  }

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      const snapshot = structuredClone(state)
      try {
        const result = await callback()
        state.transactionCommitted = true
        return result
      } catch (error) {
        state.conversation = snapshot.conversation
        state.customer = snapshot.customer
        state.messages = snapshot.messages
        state.jobs = snapshot.jobs
        state.transactionCommitted = snapshot.transactionCommitted
        state.business = snapshot.business
        throw error
      }
    },
    async endSession() { state.sessionsEnded += 1 },
  })
  Business.find = () => makeQuery(() => [{ _id: businessId }])
  Business.findOne = () => makeQuery(() => state.business)
  Business.findOneAndUpdate = (filter, update) => makeQuery(() => {
    if (filter._id?.toString() !== businessId.toString() ||
      filter['whatsapp.phoneNumberId'] !== phoneNumberId ||
      filter['aiSettings.automaticRepliesEnabled'] !== state.business.aiSettings.automaticRepliesEnabled ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(state.business.aiSettings.automaticRepliesPolicyVersion) ||
      state.business.aiSettings.automaticRepliesEnabled !== true) return null
    state.business.aiSettings.automaticRepliesControlVersion += update.$inc['aiSettings.automaticRepliesControlVersion']
    return state.business
  })
  Customer.findOneAndUpdate = () => makeQuery(() => {
    state.customer ??= { _id: customerId, businessId, phoneNumber: '919876543210' }
    return { ...state.customer }
  })
  Conversation.findOneAndUpdate = () => makeQuery(() => {
    state.conversation ??= {
      _id: conversationId,
      businessId,
      customerId,
      responseMode: 'ai',
      aiControlVersion: 0,
    }
    state.conversation.responseMode = options.responseMode ?? 'ai'
    if (state.conversation.aiControlVersion === undefined) state.conversation.aiControlVersion = 0
    return { ...state.conversation }
  })
  Conversation.findOne = (filter) => makeQuery(() => {
    if (!state.conversation || filter._id.toString() !== state.conversation._id.toString() ||
      filter.businessId.toString() !== businessId.toString() ||
      (filter.responseMode && (
        typeof filter.responseMode === 'object'
          ? !filter.responseMode.$in?.includes(state.conversation.responseMode)
          : filter.responseMode !== state.conversation.responseMode
      ))) return null
    return { ...state.conversation }
  })
  Conversation.updateOne = (filter, update) => makeQuery(() => {
    if (!state.conversation || filter._id.toString() !== state.conversation._id.toString() ||
      filter.businessId.toString() !== businessId.toString()) return { matchedCount: 0 }
    if (update.$inc) {
      for (const [key, value] of Object.entries(update.$inc)) {
        state.conversation[key] = (state.conversation[key] ?? 0) + value
      }
    }
    if (update.$set) Object.assign(state.conversation, update.$set)
    return { matchedCount: 1 }
  })
  Message.findOne = (filter) => makeQuery(() => {
    const found = state.messages.find((message) =>
      message.businessId.toString() === filter.businessId.toString() &&
      (filter.providerMessageId === undefined || message.providerMessageId === filter.providerMessageId) &&
      (filter._id === undefined || message._id.toString() === filter._id.toString()) &&
      (filter.conversationId === undefined || message.conversationId.toString() === filter.conversationId.toString()) &&
      (filter.direction === undefined || message.direction === filter.direction))
    return found ? { _id: found._id } : null
  })
  Message.create = async (documents) => {
    const [document] = documents
    const message = {
      ...document,
      _id: new Types.ObjectId(),
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
      updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    }
    state.messages.push(message)
    return [message]
  }
  AiReplyJob.findOne = (filter) => makeQuery(() => state.jobs.find((job) =>
    job.businessId.toString() === filter.businessId.toString() &&
    job.inboundMessageId.toString() === filter.inboundMessageId.toString()) ?? null)
  AiReplyJob.create = async (documents) => {
    if (options.jobInsertFails) throw new Error('simulated job insert failure')
    const [document] = documents
    const job = { ...document, _id: new Types.ObjectId(), status: document.status ?? 'queued' }
    state.jobs.push(job)
    return [job]
  }

  try { await run(state) } finally {
    mongoose.startSession = originals.startSession
    Business.find = originals.businessFind
    Business.findOne = originals.businessFindOne
    Business.findOneAndUpdate = originals.businessFindOneAndUpdate
    Customer.findOneAndUpdate = originals.customerFindOneAndUpdate
    Conversation.findOneAndUpdate = originals.conversationFindOneAndUpdate
    Conversation.findOne = originals.conversationFindOne
    Conversation.updateOne = originals.conversationUpdateOne
    Message.findOne = originals.messageFindOne
    Message.create = originals.messageCreate
    AiReplyJob.findOne = originals.aiReplyJobFindOne
    AiReplyJob.create = originals.aiReplyJobCreate
  }
}

test('new inbound message increments the conversation fence in its persistence transaction', async () => {
  await withMongoModelMocks(async (state) => {
    const result = await ingestWhatsAppPayload(payload('wamid.first'))
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(state.messages.length, 1)
    assert.equal(state.conversation.aiControlVersion, 1)
    assert.equal(state.conversation.lastMessagePreview, 'Is this available?')
    assert.equal(state.sessionsEnded, 1)
  })
})

test('duplicate inbound provider delivery does not create another message or increment the fence', async () => {
  await withMongoModelMocks(async (state) => {
    assert.deepEqual(await ingestWhatsAppPayload(payload('wamid.duplicate')), {
      kind: 'accepted', inserted: 1, duplicates: 0,
    })
    const versionAfterInsert = state.conversation.aiControlVersion

    assert.deepEqual(await ingestWhatsAppPayload(payload('wamid.duplicate')), {
      kind: 'accepted', inserted: 0, duplicates: 1,
    })
    assert.equal(state.messages.length, 1)
    assert.equal(state.conversation.aiControlVersion, versionAfterInsert)
    assert.equal(state.conversation.aiControlVersion, 1)
  })
})

test('AI mode plus enabled worker creates one queued job inside inbound persistence', async () => {
  await withMongoModelMocks(async (state) => {
    const result = await ingestWhatsAppPayload(payload('wamid.ai-enabled'), undefined, {
      aiDraftWorkerEnabled: true,
      aiAutomaticSendEnabled: true,
    })
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].status, 'queued')
    assert.equal(state.jobs[0].businessId.toString(), businessId.toString())
    assert.equal(state.jobs[0].conversationId.toString(), conversationId.toString())
    assert.equal(state.jobs[0].inboundMessageId.toString(), state.messages[0]._id.toString())
    assert.equal(state.conversation.aiControlVersion, 1)
  }, { businessAutomaticRepliesEnabled: true })
})

test('ai_draft mode uses the existing draft enqueue path and never creates an automatic workflow', async () => {
  await withMongoModelMocks(async (state) => {
    const result = await ingestWhatsAppPayload(payload('wamid.ai-draft-mode'), undefined, {
      aiDraftWorkerEnabled: true,
      aiAutomaticSendEnabled: true,
    })
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].status, 'queued')
    assert.equal(state.jobs[0].workflow, undefined)
    assert.equal(state.conversation.responseMode, 'ai_draft')
  }, { responseMode: 'ai_draft', businessAutomaticRepliesEnabled: true })
})

test('ai_automatic with the global gate disabled persists inbound without enqueueing', async () => {
  await withMongoModelMocks(async (state) => {
    const result = await ingestWhatsAppPayload(payload('wamid.ai-automatic-foundation'), undefined, {
      aiDraftWorkerEnabled: true,
      aiAutomaticSendEnabled: false,
    })
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 0)
  }, { responseMode: 'ai_automatic' })
})

test('eligible ai_automatic message creates one atomic automatic workflow job', async () => {
  await withMongoModelMocks(async (state) => {
    await ingestWhatsAppPayload(payload('wamid.ai-automatic-eligible'), undefined, {
      aiDraftWorkerEnabled: false,
      aiAutomaticSendEnabled: true,
    })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].workflow, 'ai_automatic')
    assert.equal(state.jobs[0].status, 'queued')
    assert.equal(state.jobs[0].automaticPolicyVersion, 'test-policy')
    assert.equal(state.jobs[0].workflowControlVersion, 1)
    assert.equal(state.jobs[0].automaticSafetyDecision, undefined)
    assert.equal(state.conversation.aiControlVersion, 1)
  }, { responseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true })
})

test('ai_automatic with business opt-in disabled does not enqueue', async () => {
  await withMongoModelMocks(async (state) => {
    await ingestWhatsAppPayload(payload('wamid.ai-automatic-optout'), undefined, {
      aiAutomaticSendEnabled: true,
    })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.conversation.aiControlVersion, 1)
  }, { responseMode: 'ai_automatic', businessAutomaticRepliesEnabled: false })
})

test('duplicate automatic webhook delivery creates one message, one job and one fence increment', async () => {
  await withMongoModelMocks(async (state) => {
    const options = { aiAutomaticSendEnabled: true }
    await ingestWhatsAppPayload(payload('wamid.ai-automatic-duplicate'), undefined, options)
    await ingestWhatsAppPayload(payload('wamid.ai-automatic-duplicate'), undefined, options)
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].workflow, 'ai_automatic')
    assert.equal(state.conversation.aiControlVersion, 1)
    assert.equal(state.business.aiSettings.automaticRepliesControlVersion, 1)
  }, { responseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true })
})

test('eligible job wake is emitted only after its inbound transaction commits', async () => {
  let wakeCount = 0
  let transactionWasCommittedAtWake = false
  const unsubscribe = subscribeToAiDraftWorkerWake(() => {
    wakeCount += 1
    transactionWasCommittedAtWake = stateUnderTest.transactionCommitted
  })
  let stateUnderTest

  try {
    await withMongoModelMocks(async (state) => {
      stateUnderTest = state
      await ingestWhatsAppPayload(payload('wamid.wake-after-commit'), undefined, {
        aiDraftWorkerEnabled: true,
      })
      assert.equal(state.jobs.length, 1)
    })
  } finally {
    unsubscribe()
  }

  assert.equal(wakeCount, 1)
  assert.equal(transactionWasCommittedAtWake, true)
})

test('Human mode with worker enabled persists the inbound message without a job', async () => {
  await withMongoModelMocks(async (state) => {
    await ingestWhatsAppPayload(payload('wamid.human-mode'), undefined, {
      aiDraftWorkerEnabled: true,
    })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.conversation.aiControlVersion, 1)
  }, { responseMode: 'human' })
})

test('AI mode with worker disabled persists the inbound message without a job', async () => {
  await withMongoModelMocks(async (state) => {
    await ingestWhatsAppPayload(payload('wamid.worker-disabled'), undefined, {
      aiDraftWorkerEnabled: false,
    })
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.conversation.aiControlVersion, 1)
  })
})

test('duplicate webhook delivery in AI mode creates exactly one message and one job', async () => {
  await withMongoModelMocks(async (state) => {
    const options = { aiDraftWorkerEnabled: true }
    await ingestWhatsAppPayload(payload('wamid.ai-duplicate'), undefined, options)
    await ingestWhatsAppPayload(payload('wamid.ai-duplicate'), undefined, options)
    assert.equal(state.messages.length, 1)
    assert.equal(state.jobs.length, 1)
    assert.equal(state.conversation.aiControlVersion, 1)
  })
})

test('job insertion failure rolls back customer, conversation, message and fence', async () => {
  let wakeCount = 0
  const unsubscribe = subscribeToAiDraftWorkerWake(() => { wakeCount += 1 })
  try {
  await withMongoModelMocks(async (state) => {
    await assert.rejects(
      ingestWhatsAppPayload(payload('wamid.job-failure'), undefined, { aiDraftWorkerEnabled: true }),
    )
    assert.equal(state.customer, null)
    assert.equal(state.conversation, null)
    assert.equal(state.messages.length, 0)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.sessionsEnded, 1)
  }, { jobInsertFails: true })
  } finally {
    unsubscribe()
  }
  assert.equal(wakeCount, 0)
})

test('automatic job insertion failure rolls back inbound message, both fences, and transaction-created customer/conversation', async () => {
  await withMongoModelMocks(async (state) => {
    await assert.rejects(ingestWhatsAppPayload(
      payload('wamid.auto-job-failure'),
      undefined,
      { aiAutomaticSendEnabled: true },
    ))
    assert.equal(state.customer, null)
    assert.equal(state.conversation, null)
    assert.equal(state.messages.length, 0)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.business.aiSettings.automaticRepliesControlVersion, 0)
    assert.equal(state.sessionsEnded, 1)
  }, { responseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true, jobInsertFails: true })
})

test('unsupported media events do not create inbound messages or AI jobs', async () => {
  await withMongoModelMocks(async (state) => {
    const unsupported = payload('wamid.media')
    const incoming = unsupported.entry[0].changes[0].value.messages[0]
    incoming.type = 'image'
    incoming.image = { id: 'media-id' }
    delete incoming.text

    assert.deepEqual(await ingestWhatsAppPayload(unsupported, undefined, { aiDraftWorkerEnabled: true }), {
      kind: 'ignored',
    })
    assert.equal(state.messages.length, 0)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.sessionsEnded, 0)
  })
})
