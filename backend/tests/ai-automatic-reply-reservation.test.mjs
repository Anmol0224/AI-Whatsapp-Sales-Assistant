import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose, { Types } from 'mongoose'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Business } from '../dist/models/business.model.js'
import { CatalogItem } from '../dist/models/catalog-item.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Customer } from '../dist/models/customer.model.js'
import { Faq } from '../dist/models/faq.model.js'
import { Message } from '../dist/models/message.model.js'
import { completeAiReplySend, reserveAiAutomaticReplyForSending } from '../dist/services/ai-reply-job.repository.js'

function query(result, session, checks) {
  return {
    select() { return this },
    sort() { return this },
    limit() { return this },
    lean() { return this },
    session(value) { assert.equal(value, session); checks.sessionQueries += 1; return this },
    async exec() { assert.equal(checks.transactionOpen, true); return result },
    then(resolve, reject) { assert.equal(checks.transactionOpen, true); return Promise.resolve(result).then(resolve, reject) },
  }
}

test('automatic reservation revalidates all evidence in one transaction and writes the business, conversation and job fences', async () => {
  const businessId = new Types.ObjectId()
  const customerId = new Types.ObjectId()
  const conversationId = new Types.ObjectId()
  const inboundMessageId = new Types.ObjectId()
  const jobId = new Types.ObjectId()
  const faqId = new Types.ObjectId()
  const policyVersion = 'policy-test-v3'
  const answer = 'Returns are accepted within 14 days.'
  const checks = { transactionOpen: false, sessionQueries: 0, businessFence: null, conversationFence: null, jobFence: null }
  const session = {
    id: 'session',
    async withTransaction(callback) {
      checks.transactionOpen = true
      try { return await callback() } finally { checks.transactionOpen = false }
    },
    async endSession() {},
  }
  const job = {
    _id: jobId, businessId, conversationId, inboundMessageId, workflow: 'ai_automatic', status: 'automatic_ready',
    automaticReplyTextSnapshot: answer, automaticSafetyDecision: 'eligible', automaticPolicyVersion: policyVersion,
    workflowControlVersion: 7,
  }
  const originals = {
    startSession: mongoose.startSession,
    aiFindOne: AiReplyJob.findOne,
    aiUpdateOne: AiReplyJob.updateOne,
    businessFindOne: Business.findOne,
    businessFindOneAndUpdate: Business.findOneAndUpdate,
    conversationFindOne: Conversation.findOne,
    conversationFindOneAndUpdate: Conversation.findOneAndUpdate,
    messageFindOne: Message.findOne,
    messageExists: Message.exists,
    faqFind: Faq.find,
    catalogFind: CatalogItem.find,
    customerFindOne: Customer.findOne,
  }

  try {
    mongoose.startSession = async () => session
    AiReplyJob.findOne = (filter) => {
      assert.equal(filter._id.toString(), jobId.toString())
      assert.equal(filter.businessId.toString(), businessId.toString())
      return query(job, session, checks)
    }
    AiReplyJob.updateOne = (filter, update, options) => {
      assert.equal(checks.transactionOpen, true)
      assert.equal(options.session, session)
      checks.jobFence = { filter, update }
      return query({ matchedCount: 1 }, session, checks)
    }
    Business.findOne = (filter) => {
      assert.equal(filter._id.toString(), businessId.toString())
      return query({
        aiSettings: { automaticRepliesEnabled: true, automaticRepliesPolicyVersion: policyVersion },
      }, session, checks)
    }
    Business.findOneAndUpdate = (filter, update, options) => {
      assert.equal(filter._id.toString(), businessId.toString())
      assert.equal(filter['aiSettings.automaticRepliesEnabled'], true)
      assert.equal(filter['aiSettings.automaticRepliesPolicyVersion'], policyVersion)
      assert.equal(options.session, session)
      checks.businessFence = { filter, update }
      return query({ whatsapp: { phoneNumberId: '1234567890', connectionStatus: 'configured_not_verified' } }, session, checks)
    }
    Conversation.findOne = (filter) => {
      assert.equal(filter._id.toString(), conversationId.toString())
      return query({ _id: conversationId, businessId, responseMode: 'ai_automatic', aiControlVersion: 7 }, session, checks)
    }
    Conversation.findOneAndUpdate = (filter, update, options) => {
      assert.equal(filter._id.toString(), conversationId.toString())
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.responseMode, 'ai_automatic')
      assert.equal(filter.aiControlVersion, 7)
      assert.equal(options.session, session)
      checks.conversationFence = { filter, update }
      return query({ customerId }, session, checks)
    }
    Message.findOne = (filter) => {
      if (filter._id) {
        assert.equal(filter._id.toString(), inboundMessageId.toString())
        assert.equal(filter.businessId.toString(), businessId.toString())
        assert.equal(filter.conversationId.toString(), conversationId.toString())
        return query({
          _id: inboundMessageId, businessId, conversationId, direction: 'inbound', messageType: 'text',
          text: 'What is your return policy?',
        }, session, checks)
      }
      assert.equal(filter.businessId.toString(), businessId.toString())
      return query({ _id: inboundMessageId }, session, checks)
    }
    Message.exists = (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.aiReplyJobId.toString(), jobId.toString())
      return query(null, session, checks)
    }
    Faq.find = (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.isActive, true)
      return query([{
        _id: faqId, businessId, question: 'What is your return policy?', answer, isActive: true,
      }], session, checks)
    }
    CatalogItem.find = (filter) => {
      assert.equal(filter.businessId.toString(), businessId.toString())
      return query([], session, checks)
    }
    Customer.findOne = (filter) => {
      assert.equal(filter._id.toString(), customerId.toString())
      assert.equal(filter.businessId.toString(), businessId.toString())
      return query({ phoneNumber: '919876543210' }, session, checks)
    }

    const disabled = await reserveAiAutomaticReplyForSending({
      businessId, jobId, isAutomaticSendEnabled: () => false,
    })
    assert.equal(disabled.kind, 'safety_rejected')
    assert.equal(disabled.validation.reasonCode, 'automatic_replies_disabled')
    assert.equal(checks.businessFence, null)
    assert.equal(checks.conversationFence, null)

    const result = await reserveAiAutomaticReplyForSending({
      businessId, jobId, isAutomaticSendEnabled: () => true,
    })
    assert.equal(result.kind, 'reserved')
    assert.equal(result.automaticReplyText, answer)
    assert.equal(result.recipientPhoneNumber, '919876543210')
    assert.ok(checks.sessionQueries >= 8)
    assert.deepEqual(checks.businessFence.update, { $inc: { 'aiSettings.automaticRepliesControlVersion': 1 } })
    assert.equal(checks.conversationFence.update.$set.activeAiSendJobId.toString(), jobId.toString())
    assert.equal(checks.jobFence.update.$set.status, 'sending')
    assert.equal(checks.jobFence.update.$set.sendProvenance, 'automatic_policy')
    assert.equal(checks.jobFence.update.$set.approvedText, undefined)
  } finally {
    mongoose.startSession = originals.startSession
    AiReplyJob.findOne = originals.aiFindOne
    AiReplyJob.updateOne = originals.aiUpdateOne
    Business.findOne = originals.businessFindOne
    Business.findOneAndUpdate = originals.businessFindOneAndUpdate
    Conversation.findOne = originals.conversationFindOne
    Conversation.findOneAndUpdate = originals.conversationFindOneAndUpdate
    Message.findOne = originals.messageFindOne
    Message.exists = originals.messageExists
    Faq.find = originals.faqFind
    CatalogItem.find = originals.catalogFind
    Customer.findOne = originals.customerFindOne
  }
})

test('automatic send completion persists only the reserved snapshot in one transaction', async () => {
  const businessId = new Types.ObjectId()
  const jobId = new Types.ObjectId()
  const conversationId = new Types.ObjectId()
  const customerId = new Types.ObjectId()
  const attemptId = '123e4567-e89b-42d3-a456-426614174001'
  const reservedText = 'The listed price for Blue Widget is ₹450.50.'
  const session = {
    async withTransaction(callback) { return callback() },
    async endSession() {},
  }
  const writes = { message: null, conversation: null, job: null }
  const originals = {
    startSession: mongoose.startSession,
    jobFindOne: AiReplyJob.findOne,
    conversationFindOne: Conversation.findOne,
    messageCreate: Message.create,
    conversationUpdate: Conversation.updateOne,
    jobUpdate: AiReplyJob.updateOne,
  }
  const queryResult = (value) => ({
    select() { return this },
    session(input) { assert.equal(input, session); return this },
    lean() { return this },
    async exec() { return value },
  })
  try {
    mongoose.startSession = async () => session
    AiReplyJob.findOne = (filter) => {
      assert.equal(filter._id.toString(), jobId.toString())
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.status, 'sending')
      assert.equal(filter.sendAttemptId, attemptId)
      return queryResult({
        conversationId,
        workflow: 'ai_automatic',
        approvedText: 'must never be sent',
        automaticReplyTextSnapshot: reservedText,
        automaticSafetyDecision: 'eligible',
        sendProvenance: 'automatic_policy',
      })
    }
    Conversation.findOne = (filter) => {
      assert.equal(filter._id.toString(), conversationId.toString())
      assert.equal(filter.businessId.toString(), businessId.toString())
      assert.equal(filter.activeAiSendJobId.toString(), jobId.toString())
      return queryResult({ customerId })
    }
    Message.create = async (documents, options) => {
      assert.equal(options.session, session)
      writes.message = documents[0]
      return [{ ...documents[0], _id: new Types.ObjectId(), createdAt: new Date() }]
    }
    Conversation.updateOne = (filter, update, options) => {
      assert.equal(options.session, session)
      assert.equal(filter._id.toString(), conversationId.toString())
      writes.conversation = { filter, update }
      return queryResult({ matchedCount: 1 })
    }
    AiReplyJob.updateOne = (filter, update, options) => {
      assert.equal(options.session, session)
      assert.equal(filter._id.toString(), jobId.toString())
      writes.job = { filter, update }
      return queryResult({ matchedCount: 1 })
    }

    const result = await completeAiReplySend({
      businessId, jobId, sendAttemptId: attemptId, providerMessageId: 'wamid.auto-unit-test',
    })
    assert.equal(result.kind, 'sent')
    assert.equal(writes.message.text, reservedText)
    assert.equal(writes.message.direction, 'outbound')
    assert.equal(writes.message.aiReplyJobId.toString(), jobId.toString())
    assert.equal(writes.conversation.update.$set.lastMessagePreview, reservedText)
    assert.equal(writes.job.update.$set.status, 'sent')
  } finally {
    mongoose.startSession = originals.startSession
    AiReplyJob.findOne = originals.jobFindOne
    Conversation.findOne = originals.conversationFindOne
    Message.create = originals.messageCreate
    Conversation.updateOne = originals.conversationUpdate
    AiReplyJob.updateOne = originals.jobUpdate
  }
})
