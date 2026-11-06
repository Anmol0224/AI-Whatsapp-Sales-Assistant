import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import mongoose, { Types } from 'mongoose'
import { AiReplyEscalation } from '../dist/models/ai-reply-escalation.model.js'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Business } from '../dist/models/business.model.js'
import { CatalogItem } from '../dist/models/catalog-item.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import { Customer } from '../dist/models/customer.model.js'
import { Faq } from '../dist/models/faq.model.js'
import { Message } from '../dist/models/message.model.js'
import { createAiDraftsRouter } from '../dist/routes/v1/ai-drafts.routes.js'
import { createAiEscalationsRouter } from '../dist/routes/v1/ai-escalations.routes.js'
import { createConversationsRouter } from '../dist/routes/v1/conversations.routes.js'
import { createAiAutomaticReplyProcessor } from '../dist/services/ai-automatic-reply-processor.service.js'
import { createAutomaticReplySendService } from '../dist/services/ai-automatic-reply-send.service.js'
import { createAiDraftProcessor } from '../dist/services/ai-draft-processor.service.js'
import { createAiReplySendService } from '../dist/services/ai-reply-send.service.js'
import {
  recoverExpiredAiReplyJobsForWorker,
  recoverExpiredAiReplySendReservations,
} from '../dist/services/ai-reply-job.repository.js'
import { createAutomaticReplySafetyService } from '../dist/services/automatic-reply-safety.service.js'
import { businessContextService } from '../dist/services/business-context.service.js'
import { buildBusinessReplyPrompt } from '../dist/services/business-prompt-builder.service.js'
import { GeminiServiceError } from '../dist/services/gemini.service.js'
import { WhatsAppCloudApiError } from '../dist/services/whatsapp-cloud-api.service.js'
import { ingestWhatsAppPayload } from '../dist/services/whatsapp-ingestion.service.js'

function matchesFilter(doc, filter = {}) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!expected.some((branch) => matchesFilter(doc, branch))) return false
      continue
    }
    if (key === '$and') {
      if (!expected.every((branch) => matchesFilter(doc, branch))) return false
      continue
    }
    const actual = key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), doc)
    if (expected instanceof Types.ObjectId) {
      if (!actual || actual.toString() !== expected.toString()) return false
      continue
    }
    if (typeof expected === 'object' && expected !== null && !(expected instanceof Date)) {
      if ('$exists' in expected) {
        const exists = actual !== undefined
        if (exists !== expected.$exists) return false
      }
      if ('$in' in expected) {
        const matched = expected.$in.some((item) =>
          item instanceof Types.ObjectId
            ? actual && actual.toString() === item.toString()
            : actual === item,
        )
        if (!matched) return false
      }
      if ('$ne' in expected) {
        const isEqual =
          expected.$ne instanceof Types.ObjectId
            ? actual && actual.toString() === expected.$ne.toString()
            : actual === expected.$ne
        if (isEqual) return false
      }
      if ('$eq' in expected) {
        const isEqual =
          expected.$eq instanceof Date
            ? actual instanceof Date && actual.getTime() === expected.$eq.getTime()
            : expected.$eq instanceof Types.ObjectId
              ? actual && actual.toString() === expected.$eq.toString()
              : actual === expected.$eq
        if (!isEqual) return false
      }
      if ('$lte' in expected) {
        if (actual === undefined || actual === null) return false
        const lhs = actual instanceof Date ? actual.getTime() : actual
        const rhs = expected.$lte instanceof Date ? expected.$lte.getTime() : expected.$lte
        if (!(lhs <= rhs)) return false
      }
      if ('$gt' in expected) {
        if (actual === undefined || actual === null) return false
        const lhs = actual instanceof Date ? actual.getTime() : actual
        const rhs = expected.$gt instanceof Date ? expected.$gt.getTime() : expected.$gt
        if (!(lhs > rhs)) return false
      }
      if ('$lt' in expected) {
        if (actual === undefined || actual === null) return false
        const lhs = actual instanceof Date ? actual.getTime() : actual
        const rhs = expected.$lt instanceof Date ? expected.$lt.getTime() : expected.$lt
        if (!(lhs < rhs)) return false
      }
      if ('$gte' in expected) {
        if (actual === undefined || actual === null) return false
        const lhs = actual instanceof Date ? actual.getTime() : actual
        const rhs = expected.$gte instanceof Date ? expected.$gte.getTime() : expected.$gte
        if (!(lhs >= rhs)) return false
      }
      if ('$type' in expected) {
        if (expected.$type === 'string' && typeof actual !== 'string') return false
      }
      continue
    }
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false
      continue
    }
    if (actual instanceof Types.ObjectId && typeof expected === 'string') {
      if (actual.toString() !== expected) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function setNested(target, path, value) {
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] ??= {}
    cursor = cursor[parts[i]]
  }
  cursor[parts[parts.length - 1]] = value
}

function unsetNested(target, path) {
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]]) return
    cursor = cursor[parts[i]]
  }
  delete cursor[parts[parts.length - 1]]
}

function getNested(target, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), target)
}

function applyUpdate(doc, update = {}, isInsert = false) {
  if (isInsert && update.$setOnInsert) {
    for (const [key, value] of Object.entries(update.$setOnInsert)) {
      if (getNested(doc, key) === undefined) setNested(doc, key, value)
    }
  }
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      setNested(doc, key, value)
    }
  }
  if (update.$inc) {
    for (const [key, delta] of Object.entries(update.$inc)) {
      const current = getNested(doc, key) ?? 0
      setNested(doc, key, current + delta)
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      unsetNested(doc, key)
    }
  }
  doc.updatedAt = new Date()
}

function makeChainQuery(compute) {
  const state = { sortSpec: null, skipCount: 0, limitCount: null }
  const chain = {
    select() { return chain },
    sort(spec) { state.sortSpec = spec; return chain },
    skip(count) { state.skipCount = count; return chain },
    limit(count) { state.limitCount = count; return chain },
    session() { return chain },
    lean() { return chain },
    async exec() {
      const result = await compute(state)
      return result
    },
    then(resolve, reject) {
      return chain.exec().then(resolve, reject)
    },
  }
  return chain
}

function sortDocs(docs, sortSpec) {
  if (!sortSpec) return [...docs]
  const entries = Object.entries(sortSpec)
  return [...docs].sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = a[field] instanceof Date ? a[field].getTime() : a[field] instanceof Types.ObjectId ? a[field].toString() : a[field]
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field] instanceof Types.ObjectId ? b[field].toString() : b[field]
      if (av === bv) continue
      if (av === undefined) return 1
      if (bv === undefined) return -1
      return (av < bv ? -1 : 1) * (dir < 0 ? -1 : 1)
    }
    return 0
  })
}

function webhookPayload(phoneNumberId, providerMessageId, text, from = '919876543210') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: phoneNumberId },
          contacts: [{ wa_id: from, profile: { name: 'Aarav Mehta' } }],
          messages: [{
            from,
            id: providerMessageId,
            timestamp: '1793613600',
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  }
}

async function withEndToEndHarness(run, initial = {}) {
  const businessId = new Types.ObjectId()
  const otherBusinessId = new Types.ObjectId()
  const ownerUserId = new Types.ObjectId()
  const otherOwnerUserId = new Types.ObjectId()
  const phoneNumberId = '1555000111222'
  const baseNow = new Date('2026-11-06T12:00:00.000Z')

  const db = {
    businesses: [
      {
        _id: businessId,
        ownerUserId,
        name: 'Acme Artisan Tea',
        whatsapp: {
          phoneNumberId,
          connectionStatus: 'verified',
        },
        aiSettings: {
          automaticRepliesEnabled: initial.businessAutomaticRepliesEnabled ?? true,
          automaticRepliesPolicyVersion: initial.policyVersion ?? 'policy-v1',
          automaticRepliesControlVersion: 0,
        },
      },
      {
        _id: otherBusinessId,
        ownerUserId: otherOwnerUserId,
        name: 'Other Workspace',
        whatsapp: {
          phoneNumberId: '1555999888777',
          connectionStatus: 'verified',
        },
        aiSettings: {
          automaticRepliesEnabled: false,
          automaticRepliesPolicyVersion: 'other-policy-v1',
          automaticRepliesControlVersion: 0,
        },
      },
    ],
    customers: [],
    conversations: [],
    messages: [],
    jobs: [],
    escalations: [],
    faqs: initial.faqs ?? [
      {
        _id: new Types.ObjectId(),
        businessId,
        question: 'What is your return policy?',
        answer: 'Unopened tea tins can be returned within 14 days.',
        isActive: true,
      },
    ],
    catalogItems: initial.catalogItems ?? [
      {
        _id: new Types.ObjectId(),
        businessId,
        kind: 'product',
        name: 'Darjeeling First Flush',
        description: 'Single-estate loose leaf black tea',
        priceInPaise: 65000,
        currency: 'INR',
        availability: 'in_stock',
        isActive: true,
      },
    ],
  }

  const providerCalls = {
    whatsappSends: [],
    geminiPrompts: [],
    nextGeminiHandler: initial.geminiHandler ?? (async () => ({ text: 'Unopened tea tins can be returned within 14 days.' })),
    nextWhatsAppHandler: initial.whatsAppHandler ?? (async (_business, to, text) => ({
      providerMessageId: `wamid.out.${providerCalls.whatsappSends.length}`,
      to,
      text,
    })),
    globalAutomaticSendEnabled: initial.globalAutomaticSendEnabled ?? true,
  }

  const originals = {
    startSession: mongoose.startSession,
    businessFind: Business.find,
    businessFindOne: Business.findOne,
    businessFindOneAndUpdate: Business.findOneAndUpdate,
    businessExists: Business.exists,
    customerFind: Customer.find,
    customerFindOne: Customer.findOne,
    customerFindOneAndUpdate: Customer.findOneAndUpdate,
    conversationFind: Conversation.find,
    conversationFindOne: Conversation.findOne,
    conversationFindOneAndUpdate: Conversation.findOneAndUpdate,
    conversationUpdateOne: Conversation.updateOne,
    conversationExists: Conversation.exists,
    messageFind: Message.find,
    messageFindOne: Message.findOne,
    messageCreate: Message.create,
    messageCount: Message.countDocuments,
    messageExists: Message.exists,
    jobFind: AiReplyJob.find,
    jobFindOne: AiReplyJob.findOne,
    jobFindOneAndUpdate: AiReplyJob.findOneAndUpdate,
    jobUpdateOne: AiReplyJob.updateOne,
    jobUpdateMany: AiReplyJob.updateMany,
    jobCreate: AiReplyJob.create,
    jobCount: AiReplyJob.countDocuments,
    jobExists: AiReplyJob.exists,
    escalationFind: AiReplyEscalation.find,
    escalationFindOne: AiReplyEscalation.findOne,
    escalationCreate: AiReplyEscalation.create,
    escalationUpdateOne: AiReplyEscalation.updateOne,
    escalationCount: AiReplyEscalation.countDocuments,
    faqFind: Faq.find,
    catalogFind: CatalogItem.find,
  }

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      await callback(this)
    },
    async endSession() {},
  })

  function wireCollection(Model, collectionName, defaultsOnCreate = () => ({})) {
    Model.find = (filter = {}) => makeChainQuery(({ sortSpec, skipCount, limitCount }) => {
      let list = db[collectionName].filter((doc) => matchesFilter(doc, filter))
      list = sortDocs(list, sortSpec)
      if (skipCount) list = list.slice(skipCount)
      if (limitCount !== null) list = list.slice(0, limitCount)
      return list.map((doc) => ({ ...doc }))
    })
    Model.findOne = (filter = {}) => makeChainQuery(({ sortSpec }) => {
      let list = db[collectionName].filter((doc) => matchesFilter(doc, filter))
      list = sortDocs(list, sortSpec)
      return list[0] ? { ...list[0] } : null
    })
    Model.exists = (filter = {}) => makeChainQuery(() => {
      const found = db[collectionName].find((doc) => matchesFilter(doc, filter))
      return found ? { _id: found._id } : null
    })
    Model.countDocuments = (filter = {}) => makeChainQuery(() =>
      db[collectionName].filter((doc) => matchesFilter(doc, filter)).length,
    )
    Model.updateOne = (filter = {}, update = {}) => makeChainQuery(() => {
      const target = db[collectionName].find((doc) => matchesFilter(doc, filter))
      if (!target) return { matchedCount: 0, modifiedCount: 0 }
      applyUpdate(target, update, false)
      return { matchedCount: 1, modifiedCount: 1 }
    })
    Model.updateMany = (filter = {}, update = {}) => makeChainQuery(() => {
      const targets = db[collectionName].filter((doc) => matchesFilter(doc, filter))
      for (const target of targets) applyUpdate(target, update, false)
      return { matchedCount: targets.length, modifiedCount: targets.length }
    })
    Model.findOneAndUpdate = (filter = {}, update = {}, options = {}) => makeChainQuery(({ sortSpec }) => {
      let candidates = db[collectionName].filter((doc) => matchesFilter(doc, filter))
      candidates = sortDocs(candidates, options.sort ?? sortSpec)
      let target = candidates[0]
      if (!target) {
        if (!options.upsert) return null
        target = {
          _id: new Types.ObjectId(),
          createdAt: new Date(baseNow),
          updatedAt: new Date(baseNow),
          ...defaultsOnCreate(filter),
        }
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$') && typeof v !== 'object') setNested(target, k, v)
          if (v instanceof Types.ObjectId) setNested(target, k, v)
        }
        applyUpdate(target, update, true)
        db[collectionName].push(target)
        return { ...target }
      }
      applyUpdate(target, update, false)
      return { ...target }
    })
    Model.create = async (input) => {
      const isArray = Array.isArray(input)
      const docs = isArray ? input : [input]
      const created = docs.map((item) => {
        if (collectionName === 'messages' && item.providerMessageId) {
          const dup = db.messages.find(
            (m) =>
              m.businessId.toString() === item.businessId.toString() &&
              m.providerMessageId === item.providerMessageId,
          )
          if (dup) {
            const err = new Error('Duplicate providerMessageId')
            err.code = 11000
            throw err
          }
        }
        if (collectionName === 'jobs') {
          const dup = db.jobs.find(
            (j) =>
              j.businessId.toString() === item.businessId.toString() &&
              j.inboundMessageId.toString() === item.inboundMessageId.toString(),
          )
          if (dup) {
            const err = new Error('Duplicate inboundMessageId job')
            err.code = 11000
            throw err
          }
        }
        if (collectionName === 'escalations') {
          const dup = db.escalations.find(
            (e) =>
              e.businessId.toString() === item.businessId.toString() &&
              e.inboundMessageId.toString() === item.inboundMessageId.toString(),
          )
          if (dup) {
            const err = new Error('Duplicate escalation')
            err.code = 11000
            throw err
          }
        }
        const now = new Date()
        const doc = {
          _id: new Types.ObjectId(),
          createdAt: now,
          updatedAt: now,
          ...defaultsOnCreate(item),
          ...item,
        }
        db[collectionName].push(doc)
        return doc
      })
      return isArray ? created : created[0]
    }
  }

  wireCollection(Business, 'businesses')
  wireCollection(Customer, 'customers')
  wireCollection(Conversation, 'conversations', () => ({
    status: 'open',
    responseMode: initial.defaultResponseMode ?? 'human',
    aiControlVersion: 0,
  }))
  wireCollection(Message, 'messages')
  wireCollection(AiReplyJob, 'jobs', () => ({
    status: 'queued',
    attemptCount: 0,
    nextAttemptAt: new Date(baseNow.getTime() - 1000),
  }))
  wireCollection(AiReplyEscalation, 'escalations', () => ({ status: 'open', evidence: [] }))
  wireCollection(Faq, 'faqs')
  wireCollection(CatalogItem, 'catalogItems')

  const sendWhatsAppStub = async (business, recipientPhone, text) => {
    providerCalls.whatsappSends.push({ business, recipientPhone, text })
    return providerCalls.nextWhatsAppHandler(business, recipientPhone, text)
  }

  const geminiGenerator = {
    async generateText(request) {
      providerCalls.geminiPrompts.push(request.prompt)
      return providerCalls.nextGeminiHandler(request)
    },
  }

  const safetyService = createAutomaticReplySafetyService({
    isAutomaticSendEnabled: () => providerCalls.globalAutomaticSendEnabled,
    log() {},
  })

  const automaticSendService = createAutomaticReplySendService({
    reserve: (await import('../dist/services/ai-reply-job.repository.js')).reserveAiAutomaticReplyForSending,
    complete: (await import('../dist/services/ai-reply-job.repository.js')).completeAiReplySend,
    recordOutcome: (await import('../dist/services/ai-reply-job.repository.js')).recordAiReplySendOutcome,
    sendText: sendWhatsAppStub,
    isProviderConfigured: () => true,
    isAutomaticSendEnabled: () => providerCalls.globalAutomaticSendEnabled,
    persistEscalation: (input, validation) => safetyService.persistEscalation(input, validation),
    log() {},
  })

  const automaticProcessor = createAiAutomaticReplyProcessor({
    contextService: businessContextService,
    promptBuilder: buildBusinessReplyPrompt,
    generator: geminiGenerator,
    checkEligibility: safetyService.checkEligibility,
    validate: safetyService.validate,
    persistEscalation: safetyService.persistEscalation,
    send: automaticSendService,
    isAutomaticSendEnabled: () => providerCalls.globalAutomaticSendEnabled,
    log() {},
  })

  const workerProcessor = createAiDraftProcessor({
    generator: geminiGenerator,
    automaticProcessor,
  })

  const draftSendService = createAiReplySendService({
    findJob: (bId, dId) => AiReplyJob.findOne({ _id: dId, businessId: bId }).exec(),
    findConversation: (cId, bId) => Conversation.findOne({ _id: cId, businessId: bId }).exec(),
    findCustomer: (custId, bId) => Customer.findOne({ _id: custId, businessId: bId }).exec(),
    findBusiness: (bId, uId) => Business.findOne({ _id: bId, ownerUserId: uId }).exec(),
    reserve: (await import('../dist/services/ai-reply-job.repository.js')).reserveAiReplyDraftForSending,
    complete: (await import('../dist/services/ai-reply-job.repository.js')).completeAiReplySend,
    recordOutcome: (await import('../dist/services/ai-reply-job.repository.js')).recordAiReplySendOutcome,
    sendText: sendWhatsAppStub,
    isProviderConfigured: () => true,
  })

  const authenticateTest = (request, response, next) => {
    const header = request.get('authorization')
    if (header === 'Bearer owner-token') {
      request.auth = { userId: ownerUserId.toString(), businessId: businessId.toString(), role: 'owner' }
      next()
      return
    }
    if (header === 'Bearer other-owner-token') {
      request.auth = { userId: otherOwnerUserId.toString(), businessId: otherBusinessId.toString(), role: 'owner' }
      next()
      return
    }
    response.status(401).json({ success: false, message: 'Authentication required.' })
  }

  const app = express()
  app.use(express.json())
  app.use(
    '/api/v1/conversations',
    createConversationsRouter(
      {
        async listConversations(bId) {
          const items = db.conversations
            .filter((c) => c.businessId.toString() === bId.toString())
            .map((c) => ({
              ...c,
              lastActivityAt: c.lastMessageAt ?? c.updatedAt ?? baseNow,
              customer: db.customers.find((cust) => cust._id.toString() === c.customerId.toString()),
            }))
          return { items, totalItems: items.length }
        },
        findConversation: (cId, bId) => Conversation.findOne({ _id: cId, businessId: bId }).exec(),
        async listMessages(cId, bId) {
          const items = db.messages.filter(
            (m) => m.conversationId.toString() === cId.toString() && m.businessId.toString() === bId.toString(),
          )
          return { items, totalItems: items.length }
        },
        findCustomer: (custId, bId) => Customer.findOne({ _id: custId, businessId: bId }).exec(),
        findBusiness: (bId, uId) => Business.findOne({ _id: bId, ownerUserId: uId }).exec(),
        sendText: sendWhatsAppStub,
        createMessage: (data) => Message.create(data),
        findMessageByProviderId: (bId, pId) => Message.findOne({ businessId: bId, providerMessageId: pId }).exec(),
        async updateConversationSummary(cId, bId, summary) {
          const res = await Conversation.updateOne({ _id: cId, businessId: bId }, { $set: summary }).exec()
          return res.matchedCount === 1
        },
        getResponseMode: (cId, bId) => Conversation.findOne({ _id: cId, businessId: bId }).exec(),
        automaticRepliesEnabled: async (bId, uId) =>
          Boolean(
            await Business.exists({
              _id: bId,
              ownerUserId: uId,
              'aiSettings.automaticRepliesEnabled': true,
            }).exec(),
          ),
        isAutomaticSendEnabled: () => providerCalls.globalAutomaticSendEnabled,
        changeResponseMode: (await import('../dist/services/ai-reply-job.repository.js')).setConversationResponseMode,
      },
      authenticateTest,
    ),
  )
  app.use(
    '/api/v1/ai-drafts',
    createAiDraftsRouter(
      {
        listDrafts: (await import('../dist/services/ai-reply-job.repository.js')).listAiReplyDrafts,
        listConversationDrafts: (await import('../dist/services/ai-reply-job.repository.js'))
          .listAiReplyDraftsForConversation,
        findDraft: (await import('../dist/services/ai-reply-job.repository.js')).findAiReplyDraft,
        approveDraft: (await import('../dist/services/ai-reply-job.repository.js')).approveAiReplyDraft,
        rejectDraft: (await import('../dist/services/ai-reply-job.repository.js')).rejectAiReplyDraft,
        sendDraft: draftSendService,
        conversationExists: async (cId, bId) => Boolean(await Conversation.exists({ _id: cId, businessId: bId }).exec()),
      },
      authenticateTest,
    ),
  )
  app.use('/api/v1/ai-escalations', createAiEscalationsRouter(undefined, authenticateTest))

  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  async function api(method, path, body, token = 'Bearer owner-token') {
    const headers = {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: token } : {}),
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    await run({
      db,
      businessId,
      otherBusinessId,
      ownerUserId,
      phoneNumberId,
      providerCalls,
      workerProcessor,
      api,
      ingest: (payload, flags = {}) =>
        ingestWhatsAppPayload(payload, undefined, {
          aiDraftWorkerEnabled: flags.aiDraftWorkerEnabled ?? true,
          aiAutomaticSendEnabled: flags.aiAutomaticSendEnabled ?? providerCalls.globalAutomaticSendEnabled,
        }),
    })
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    mongoose.startSession = originals.startSession
    Business.find = originals.businessFind
    Business.findOne = originals.businessFindOne
    Business.findOneAndUpdate = originals.businessFindOneAndUpdate
    Business.exists = originals.businessExists
    Customer.find = originals.customerFind
    Customer.findOne = originals.customerFindOne
    Customer.findOneAndUpdate = originals.customerFindOneAndUpdate
    Conversation.find = originals.conversationFind
    Conversation.findOne = originals.conversationFindOne
    Conversation.findOneAndUpdate = originals.conversationFindOneAndUpdate
    Conversation.updateOne = originals.conversationUpdateOne
    Conversation.exists = originals.conversationExists
    Message.find = originals.messageFind
    Message.findOne = originals.messageFindOne
    Message.create = originals.messageCreate
    Message.countDocuments = originals.messageCount
    Message.exists = originals.messageExists
    AiReplyJob.find = originals.jobFind
    AiReplyJob.findOne = originals.jobFindOne
    AiReplyJob.findOneAndUpdate = originals.jobFindOneAndUpdate
    AiReplyJob.updateOne = originals.jobUpdateOne
    AiReplyJob.updateMany = originals.jobUpdateMany
    AiReplyJob.create = originals.jobCreate
    AiReplyJob.countDocuments = originals.jobCount
    AiReplyJob.exists = originals.jobExists
    AiReplyEscalation.find = originals.escalationFind
    AiReplyEscalation.findOne = originals.escalationFindOne
    AiReplyEscalation.create = originals.escalationCreate
    AiReplyEscalation.updateOne = originals.escalationUpdateOne
    AiReplyEscalation.countDocuments = originals.escalationCount
    Faq.find = originals.faqFind
    CatalogItem.find = originals.catalogFind
  }
}

test('E2E 1: Human mode ingestion, duplicate webhook suppression, and manual owner WhatsApp reply', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, api, ingest }) => {
    const inbound = webhookPayload(phoneNumberId, 'wamid.human.1', 'Hello, do you ship to Mumbai?')
    const first = await ingest(inbound)
    assert.deepEqual(first, { kind: 'accepted', inserted: 1, duplicates: 0 })

    // Duplicate webhook delivery is suppressed without creating a second message or job.
    const duplicate = await ingest(inbound)
    assert.deepEqual(duplicate, { kind: 'accepted', inserted: 0, duplicates: 1 })
    assert.equal(db.messages.length, 1)
    assert.equal(db.jobs.length, 0)

    // Worker stays idle because Human mode never enqueues AI jobs.
    const workerOutcome = await workerProcessor.processNext()
    assert.deepEqual(workerOutcome, { kind: 'idle' })
    assert.equal(providerCalls.geminiPrompts.length, 0)
    assert.equal(providerCalls.whatsappSends.length, 0)

    // Owner sends manual reply via Inbox API.
    const conversationId = db.conversations[0]._id.toString()
    const manualSend = await api('POST', `/api/v1/conversations/${conversationId}/messages`, {
      text: 'Yes, we ship pan-India within 3 business days.',
    })
    assert.equal(manualSend.status, 201)
    assert.equal(providerCalls.whatsappSends.length, 1)
    assert.equal(providerCalls.whatsappSends[0].text, 'Yes, we ship pan-India within 3 business days.')
    assert.equal(db.messages.length, 2)
    assert.equal(db.messages[1].direction, 'outbound')
  }, { defaultResponseMode: 'human' })
})

test('E2E 2: AI Draft workflow — ingestion, worker generation, owner edit/approval, and explicit send', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, api, ingest }) => {
    providerCalls.nextGeminiHandler = async () => ({
      text: 'Our Darjeeling First Flush is available at ₹650.00.',
    })

    // 1. Ingest inbound message in ai_draft mode.
    const result = await ingest(webhookPayload(phoneNumberId, 'wamid.draft.1', 'Tell me about your Darjeeling tea'))
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(db.jobs.length, 1)
    assert.equal(db.jobs[0].status, 'queued')

    // 2. Worker processes job -> draft_ready (does NOT send a WhatsApp message).
    const outcome = await workerProcessor.processNext()
    assert.deepEqual(outcome, { kind: 'draft_ready' })
    assert.equal(providerCalls.whatsappSends.length, 0)
    assert.equal(db.jobs[0].status, 'draft_ready')

    // 3. Owner lists pending drafts and approves with an edit.
    const listRes = await api('GET', '/api/v1/ai-drafts?status=draft_ready')
    assert.equal(listRes.status, 200)
    assert.equal(listRes.body.drafts.length, 1)
    const draftId = listRes.body.drafts[0].id

    const approveRes = await api('POST', `/api/v1/ai-drafts/${draftId}/approve`, {
      approvedText: 'Our single-estate Darjeeling First Flush is in stock at ₹650.00.',
    })
    assert.equal(approveRes.status, 200)
    assert.equal(approveRes.body.draft.status, 'approved')
    assert.equal(providerCalls.whatsappSends.length, 0)

    // 4. Owner explicitly sends the approved draft -> WhatsApp message dispatched and persisted.
    const sendRes = await api('POST', `/api/v1/ai-drafts/${draftId}/send`, {})
    assert.equal(sendRes.status, 200)
    assert.equal(sendRes.body.draft.status, 'sent')
    assert.equal(providerCalls.whatsappSends.length, 1)
    assert.equal(
      providerCalls.whatsappSends[0].text,
      'Our single-estate Darjeeling First Flush is in stock at ₹650.00.',
    )

    // Repeated send call is idempotent and does not dispatch a duplicate WhatsApp message.
    const repeatSend = await api('POST', `/api/v1/ai-drafts/${draftId}/send`, {})
    assert.equal(repeatSend.status, 200)
    assert.equal(repeatSend.body.draft.alreadySent, true)
    assert.equal(providerCalls.whatsappSends.length, 1)
  }, { defaultResponseMode: 'ai_draft' })
})

test('E2E 3: AI Automatic happy path — exact FAQ match validated, reserved and sent automatically', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, ingest }) => {
    providerCalls.nextGeminiHandler = async () => ({
      text: 'Unopened tea tins can be returned within 14 days.',
    })

    // Ingest inbound message matching the exact active FAQ question.
    const result = await ingest(webhookPayload(phoneNumberId, 'wamid.auto.faq.1', 'What is your return policy?'))
    assert.deepEqual(result, { kind: 'accepted', inserted: 1, duplicates: 0 })
    assert.equal(db.jobs.length, 1)
    assert.equal(db.jobs[0].workflow, 'ai_automatic')

    // Worker validates against FAQ evidence, reserves, sends via WhatsApp, and persists outbound message.
    const outcome = await workerProcessor.processNext()
    assert.deepEqual(outcome, { kind: 'sent' })
    assert.equal(providerCalls.whatsappSends.length, 1)
    assert.equal(providerCalls.whatsappSends[0].text, 'Unopened tea tins can be returned within 14 days.')
    assert.equal(db.jobs[0].status, 'sent')
    assert.equal(db.jobs[0].sendProvenance, 'automatic_policy')
    assert.equal(db.escalations.length, 0)
    assert.equal(db.messages.length, 2)
    assert.equal(db.messages[1].direction, 'outbound')
  }, { defaultResponseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true })
})

test('E2E 4: AI Automatic unsupported question -> escalation created -> owner inspects & resolves without sending', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, api, ingest }) => {
    providerCalls.nextGeminiHandler = async () => ({
      text: 'We can arrange custom corporate gift hampers.',
    })

    // 1. Customer asks an unsupported question in ai_automatic mode.
    await ingest(
      webhookPayload(phoneNumberId, 'wamid.auto.escalate.1', 'Can you customize 200 corporate gift hampers with our logo?'),
    )
    assert.equal(db.jobs.length, 1)

    // 2. Worker runs safety validation -> rejects automatic send -> persists escalation and cancels job.
    const outcome = await workerProcessor.processNext()
    assert.deepEqual(outcome, { kind: 'escalated' })
    assert.equal(providerCalls.whatsappSends.length, 0)
    assert.equal(db.jobs[0].status, 'cancelled')
    assert.equal(db.escalations.length, 1)
    assert.equal(db.escalations[0].status, 'open')

    // 3. Owner lists escalations via the new Step 7.4.2 API.
    const listRes = await api('GET', '/api/v1/ai-escalations?status=open')
    assert.equal(listRes.status, 200)
    assert.equal(listRes.body.counts.pending, 1)
    assert.equal(listRes.body.escalations.length, 1)
    const escalationId = listRes.body.escalations[0].id
    assert.equal(
      listRes.body.escalations[0].inboundMessage.text,
      'Can you customize 200 corporate gift hampers with our logo?',
    )

    // Cross-business owner cannot view or resolve this escalation.
    const crossDetail = await api('GET', `/api/v1/ai-escalations/${escalationId}`, undefined, 'Bearer other-owner-token')
    assert.equal(crossDetail.status, 404)

    // 4. Owner inspects detail and resolves escalation with a note.
    const detailRes = await api('GET', `/api/v1/ai-escalations/${escalationId}`)
    assert.equal(detailRes.status, 200)
    assert.equal(detailRes.body.escalation.status, 'open')

    const resolveRes = await api('POST', `/api/v1/ai-escalations/${escalationId}/resolve`, {
      outcome: 'resolved',
      note: 'Called customer and sent custom hamper quote in Inbox.',
    })
    assert.equal(resolveRes.status, 200)
    assert.equal(resolveRes.body.escalation.status, 'resolved')
    assert.equal(resolveRes.body.escalation.resolutionNote, 'Called customer and sent custom hamper quote in Inbox.')
    // Resolving an escalation never triggers a WhatsApp message.
    assert.equal(providerCalls.whatsappSends.length, 0)

    // Duplicate resolution attempt is rejected with 409.
    const duplicateResolve = await api('POST', `/api/v1/ai-escalations/${escalationId}/resolve`, {
      outcome: 'dismissed',
    })
    assert.equal(duplicateResolve.status, 409)

    // Resolved filter now shows the closed escalation and 0 pending.
    const resolvedList = await api('GET', '/api/v1/ai-escalations?status=resolved')
    assert.equal(resolvedList.status, 200)
    assert.equal(resolvedList.body.counts.pending, 0)
    assert.equal(resolvedList.body.counts.resolved, 1)
    assert.equal(resolvedList.body.escalations[0].id, escalationId)
  }, { defaultResponseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true })
})

test('E2E 5: Human takeover during queued AI Draft and AI Automatic jobs prevents automatic sending', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, api, ingest }) => {
    // Part A: Queued AI Draft job cancelled after Human takeover.
    await ingest(webhookPayload(phoneNumberId, 'wamid.takeover.draft', 'What is your return policy?'))
    const conversationId = db.conversations[0]._id.toString()
    await api('PATCH', `/api/v1/conversations/${conversationId}/response-mode`, { responseMode: 'human' })

    const draftOutcome = await workerProcessor.processNext()
    assert.deepEqual(draftOutcome, { kind: 'cancelled' })
    assert.equal(db.jobs[0].status, 'cancelled')
    assert.equal(providerCalls.whatsappSends.length, 0)

    // Part B: Switch to AI Automatic, ingest message, then owner switches back to Human before worker runs.
    const autoMode = await api('PATCH', `/api/v1/conversations/${conversationId}/response-mode`, {
      responseMode: 'ai_automatic',
    })
    assert.equal(autoMode.status, 200)

    await ingest(webhookPayload(phoneNumberId, 'wamid.takeover.auto', 'What is your return policy?'))
    assert.equal(db.jobs.length, 2)
    assert.equal(db.jobs[1].workflow, 'ai_automatic')

    const humanTakeover = await api('PATCH', `/api/v1/conversations/${conversationId}/response-mode`, {
      responseMode: 'human',
    })
    assert.equal(humanTakeover.status, 200)

    // Worker detects mode mismatch/control fence change, records escalation, and cancels automatic job without sending.
    const autoOutcome = await workerProcessor.processNext()
    assert.deepEqual(autoOutcome, { kind: 'escalated' })
    assert.equal(db.jobs[1].status, 'cancelled')
    assert.equal(providerCalls.whatsappSends.length, 0)
    assert.equal(db.escalations.length, 1)
    assert.equal(db.escalations[0].reasonCode, 'conversation_mode_mismatch')
  }, { defaultResponseMode: 'ai_draft', businessAutomaticRepliesEnabled: true })
})

test('E2E 6: Uncertain WhatsApp send outcome and expired send/worker lease recovery never auto-retry sends', async () => {
  await withEndToEndHarness(async ({ db, phoneNumberId, providerCalls, workerProcessor, api, ingest }) => {
    // 1. Transient Gemini timeout schedules retry, then succeeds on next attempt.
    let geminiAttempts = 0
    providerCalls.nextGeminiHandler = async () => {
      geminiAttempts += 1
      if (geminiAttempts === 1) {
        throw new GeminiServiceError('timeout')
      }
      return { text: 'Unopened tea tins can be returned within 14 days.' }
    }

    await ingest(webhookPayload(phoneNumberId, 'wamid.uncertain.1', 'What is your return policy?'))
    const firstAttempt = await workerProcessor.processNext()
    assert.equal(firstAttempt.kind, 'retry_scheduled')
    assert.equal(db.jobs[0].status, 'queued')
    assert.equal(db.jobs[0].attemptCount, 1)

    // Make retry due immediately and simulate an ambiguous WhatsApp 503 failure during automatic send.
    db.jobs[0].nextAttemptAt = new Date(Date.now() - 1000)
    providerCalls.nextWhatsAppHandler = async () => {
      throw new WhatsAppCloudApiError('provider_http_error', 503)
    }

    const secondAttempt = await workerProcessor.processNext()
    assert.deepEqual(secondAttempt, { kind: 'send_uncertain' })
    assert.equal(db.jobs[0].status, 'send_uncertain')
    assert.equal(db.jobs[0].sendOutcome, 'uncertain')
    assert.equal(providerCalls.whatsappSends.length, 1)
    // Active send marker was cleared so the owner can inspect and take over, and worker never retries uncertain sends.
    assert.equal(db.conversations[0].activeAiSendJobId, undefined)
    assert.deepEqual(await workerProcessor.processNext(), { kind: 'idle' })
    assert.equal(providerCalls.whatsappSends.length, 1)

    // 2. Simulate a crashed send reservation whose lease expired in `sending` state:
    //    recovery transitions it to `send_uncertain` and unsets `activeAiSendJobId` without resending.
    const expiredSendJobId = new Types.ObjectId()
    const expiredAt = new Date(Date.now() - 10_000)
    db.jobs.push({
      _id: expiredSendJobId,
      businessId: db.businesses[0]._id,
      conversationId: db.conversations[0]._id,
      inboundMessageId: new Types.ObjectId(),
      status: 'sending',
      sendAttemptId: 'attempt-expired-1',
      sendLeaseExpiresAt: expiredAt,
      attemptCount: 1,
    })
    db.conversations[0].activeAiSendJobId = expiredSendJobId

    // While activeAiSendJobId is set, response mode changes are blocked with 409 send_in_progress.
    const blockedSwitch = await api(
      'PATCH',
      `/api/v1/conversations/${db.conversations[0]._id}/response-mode`,
      { responseMode: 'human' },
    )
    assert.equal(blockedSwitch.status, 409)
    assert.equal(blockedSwitch.body.code, 'send_in_progress')

    const recoveredCount = await recoverExpiredAiReplySendReservations(new Date(), 100)
    assert.equal(recoveredCount, 1)
    const recoveredJob = db.jobs.find((j) => j._id.equals(expiredSendJobId))
    assert.equal(recoveredJob.status, 'send_uncertain')
    assert.equal(recoveredJob.sendErrorCode, 'send_lease_expired')
    assert.equal(db.conversations[0].activeAiSendJobId, undefined)
    assert.equal(providerCalls.whatsappSends.length, 1)

    // 3. Simulate an expired worker generation lease: recovery requeues when attempts remain.
    const stuckProcessingJobId = new Types.ObjectId()
    db.jobs.push({
      _id: stuckProcessingJobId,
      businessId: db.businesses[0]._id,
      conversationId: db.conversations[0]._id,
      inboundMessageId: new Types.ObjectId(),
      status: 'processing',
      attemptCount: 1,
      leaseExpiresAt: expiredAt,
    })
    const workerRecovered = await recoverExpiredAiReplyJobsForWorker(new Date())
    assert.equal(workerRecovered, 1)
    const requeuedJob = db.jobs.find((j) => j._id.equals(stuckProcessingJobId))
    assert.equal(requeuedJob.status, 'queued')
  }, { defaultResponseMode: 'ai_automatic', businessAutomaticRepliesEnabled: true })
})
