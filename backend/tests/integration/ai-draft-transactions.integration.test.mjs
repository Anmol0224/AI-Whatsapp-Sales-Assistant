import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { AiReplyJob } from "../../dist/models/ai-reply-job.model.js";
import { Business } from "../../dist/models/business.model.js";
import { Conversation } from "../../dist/models/conversation.model.js";
import { Customer } from "../../dist/models/customer.model.js";
import { Message } from "../../dist/models/message.model.js";
import {
  approveAiReplyDraft,
  cancelProcessingAiReplyJob,
  claimQueuedAiReplyJob,
  completeAiReplySend,
  rejectAiReplyDraft,
  reserveAiReplyDraftForSending,
  saveAiReplyDraft,
  setConversationResponseMode,
  takeOverConversation,
} from "../../dist/services/ai-reply-job.repository.js";
import { ingestWhatsAppPayload } from "../../dist/services/whatsapp-ingestion.service.js";

const TEST_DATABASE_NAME = "whatsapp_sales_assistant_test";
const createdIds = {
  businesses: [],
  customers: [],
  conversations: [],
  messages: [],
  jobs: [],
};

function getVerifiedTestUri() {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_TEST_URI is required; provide a dedicated URI whose database path is whatsapp_sales_assistant_test.",
    );
  }

  let parsedUri;
  try {
    parsedUri = new URL(uri);
  } catch {
    throw new Error("MONGODB_TEST_URI must be a valid MongoDB URI.");
  }

  if (!(["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol)) || !parsedUri.hostname) {
    throw new Error("MONGODB_TEST_URI must use mongodb:// or mongodb+srv://.");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsedUri.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("MONGODB_TEST_URI must contain a verifiable test database path.");
  }

  if (databaseName !== TEST_DATABASE_NAME || parsedUri.hash) {
    throw new Error(
      "MONGODB_TEST_URI database path must be exactly whatsapp_sales_assistant_test.",
    );
  }

  return uri;
}

before(async () => {
  const uri = getVerifiedTestUri();
  try {
    await mongoose.connect(uri, {
      dbName: TEST_DATABASE_NAME,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
  } catch {
    throw new Error(
      "Could not connect to the isolated MongoDB test database; verify test-cluster access and transaction support.",
    );
  }

  if (mongoose.connection.name !== TEST_DATABASE_NAME) {
    await mongoose.disconnect();
    throw new Error("MongoDB connection did not resolve to the required isolated test database.");
  }
});

after(async () => {
  let cleanupFailed = false;
  try {
    if (mongoose.connection.readyState === 1) {
      for (const id of createdIds.jobs) {
        try {
          await AiReplyJob.deleteOne({ _id: id }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
      if (createdIds.businesses.length > 0) {
        try {
          await AiReplyJob.deleteMany({ businessId: { $in: createdIds.businesses } }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
      for (const id of createdIds.messages) {
        try {
          await Message.deleteOne({ _id: id }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
      for (const id of createdIds.conversations) {
        try {
          await Conversation.deleteOne({ _id: id }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
      for (const id of createdIds.customers) {
        try {
          await Customer.deleteOne({ _id: id }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
      for (const id of createdIds.businesses) {
        try {
          await Business.deleteOne({ _id: id }).exec();
        } catch {
          cleanupFailed = true;
        }
      }
    }
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }

  if (cleanupFailed) {
    throw new Error("One or more current-run test records could not be cleaned up.");
  }
});

async function createProcessingFixture() {
  const businessId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const messageId = new Types.ObjectId();
  const jobId = new Types.ObjectId();
  const now = new Date();

  createdIds.conversations.push(conversationId);
  createdIds.messages.push(messageId);
  createdIds.jobs.push(jobId);

  await Conversation.create({
    _id: conversationId,
    businessId,
    customerId,
    status: "open",
    responseMode: "ai",
    aiControlVersion: 0,
  });
  await Message.create({
    _id: messageId,
    businessId,
    conversationId,
    customerId,
    direction: "inbound",
    messageType: "text",
    text: "Is this available?",
    status: "received",
    timestamp: now,
  });
  await AiReplyJob.create({
    _id: jobId,
    businessId,
    conversationId,
    inboundMessageId: messageId,
    status: "queued",
    attemptCount: 0,
    nextAttemptAt: new Date(now.getTime() - 1),
  });

  const claimedJob = await claimQueuedAiReplyJob(businessId, {
    now: new Date(),
    leaseDurationMs: 120_000,
  });
  assert.ok(claimedJob);
  assert.equal(claimedJob._id.toString(), jobId.toString());

  return {
    businessId,
    customerId,
    conversationId,
    jobId,
    attemptCount: claimedJob.attemptCount,
  };
}

async function createDraftReadyFixture() {
  const fixture = await createProcessingFixture();
  assert.deepEqual(
    await saveAiReplyDraft(
      fixture.businessId,
      fixture.conversationId,
      fixture.jobId,
      fixture.attemptCount,
      "Draft for transaction verification",
    ),
    { kind: "saved" },
  );
  return fixture;
}

function testPhoneNumber() {
  return `919${String(Date.now()).slice(-9)}`;
}

function testPhoneNumberId() {
  return String(new Types.ObjectId()).replace(/[a-f]/gi, "1");
}

async function createIngestionWorkspace(options = {}) {
  const businessId = options.businessId ?? new Types.ObjectId();
  const customerId = options.customerId ?? new Types.ObjectId();
  const conversationId = options.conversationId ?? new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();
  const phoneNumber = options.phoneNumber ?? testPhoneNumber();
  const phoneNumberId = options.phoneNumberId ?? testPhoneNumberId();

  createdIds.businesses.push(businessId);
  if (options.createCustomer !== false) createdIds.customers.push(customerId);
  if (options.createConversation !== false) createdIds.conversations.push(conversationId);

  await Business.create({
    _id: businessId,
    ownerUserId,
    name: "Concurrent integration test business",
    whatsapp: { phoneNumberId, connectionStatus: "configured_not_verified" },
  });

  if (options.createCustomer !== false) {
    await Customer.create({ _id: customerId, businessId, phoneNumber, profileName: "Test customer" });
  }
  if (options.createConversation !== false) {
    await Conversation.create({
      _id: conversationId,
      businessId,
      customerId,
      status: "open",
      responseMode: options.responseMode ?? "ai",
      aiControlVersion: 0,
    });
  }

  return { businessId, customerId, conversationId, phoneNumber, phoneNumberId };
}

function incomingTextPayload(workspace, providerMessageId, text = "Concurrent customer message") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: workspace.phoneNumberId },
          contacts: [{ wa_id: workspace.phoneNumber, profile: { name: "Test customer" } }],
          messages: [{
            from: workspace.phoneNumber,
            id: providerMessageId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

async function assertRequiredUniqueIndex(model, name, key, partialFilterExpression) {
  let indexes;
  try {
    indexes = await model.collection.listIndexes().toArray();
  } catch {
    assert.fail(`Could not list required indexes for ${model.modelName}; no index changes were attempted.`);
  }
  const index = indexes.find((candidate) => candidate.name === name);
  assert.ok(index, `Required existing index ${name} is missing on ${model.modelName}; tests do not create or synchronize indexes.`);
  assert.equal(index.unique, true, `Existing index ${name} on ${model.modelName} must be unique.`);
  assert.deepEqual(index.key, key, `Existing index ${name} on ${model.modelName} has unexpected key fields.`);
  if (partialFilterExpression !== undefined) {
    assert.deepEqual(index.partialFilterExpression, partialFilterExpression, `Existing index ${name} on ${model.modelName} has an unexpected partial filter.`);
  }
}

function createQueryBarrier(label, expectedArrivals) {
  let arrivals = 0;
  let resolveGate;
  let rejectGate;
  const gate = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  const timer = setTimeout(() => rejectGate(new Error(`${label} synchronization barrier timed out after ${arrivals}/${expectedArrivals} arrivals.`)), 15_000);
  return {
    get arrivals() { return arrivals; },
    async arrive() {
      arrivals += 1;
      if (arrivals === expectedArrivals) {
        clearTimeout(timer);
        resolveGate();
      }
      if (arrivals <= expectedArrivals) await gate;
    },
  };
}

async function withMongoCommandBarrier(label, matcher, operation) {
  const originalExec = mongoose.Query.prototype.exec;
  const barrier = createQueryBarrier(label, 2);
  mongoose.Query.prototype.exec = async function (...args) {
    if (matcher(this)) await barrier.arrive();
    return originalExec.apply(this, args);
  };
  try {
    const results = await operation();
    assert.ok(barrier.arrivals >= 2, `${label} expected both database operations to reach the barrier; observed ${barrier.arrivals}.`);
    return results;
  } finally {
    mongoose.Query.prototype.exec = originalExec;
  }
}

function assertConcurrentOperationsFulfilled(label, results) {
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(
    rejected.length,
    0,
    `${label} had unexpected MongoDB operation failure(s): ${rejected.map(({ reason }) => `${reason?.name ?? "Error"}: ${reason?.message ?? "unknown"}`).join("; ")}`,
  );
  return results.map((result) => result.value);
}

test("real transaction commits the Conversation fence and AI draft job together", async () => {
  const fixture = await createProcessingFixture();

  const result = await saveAiReplyDraft(
    fixture.businessId,
    fixture.conversationId,
    fixture.jobId,
    fixture.attemptCount,
    "Suggested reply for owner review",
  );
  assert.deepEqual(result, { kind: "saved" });

  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, aiControlVersion: 1, responseMode: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, generatedDraft: 1 })
      .lean()
      .exec(),
  ]);

  assert.equal(conversation?.aiControlVersion, 1);
  assert.equal(conversation?.responseMode, "ai");
  assert.equal(job?.status, "draft_ready");
  assert.equal(job?.generatedDraft, "Suggested reply for owner review");
});

test("real transaction rollback leaves neither coordinated update persisted", async () => {
  const fixture = await createProcessingFixture();
  const session = await mongoose.startSession();
  let conversationWriteMatched = false;
  let jobWriteMatched = false;

  try {
    await assert.rejects(
      session.withTransaction(async () => {
        const conversation = await Conversation.findOneAndUpdate(
          {
            _id: fixture.conversationId,
            businessId: fixture.businessId,
            responseMode: "ai",
          },
          { $inc: { aiControlVersion: 1 } },
          { session, returnDocument: "after" },
        )
          .select({ _id: 1 })
          .lean()
          .exec();
        conversationWriteMatched = Boolean(conversation);

        const job = await AiReplyJob.findOneAndUpdate(
          {
            _id: fixture.jobId,
            businessId: fixture.businessId,
            conversationId: fixture.conversationId,
            status: "processing",
            attemptCount: fixture.attemptCount,
            leaseExpiresAt: { $gt: new Date() },
          },
          {
            $set: { status: "draft_ready", generatedDraft: "Controlled rollback draft" },
            $unset: { lockedAt: 1, leaseExpiresAt: 1, errorCode: 1 },
          },
          { session, returnDocument: "after" },
        )
          .select({ _id: 1 })
          .lean()
          .exec();
        jobWriteMatched = Boolean(job);

        throw new Error("CONTROLLED_INTEGRATION_TEST_ROLLBACK");
      }),
      /CONTROLLED_INTEGRATION_TEST_ROLLBACK/,
    );
  } finally {
    await session.endSession();
  }

  assert.equal(conversationWriteMatched, true);
  assert.equal(jobWriteMatched, true);

  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, generatedDraft: 1 })
      .lean()
      .exec(),
  ]);

  assert.equal(conversation?.aiControlVersion, 0);
  assert.equal(job?.status, "processing");
  assert.equal(job?.generatedDraft, undefined);
});

test("Human takeover first prevents draft persistence and the worker can cancel the live job", async () => {
  const fixture = await createProcessingFixture();

  assert.deepEqual(await takeOverConversation(fixture.businessId, fixture.conversationId), { kind: "taken_over" });
  assert.deepEqual(
    await saveAiReplyDraft(
      fixture.businessId,
      fixture.conversationId,
      fixture.jobId,
      fixture.attemptCount,
      "Must not persist",
    ),
    { kind: "mode_changed" },
  );
  assert.ok(
    await cancelProcessingAiReplyJob(
      fixture.businessId,
      fixture.jobId,
      fixture.attemptCount,
      new Date(),
    ),
  );

  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, responseMode: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, generatedDraft: 1 })
      .lean()
      .exec(),
  ]);

  assert.equal(conversation?.responseMode, "human");
  assert.equal(conversation?.aiControlVersion, 1);
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.generatedDraft, undefined);
});

test("draft persistence first preserves the owner-review draft after Human takeover", async () => {
  const fixture = await createProcessingFixture();

  assert.deepEqual(
    await saveAiReplyDraft(
      fixture.businessId,
      fixture.conversationId,
      fixture.jobId,
      fixture.attemptCount,
      "Draft remains for owner review",
    ),
    { kind: "saved" },
  );
  assert.deepEqual(await takeOverConversation(fixture.businessId, fixture.conversationId), { kind: "taken_over" });

  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, responseMode: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, generatedDraft: 1 })
      .lean()
      .exec(),
  ]);

  assert.equal(conversation?.responseMode, "human");
  assert.equal(conversation?.aiControlVersion, 2);
  assert.equal(job?.status, "draft_ready");
  assert.equal(job?.generatedDraft, "Draft remains for owner review");
});

test("real approval and send reservation serialize with takeover; confirmed completion commits message and job together", async () => {
  const fixture = await createDraftReadyFixture();
  const userId = new Types.ObjectId();
  const approval = await approveAiReplyDraft({
    businessId: fixture.businessId,
    userId,
    jobId: fixture.jobId,
  });
  assert.equal(approval.kind, "approved");

  const reservation = await reserveAiReplyDraftForSending({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    leaseDurationMs: 120_000,
  });
  assert.equal(reservation.kind, "reserved");
  if (reservation.kind !== "reserved") return;

  assert.deepEqual(
    await takeOverConversation(fixture.businessId, fixture.conversationId),
    { kind: "send_in_progress" },
  );
  const completion = await completeAiReplySend({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    sendAttemptId: reservation.sendAttemptId,
    providerMessageId: `wamid.integration-${new Types.ObjectId().toString()}`,
  });
  assert.equal(completion.kind, "sent");
  if (completion.kind !== "sent") return;
  createdIds.messages.push(completion.message._id);

  const [conversation, job, message] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, activeAiSendJobId: 1, lastMessagePreview: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, sendOutcome: 1, outboundMessageId: 1 })
      .lean()
      .exec(),
    Message.findOne({ _id: completion.message._id, businessId: fixture.businessId })
      .select({ _id: 1, aiReplyJobId: 1, direction: 1, status: 1 })
      .lean()
      .exec(),
  ]);

  assert.equal(conversation?.activeAiSendJobId, undefined);
  assert.equal(conversation?.lastMessagePreview, "Draft for transaction verification");
  assert.equal(job?.status, "sent");
  assert.equal(job?.sendOutcome, "accepted");
  assert.equal(job?.outboundMessageId?.toString(), completion.message._id.toString());
  assert.equal(message?.aiReplyJobId?.toString(), fixture.jobId.toString());
  assert.equal(message?.direction, "outbound");
  assert.equal(message?.status, "sent");
});

test("real takeover after approval invalidates the approved control version before reservation", async () => {
  const fixture = await createDraftReadyFixture();
  const approval = await approveAiReplyDraft({
    businessId: fixture.businessId,
    userId: new Types.ObjectId(),
    jobId: fixture.jobId,
  });
  assert.equal(approval.kind, "approved");
  assert.deepEqual(await takeOverConversation(fixture.businessId, fixture.conversationId), { kind: "taken_over" });

  assert.deepEqual(
    await reserveAiReplyDraftForSending({ businessId: fixture.businessId, jobId: fixture.jobId }),
    { kind: "mode_changed" },
  );
  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, responseMode: 1, activeAiSendJobId: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(conversation?.responseMode, "human");
  assert.equal(conversation?.activeAiSendJobId, undefined);
  assert.equal(job?.status, "approved");
});

test("a newly committed inbound message fences an existing draft from approval", async () => {
  const fixture = await createDraftReadyFixture();
  const inboundMessageId = new Types.ObjectId();
  createdIds.messages.push(inboundMessageId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Message.create([{
        _id: inboundMessageId,
        businessId: fixture.businessId,
        conversationId: fixture.conversationId,
        customerId: new Types.ObjectId(),
        direction: "inbound",
        messageType: "text",
        text: "A newer customer message",
        status: "received",
      }], { session });
      await Message.updateOne(
        { _id: inboundMessageId, businessId: fixture.businessId },
        { $set: { createdAt: new Date(Date.now() + 10_000) } },
        { session, timestamps: false },
      ).exec();
      const update = await Conversation.updateOne(
        { _id: fixture.conversationId, businessId: fixture.businessId },
        { $inc: { aiControlVersion: 1 } },
        { session, runValidators: true },
      ).exec();
      assert.equal(update.matchedCount, 1);
    });
  } finally {
    await session.endSession();
  }

  assert.deepEqual(await approveAiReplyDraft({
    businessId: fixture.businessId,
    userId: new Types.ObjectId(),
    jobId: fixture.jobId,
  }), { kind: "stale" });
  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, approvedAt: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(conversation?.aiControlVersion, 2);
  assert.equal(job?.status, "draft_ready");
  assert.equal(job?.approvedAt, undefined);
});

test("resuming AI mode fences drafts created before the mode change", async () => {
  const fixture = await createDraftReadyFixture();
  assert.deepEqual(await takeOverConversation(fixture.businessId, fixture.conversationId), { kind: "taken_over" });
  const humanConversation = await Conversation.findOne({
    _id: fixture.conversationId,
    businessId: fixture.businessId,
  }).select({ _id: 1, aiControlVersion: 1 }).lean().exec();

  assert.deepEqual(await setConversationResponseMode(
    fixture.businessId,
    fixture.conversationId,
    "ai",
  ), { kind: "updated", responseMode: "ai" });
  assert.deepEqual(await approveAiReplyDraft({
    businessId: fixture.businessId,
    userId: new Types.ObjectId(),
    jobId: fixture.jobId,
  }), { kind: "stale" });
  const conversation = await Conversation.findOne({
    _id: fixture.conversationId,
    businessId: fixture.businessId,
  }).select({ _id: 1, responseMode: 1, aiControlVersion: 1 }).lean().exec();
  assert.equal(humanConversation?.aiControlVersion, 2);
  assert.equal(conversation?.responseMode, "ai");
  assert.equal(conversation?.aiControlVersion, 3);
});

test("concurrent distinct inbound messages both persist and increment the fence", async () => {
  await assertRequiredUniqueIndex(Customer, "customers_business_phone_unique", { businessId: 1, phoneNumber: 1 });
  await assertRequiredUniqueIndex(Conversation, "conversations_business_customer_unique", { businessId: 1, customerId: 1 });
  await assertRequiredUniqueIndex(Message, "messages_business_provider_id_unique", { businessId: 1, providerMessageId: 1 }, {
    providerMessageId: { $type: "string", $gt: "" },
  });
  await assertRequiredUniqueIndex(AiReplyJob, "ai_reply_jobs_business_inbound_unique", { businessId: 1, inboundMessageId: 1 });
  const workspace = await createIngestionWorkspace();
  const matcher = (query) => query.model?.modelName === "Customer" &&
    query.op === "findOneAndUpdate" &&
    query._conditions?.businessId?.toString() === workspace.businessId.toString() &&
    query._conditions?.phoneNumber === workspace.phoneNumber;

  const settled = await withMongoCommandBarrier("distinct inbound customer upserts", matcher, () =>
    Promise.allSettled([
      ingestWhatsAppPayload(incomingTextPayload(workspace, `wamid.concurrent-a-${new Types.ObjectId()}`, "First concurrent inbound"), undefined, { aiDraftWorkerEnabled: true }),
      ingestWhatsAppPayload(incomingTextPayload(workspace, `wamid.concurrent-b-${new Types.ObjectId()}`, "Second concurrent inbound"), undefined, { aiDraftWorkerEnabled: true }),
    ]),
  );
  const results = assertConcurrentOperationsFulfilled("distinct inbound messages", settled);
  assert.deepEqual(results, [
    { kind: "accepted", inserted: 1, duplicates: 0 },
    { kind: "accepted", inserted: 1, duplicates: 0 },
  ]);

  const [messages, conversation, customers, conversations, jobs] = await Promise.all([
    Message.find({ businessId: workspace.businessId, conversationId: workspace.conversationId, direction: "inbound" })
      .select({ _id: 1, providerMessageId: 1 })
      .lean()
      .exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId })
      .select({ _id: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    Customer.find({ businessId: workspace.businessId, phoneNumber: workspace.phoneNumber }).select({ _id: 1 }).lean().exec(),
    Conversation.find({ businessId: workspace.businessId, customerId: workspace.customerId }).select({ _id: 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId, conversationId: workspace.conversationId })
      .select({ _id: 1, inboundMessageId: 1, status: 1 })
      .lean()
      .exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 2);
  assert.equal(new Set(messages.map((message) => message.providerMessageId)).size, 2);
  assert.equal(conversation?.aiControlVersion, 2);
  assert.equal(customers.length, 1);
  assert.equal(conversations.length, 1);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.status === "queued"));
  assert.deepEqual(
    new Set(jobs.map((job) => job.inboundMessageId.toString())),
    new Set(messages.map((message) => message._id.toString())),
  );
});

test("real ingestion transaction commits an inbound message, fence and queued AI job together", async () => {
  await assertRequiredUniqueIndex(AiReplyJob, "ai_reply_jobs_business_inbound_unique", { businessId: 1, inboundMessageId: 1 });
  const workspace = await createIngestionWorkspace({ responseMode: "ai" });
  const result = await ingestWhatsAppPayload(
    incomingTextPayload(workspace, `wamid.atomic-job-${new Types.ObjectId()}`),
    undefined,
    { aiDraftWorkerEnabled: true },
  );
  assert.deepEqual(result, { kind: "accepted", inserted: 1, duplicates: 0 });

  const [message, conversation, jobs] = await Promise.all([
    Message.findOne({ businessId: workspace.businessId, direction: "inbound" })
      .select({ _id: 1, conversationId: 1 })
      .lean()
      .exec(),
    Conversation.findOne({ businessId: workspace.businessId })
      .select({ _id: 1, aiControlVersion: 1, responseMode: 1 })
      .lean()
      .exec(),
    AiReplyJob.find({ businessId: workspace.businessId })
      .select({ _id: 1, conversationId: 1, inboundMessageId: 1, status: 1 })
      .lean()
      .exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.ok(message);
  assert.ok(conversation);
  assert.equal(conversation.responseMode, "ai");
  assert.equal(conversation.aiControlVersion, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].conversationId.toString(), conversation._id.toString());
  assert.equal(jobs[0].inboundMessageId.toString(), message._id.toString());
});

test("real ingestion transaction rolls back inbound persistence when queued job creation fails", async () => {
  await assertRequiredUniqueIndex(AiReplyJob, "ai_reply_jobs_business_inbound_unique", { businessId: 1, inboundMessageId: 1 });
  const workspace = await createIngestionWorkspace({ responseMode: "ai" });
  const originalCreate = AiReplyJob.create;
  let injectedFailure = false;
  AiReplyJob.create = async function (documents, options) {
    const result = await originalCreate.call(this, documents, options);
    if (!injectedFailure) {
      injectedFailure = true;
      throw new Error("Injected transactional AI job creation failure");
    }
    return result;
  };

  try {
    await assert.rejects(
      ingestWhatsAppPayload(
        incomingTextPayload(workspace, `wamid.rollback-job-${new Types.ObjectId()}`),
        undefined,
        { aiDraftWorkerEnabled: true },
      ),
    );
  } finally {
    AiReplyJob.create = originalCreate;
  }

  assert.equal(injectedFailure, true, "AI reply job creation failure should be reached");

  const [messages, customers, conversations, jobs] = await Promise.all([
    Message.find({ businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
    Customer.find({ _id: workspace.customerId, businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
    Conversation.find({ _id: workspace.conversationId, businessId: workspace.businessId })
      .select({ _id: 1, responseMode: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 0);
  assert.equal(customers.length, 1);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].responseMode, "ai");
  assert.equal(conversations[0].aiControlVersion, 0);
  assert.equal(jobs.length, 0);
});

test("Human takeover committed before inbound conversation fencing prevents a queued AI job", async () => {
  await assertRequiredUniqueIndex(AiReplyJob, "ai_reply_jobs_business_inbound_unique", { businessId: 1, inboundMessageId: 1 });
  const workspace = await createIngestionWorkspace();
  let releaseIngestion;
  let reachedFence;
  const atFence = new Promise((resolve) => { reachedFence = resolve; });
  const ingestionMayContinue = new Promise((resolve) => { releaseIngestion = resolve; });
  const originalExec = mongoose.Query.prototype.exec;
  let intercepted = false;

  mongoose.Query.prototype.exec = async function (...args) {
    if (!intercepted && this.model?.modelName === "Conversation" && this.op === "updateOne" &&
      this._conditions?._id?.toString() === workspace.conversationId.toString() &&
      this._update?.$inc?.aiControlVersion === 1) {
      intercepted = true;
      reachedFence();
      await ingestionMayContinue;
    }
    return originalExec.apply(this, args);
  };

  let ingestionPromise;
  try {
    ingestionPromise = ingestWhatsAppPayload(
      incomingTextPayload(workspace, `wamid.takeover-${new Types.ObjectId()}`),
      undefined,
      { aiDraftWorkerEnabled: true },
    );
    await atFence;
    assert.deepEqual(await takeOverConversation(workspace.businessId, workspace.conversationId), { kind: "taken_over" });
  } finally {
    releaseIngestion();
    mongoose.Query.prototype.exec = originalExec;
  }

  assert.deepEqual(await ingestionPromise, { kind: "accepted", inserted: 1, duplicates: 0 });
  const [conversation, messages, jobs] = await Promise.all([
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId })
      .select({ _id: 1, responseMode: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
    Message.find({ businessId: workspace.businessId, conversationId: workspace.conversationId, direction: "inbound" })
      .select({ _id: 1 })
      .lean()
      .exec(),
    AiReplyJob.find({ businessId: workspace.businessId, conversationId: workspace.conversationId })
      .select({ _id: 1 })
      .lean()
      .exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(conversation?.responseMode, "human");
  assert.equal(conversation?.aiControlVersion, 2);
  assert.equal(messages.length, 1);
  assert.equal(jobs.length, 0);
});

test("inbound persistence racing approval never leaves a stale draft reservable", async () => {
  const fixture = await createDraftReadyFixture();
  const workspace = await createIngestionWorkspace({
    businessId: fixture.businessId,
    customerId: fixture.customerId,
    conversationId: fixture.conversationId,
    createConversation: false,
  });
  const newInboundId = `wamid.approval-race-${new Types.ObjectId()}`;
  const matcher = (query) =>
    (query.model?.modelName === "Conversation" && query.op === "updateOne" &&
      query._conditions?._id?.toString() === fixture.conversationId.toString()) ||
    (query.model?.modelName === "Conversation" && query.op === "findOneAndUpdate" &&
      query._conditions?._id?.toString() === fixture.conversationId.toString() &&
      query._conditions?.aiControlVersion !== undefined);

  const settled = await withMongoCommandBarrier("inbound versus approval conversation writes", matcher, () =>
    Promise.allSettled([
      ingestWhatsAppPayload(incomingTextPayload(workspace, newInboundId, "Arriving during approval")),
      approveAiReplyDraft({ businessId: fixture.businessId, userId: new Types.ObjectId(), jobId: fixture.jobId }),
    ]),
  );
  const [ingestion, approval] = assertConcurrentOperationsFulfilled("inbound versus approval", settled);
  assert.deepEqual(ingestion, { kind: "accepted", inserted: 1, duplicates: 0 });
  assert.ok(["approved", "stale"].includes(approval.kind), `Unexpected approval result: ${approval.kind}`);

  const [conversation, job, inboundMessages] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, aiControlVersion: 1, activeAiSendJobId: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1, approvedControlVersion: 1 })
      .lean()
      .exec(),
    Message.find({ businessId: fixture.businessId, conversationId: fixture.conversationId, direction: "inbound" })
      .select({ _id: 1, providerMessageId: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(inboundMessages.length, 2);
  assert.ok(conversation?.aiControlVersion >= 2);
  assert.equal(conversation?.activeAiSendJobId, undefined);
  assert.equal(job?.status, approval.kind === "approved" ? "approved" : "draft_ready");
  assert.notEqual(
    (await reserveAiReplyDraftForSending({ businessId: fixture.businessId, jobId: fixture.jobId })).kind,
    "reserved",
  );
});

test("approval racing human takeover always ends in human mode without a send marker", async () => {
  const fixture = await createDraftReadyFixture();
  const matcher = (query) => {
    if (query.model?.modelName !== "Conversation" || query.op !== "findOneAndUpdate" ||
      query._conditions?._id?.toString() !== fixture.conversationId.toString() ||
      query._conditions?.responseMode !== "ai") return false;
    return query._conditions?.aiControlVersion !== undefined ||
      query._update?.$set?.responseMode === "human";
  };

  const settled = await withMongoCommandBarrier("approval versus takeover conversation writes", matcher, () =>
    Promise.allSettled([
      approveAiReplyDraft({ businessId: fixture.businessId, userId: new Types.ObjectId(), jobId: fixture.jobId }),
      takeOverConversation(fixture.businessId, fixture.conversationId),
    ]),
  );
  const [approval, takeover] = assertConcurrentOperationsFulfilled("approval versus takeover", settled);
  assert.ok(["approved", "mode_changed", "stale"].includes(approval.kind));
  assert.ok(["taken_over", "already_human"].includes(takeover.kind));

  const [conversation, job] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ _id: 1, responseMode: 1, activeAiSendJobId: 1 })
      .lean()
      .exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ _id: 1, status: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(conversation?.responseMode, "human");
  assert.equal(conversation?.activeAiSendJobId, undefined);
  assert.equal(job?.status, approval.kind === "approved" ? "approved" : "draft_ready");
  assert.notEqual(
    (await reserveAiReplyDraftForSending({ businessId: fixture.businessId, jobId: fixture.jobId })).kind,
    "reserved",
  );
});

test("approval racing rejection has exactly one terminal winner", async () => {
  const fixture = await createDraftReadyFixture();
  const matcher = (query) => query.model?.modelName === "AiReplyJob" &&
    query.op === "updateOne" &&
    query._conditions?._id?.toString() === fixture.jobId.toString() &&
    query._conditions?.businessId?.toString() === fixture.businessId.toString() &&
    query._conditions?.status === "draft_ready";

  const settled = await withMongoCommandBarrier("approval versus rejection job writes", matcher, () =>
    Promise.allSettled([
      approveAiReplyDraft({ businessId: fixture.businessId, userId: new Types.ObjectId(), jobId: fixture.jobId }),
      rejectAiReplyDraft({ businessId: fixture.businessId, userId: new Types.ObjectId(), jobId: fixture.jobId, reason: "Not approved" }),
    ]),
  );
  const [approval, rejection] = assertConcurrentOperationsFulfilled("approval versus rejection", settled);
  const approvalWon = approval.kind === "approved";
  const rejectionWon = rejection.kind === "rejected";
  assert.notEqual(approvalWon, rejectionWon, "Exactly one transition must win.");
  assert.ok(["conflict", "not_found"].includes(approval.kind) || approvalWon);
  assert.ok(["conflict", "not_found"].includes(rejection.kind) || rejectionWon);

  const job = await AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
    .select({ _id: 1, status: 1, approvedByUserId: 1, approvedAt: 1, approvedText: 1, rejectedByUserId: 1, rejectedAt: 1, rejectionReason: 1 })
    .lean()
    .exec();
  assert.ok(job);
  assert.equal(job.status, approvalWon ? "approved" : "rejected");
  assert.equal(Boolean(job.approvedAt), approvalWon);
  assert.equal(Boolean(job.rejectedAt), rejectionWon);
  assert.equal(Boolean(job.approvedByUserId), approvalWon);
  assert.equal(Boolean(job.rejectedByUserId), rejectionWon);
});

test("concurrent duplicate webhook deliveries persist exactly one message and one fence increment", async () => {
  await assertRequiredUniqueIndex(Customer, "customers_business_phone_unique", { businessId: 1, phoneNumber: 1 });
  await assertRequiredUniqueIndex(Conversation, "conversations_business_customer_unique", { businessId: 1, customerId: 1 });
  await assertRequiredUniqueIndex(Message, "messages_business_provider_id_unique", { businessId: 1, providerMessageId: 1 }, {
    providerMessageId: { $type: "string", $gt: "" },
  });
  const workspace = await createIngestionWorkspace({ createCustomer: false, createConversation: false });
  const providerMessageId = `wamid.duplicate-race-${new Types.ObjectId()}`;
  const matcher = (query) => query.model?.modelName === "Customer" &&
    query.op === "findOneAndUpdate" &&
    query._conditions?.businessId?.toString() === workspace.businessId.toString() &&
    query._conditions?.phoneNumber === workspace.phoneNumber;

  const settled = await withMongoCommandBarrier("duplicate webhook customer upserts", matcher, () =>
    Promise.allSettled([
      ingestWhatsAppPayload(incomingTextPayload(workspace, providerMessageId, "Same provider event")),
      ingestWhatsAppPayload(incomingTextPayload(workspace, providerMessageId, "Same provider event")),
    ]),
  );
  const results = assertConcurrentOperationsFulfilled("duplicate webhook delivery", settled);
  assert.equal(results.every((result) => result.kind === "accepted"), true);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.duplicates, 0), 1);

  const [messages, customers, conversations] = await Promise.all([
    Message.find({ businessId: workspace.businessId, providerMessageId })
      .select({ _id: 1, conversationId: 1, customerId: 1, direction: 1 })
      .lean()
      .exec(),
    Customer.find({ businessId: workspace.businessId, phoneNumber: workspace.phoneNumber })
      .select({ _id: 1 })
      .lean()
      .exec(),
    Conversation.find({ businessId: workspace.businessId })
      .select({ _id: 1, customerId: 1, aiControlVersion: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "inbound");
  assert.equal(customers.length, 1);
  assert.equal(conversations.length, 1);
  assert.equal(messages[0].customerId.toString(), customers[0]._id.toString());
  assert.equal(messages[0].conversationId.toString(), conversations[0]._id.toString());
  assert.equal(conversations[0].aiControlVersion, 1);
});
