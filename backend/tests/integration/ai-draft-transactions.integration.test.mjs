import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { AiReplyJob } from "../../dist/models/ai-reply-job.model.js";
import { Business } from "../../dist/models/business.model.js";
import { Conversation } from "../../dist/models/conversation.model.js";
import { Customer } from "../../dist/models/customer.model.js";
import { Faq } from "../../dist/models/faq.model.js";
import { Message } from "../../dist/models/message.model.js";
import {
  approveAiReplyDraft,
  cancelProcessingAiReplyJob,
  claimQueuedAiReplyJob,
  completeAiReplySend,
  finishAutomaticAiReplyJob,
  persistAutomaticAiReply,
  rejectAiReplyDraft,
  recoverExpiredAiReplySendReservations,
  reserveAiAutomaticReplyForSending,
  reserveAiReplyDraftForSending,
  recoverExpiredAiReplyJobsForWorker,
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
  faqs: [],
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
      for (const id of createdIds.faqs) {
        try {
          await Faq.deleteOne({ _id: id }).exec();
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

async function createAutomaticReadyFixture(options = {}) {
  const businessId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const inboundMessageId = new Types.ObjectId();
  const jobId = new Types.ObjectId();
  const faqId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();
  const now = new Date();
  const policyVersion = new Types.ObjectId().toString();
  const phoneNumber = testPhoneNumber();
  const phoneNumberId = testPhoneNumberId();
  const question = "What is your return policy?";
  const answer = "Returns are accepted within 14 days.";

  createdIds.businesses.push(businessId);
  createdIds.customers.push(customerId);
  createdIds.conversations.push(conversationId);
  createdIds.messages.push(inboundMessageId);
  createdIds.jobs.push(jobId);
  createdIds.faqs.push(faqId);

  await Business.create({
    _id: businessId,
    ownerUserId,
    name: "Automatic reservation integration fixture",
    whatsapp: { phoneNumberId, connectionStatus: "configured_not_verified" },
    aiSettings: {
      automaticRepliesEnabled: true,
      automaticRepliesPolicyVersion: policyVersion,
      automaticRepliesControlVersion: 0,
    },
  });
  await Customer.create({ _id: customerId, businessId, phoneNumber, profileName: "Test customer" });
  await Conversation.create({
    _id: conversationId,
    businessId,
    customerId,
    status: "open",
    responseMode: "ai_automatic",
    aiControlVersion: 0,
  });
  await Message.create({
    _id: inboundMessageId,
    businessId,
    conversationId,
    customerId,
    direction: "inbound",
    messageType: "text",
    text: options.inboundText ?? question,
    status: "received",
    timestamp: now,
  });
  await Faq.create({ _id: faqId, businessId, question, answer, isActive: true });
  await AiReplyJob.create({
    _id: jobId,
    businessId,
    conversationId,
    inboundMessageId,
    workflow: "ai_automatic",
    status: "automatic_ready",
    attemptCount: 0,
    nextAttemptAt: now,
    automaticReplyTextSnapshot: answer,
    automaticSafetyDecision: "eligible",
    automaticPolicyVersion: policyVersion,
    workflowControlVersion: 0,
  });

  return { businessId, customerId, conversationId, inboundMessageId, jobId, faqId, answer, question, policyVersion };
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
    ...(options.automaticRepliesEnabled === undefined ? {} : {
      aiSettings: {
        automaticRepliesEnabled: options.automaticRepliesEnabled,
        automaticRepliesPolicyVersion: options.policyVersion,
        automaticRepliesControlVersion: 0,
      },
    }),
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
  // A barrier can time out before any query has started awaiting it. Keep that
  // rejection observed while preserving rejection for any operation at gate.
  void gate.catch(() => {});
  const timer = setTimeout(() => rejectGate(new Error(`${label} synchronization barrier timed out after ${arrivals}/${expectedArrivals} arrivals.`)), 15_000);
  return {
    get arrivals() { return arrivals; },
    cancel() { clearTimeout(timer); },
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
    barrier.cancel();
  }
}

const automaticSendGateEnabled = () => true;

async function assertAutomaticFixtureState(fixture, expected = {}) {
  const expectedMode = expected.responseMode ?? "ai_automatic";
  const expectedControlVersion = expected.controlVersion ?? 0;
  const expectedJobId = expected.jobId ?? fixture.jobId;
  const expectedJobControlVersion = expected.jobControlVersion ?? expectedControlVersion;
  const expectedPolicyVersion = expected.policyVersion ?? fixture.policyVersion;
  const [business, conversation, job] = await Promise.all([
    Business.findOne({ _id: fixture.businessId })
      .select({ "aiSettings.automaticRepliesEnabled": 1, "aiSettings.automaticRepliesPolicyVersion": 1 })
      .lean().exec(),
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ responseMode: 1, aiControlVersion: 1 })
      .lean().exec(),
    AiReplyJob.findOne({ _id: expectedJobId, businessId: fixture.businessId })
      .select({ automaticPolicyVersion: 1, workflowControlVersion: 1 })
      .lean().exec(),
  ]);

  assert.ok(business, "automatic-send fixture Business must exist");
  assert.equal(business.aiSettings?.automaticRepliesEnabled, true, "automatic-send fixture must persist owner opt-in");
  assert.equal(
    business.aiSettings?.automaticRepliesPolicyVersion,
    expectedPolicyVersion,
    "automatic-send fixture must persist the expected policy version",
  );
  assert.equal(automaticSendGateEnabled(), true, "automatic-send global test gate must be enabled");
  assert.ok(conversation, "automatic-send fixture Conversation must exist in the fixture business");
  assert.equal(conversation.responseMode, expectedMode, "automatic-send fixture must persist the expected response mode");
  assert.equal(conversation.aiControlVersion, expectedControlVersion, "automatic-send fixture must persist the expected control version");
  assert.ok(job, "automatic-send fixture job must exist in the fixture business");
  assert.equal(job.automaticPolicyVersion, expectedPolicyVersion, "automatic-send job must snapshot the expected policy version");
  assert.equal(job.workflowControlVersion, expectedJobControlVersion, "automatic-send job must snapshot the expected control version");
}

function safeAutomaticReservationDiagnostic(result) {
  const validation = result?.validation;
  return JSON.stringify({
    category: result?.kind,
    ...(validation ? {
      decision: validation.decision,
      reasonCode: validation.reasonCode,
      ...(validation.policyVersion === undefined ? {} : { policyVersion: validation.policyVersion }),
      ...(validation.expectedPolicyVersion === undefined ? {} : { expectedPolicyVersion: validation.expectedPolicyVersion }),
      ...(validation.controlVersion === undefined ? {} : { controlVersion: validation.controlVersion }),
      ...(validation.expectedControlVersion === undefined ? {} : { expectedControlVersion: validation.expectedControlVersion }),
    } : {}),
  });
}

function assertAutomaticReservationKind(result, expectedKind, label) {
  assert.equal(
    result.kind,
    expectedKind,
    `${label}: ${safeAutomaticReservationDiagnostic(result)}`,
  );
}

function assertAutomaticSafetyReason(result, expectedReasonCode, label) {
  assertAutomaticReservationKind(result, "safety_rejected", label);
  assert.equal(
    result.validation.reasonCode,
    expectedReasonCode,
    `${label}: ${safeAutomaticReservationDiagnostic(result)}`,
  );
}

function reservationJobReadMatcher(businessId, jobIds) {
  const expectedIds = new Set(jobIds.map((id) => id.toString()));
  return (query) => {
    const filter = query.getFilter();
    return query.op === "findOne" && query.model?.modelName === "AiReplyJob" &&
      filter.businessId?.toString() === businessId.toString() &&
      expectedIds.has(filter._id?.toString());
  };
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

  const replay = await completeAiReplySend({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    sendAttemptId: reservation.sendAttemptId,
    providerMessageId: `wamid.integration-${new Types.ObjectId().toString()}`,
  });
  assert.equal(replay.kind, "already_sent");
  assert.equal(
    await Message.countDocuments({ businessId: fixture.businessId, aiReplyJobId: fixture.jobId }).exec(),
    1,
  );
});

test("concurrent reservations for one approved draft allow only one active send", async () => {
  const fixture = await createDraftReadyFixture();
  const approval = await approveAiReplyDraft({
    businessId: fixture.businessId,
    userId: new Types.ObjectId(),
    jobId: fixture.jobId,
  });
  assert.equal(approval.kind, "approved");

  const results = await withMongoCommandBarrier(
    "competing AI send reservation conversation update",
    (query) => {
      const filter = query.getFilter();
      return query.op === "findOneAndUpdate" &&
        query.model?.modelName === "Conversation" &&
        filter._id?.toString() === fixture.conversationId.toString() &&
        filter.businessId?.toString() === fixture.businessId.toString();
    },
    () => Promise.allSettled([
      reserveAiReplyDraftForSending({ businessId: fixture.businessId, jobId: fixture.jobId }),
      reserveAiReplyDraftForSending({ businessId: fixture.businessId, jobId: fixture.jobId }),
    ]),
  );
  const reservationResults = assertConcurrentOperationsFulfilled("competing send reservations", results);
  assert.equal(reservationResults.filter((result) => result.kind === "reserved").length, 1);
  assert.equal(reservationResults.filter((result) => result.kind !== "reserved").length, 1);

  const [job, conversation, sendingJobs] = await Promise.all([
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ status: 1, sendAttemptId: 1 })
      .lean()
      .exec(),
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ activeAiSendJobId: 1 })
      .lean()
      .exec(),
    AiReplyJob.countDocuments({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      status: "sending",
    }).exec(),
  ]);
  assert.equal(job?.status, "sending");
  assert.ok(job?.sendAttemptId);
  assert.equal(conversation?.activeAiSendJobId?.toString(), fixture.jobId.toString());
  assert.equal(sendingJobs, 1);
})

test("real recovery expires only overdue reservations and clears each matching business conversation marker", async () => {
  const expiredFixture = await createDraftReadyFixture();
  const otherBusinessFixture = await createDraftReadyFixture();
  const mismatchedMarkerFixture = await createDraftReadyFixture();
  const liveFixture = await createDraftReadyFixture();
  const ownerId = new Types.ObjectId();

  for (const fixture of [expiredFixture, otherBusinessFixture, mismatchedMarkerFixture, liveFixture]) {
    assert.equal((await approveAiReplyDraft({
      businessId: fixture.businessId,
      userId: ownerId,
      jobId: fixture.jobId,
    })).kind, "approved");
  }

  const expiredReservation = await reserveAiReplyDraftForSending({
    businessId: expiredFixture.businessId,
    jobId: expiredFixture.jobId,
    leaseDurationMs: 120_000,
  });
  const otherBusinessReservation = await reserveAiReplyDraftForSending({
    businessId: otherBusinessFixture.businessId,
    jobId: otherBusinessFixture.jobId,
    leaseDurationMs: 120_000,
  });
  const mismatchedMarkerReservation = await reserveAiReplyDraftForSending({
    businessId: mismatchedMarkerFixture.businessId,
    jobId: mismatchedMarkerFixture.jobId,
    leaseDurationMs: 120_000,
  });
  const liveReservation = await reserveAiReplyDraftForSending({
    businessId: liveFixture.businessId,
    jobId: liveFixture.jobId,
    leaseDurationMs: 120_000,
  });
  assert.equal(expiredReservation.kind, "reserved");
  assert.equal(otherBusinessReservation.kind, "reserved");
  assert.equal(mismatchedMarkerReservation.kind, "reserved");
  assert.equal(liveReservation.kind, "reserved");

  const recoveryTime = new Date();
  const expiredAt = new Date(recoveryTime.getTime() - 1_000);
  for (const fixture of [expiredFixture, otherBusinessFixture, mismatchedMarkerFixture]) {
    await AiReplyJob.updateOne(
      { _id: fixture.jobId, businessId: fixture.businessId, status: "sending" },
      { $set: { sendLeaseExpiresAt: expiredAt } },
      { timestamps: false },
    ).exec();
  }

  const unrelatedActiveJobId = new Types.ObjectId();
  await Conversation.updateOne(
    { _id: mismatchedMarkerFixture.conversationId, businessId: mismatchedMarkerFixture.businessId },
    { $set: { activeAiSendJobId: unrelatedActiveJobId } },
    { timestamps: false },
  ).exec();

  assert.equal(await recoverExpiredAiReplySendReservations(recoveryTime, 100), 2);

  for (const fixture of [expiredFixture, otherBusinessFixture]) {
    const [job, conversation] = await Promise.all([
      AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
        .select({ status: 1, sendOutcome: 1, sendErrorCode: 1, sendLeaseExpiresAt: 1 })
        .lean()
        .exec(),
      Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
        .select({ activeAiSendJobId: 1 })
        .lean()
        .exec(),
    ]);
    assert.equal(job?.status, "send_uncertain");
    assert.equal(job?.sendOutcome, "uncertain");
    assert.equal(job?.sendErrorCode, "send_lease_expired");
    assert.equal(job?.sendLeaseExpiresAt, undefined);
    assert.equal(conversation?.activeAiSendJobId, undefined);
  }

  const [mismatchedJob, mismatchedConversation] = await Promise.all([
    AiReplyJob.findOne({ _id: mismatchedMarkerFixture.jobId, businessId: mismatchedMarkerFixture.businessId })
      .select({ status: 1, sendLeaseExpiresAt: 1 })
      .lean()
      .exec(),
    Conversation.findOne({ _id: mismatchedMarkerFixture.conversationId, businessId: mismatchedMarkerFixture.businessId })
      .select({ activeAiSendJobId: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(mismatchedJob?.status, "sending");
  assert.ok(mismatchedJob?.sendLeaseExpiresAt <= recoveryTime);
  assert.equal(mismatchedConversation?.activeAiSendJobId?.toString(), unrelatedActiveJobId.toString());

  const [liveJob, liveConversation] = await Promise.all([
    AiReplyJob.findOne({ _id: liveFixture.jobId, businessId: liveFixture.businessId })
      .select({ status: 1, sendLeaseExpiresAt: 1 })
      .lean()
      .exec(),
    Conversation.findOne({ _id: liveFixture.conversationId, businessId: liveFixture.businessId })
      .select({ activeAiSendJobId: 1 })
      .lean()
      .exec(),
  ]);
  assert.equal(liveJob?.status, "sending");
  assert.ok(liveJob?.sendLeaseExpiresAt > recoveryTime);
  assert.equal(liveConversation?.activeAiSendJobId?.toString(), liveFixture.jobId.toString());
})

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

test("eligible automatic inbound atomically creates one automatic job and duplicate delivery creates none", async () => {
  await assertRequiredUniqueIndex(AiReplyJob, "ai_reply_jobs_business_inbound_unique", { businessId: 1, inboundMessageId: 1 });
  const policyVersion = new Types.ObjectId().toString();
  const workspace = await createIngestionWorkspace({
    responseMode: "ai_automatic",
    automaticRepliesEnabled: true,
    policyVersion,
  });
  const payload = incomingTextPayload(workspace, `wamid.auto-enqueue-${new Types.ObjectId()}`);
  const options = { aiDraftWorkerEnabled: false, aiAutomaticSendEnabled: true };
  assert.deepEqual(await ingestWhatsAppPayload(payload, undefined, options), {
    kind: "accepted", inserted: 1, duplicates: 0,
  });
  assert.deepEqual(await ingestWhatsAppPayload(payload, undefined, options), {
    kind: "accepted", inserted: 0, duplicates: 1,
  });

  const [messages, conversation, jobs, business] = await Promise.all([
    Message.find({ businessId: workspace.businessId, direction: "inbound" }).select({ _id: 1 }).lean().exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId })
      .select({ aiControlVersion: 1, responseMode: 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ workflow: 1, status: 1, inboundMessageId: 1, automaticPolicyVersion: 1, workflowControlVersion: 1 }).lean().exec(),
    Business.findOne({ _id: workspace.businessId }).select({ "aiSettings.automaticRepliesControlVersion": 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 1);
  assert.equal(conversation.responseMode, "ai_automatic");
  assert.equal(conversation.aiControlVersion, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workflow, "ai_automatic");
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].automaticPolicyVersion, policyVersion);
  assert.equal(jobs[0].workflowControlVersion, 1);
  assert.equal(jobs[0].inboundMessageId.toString(), messages[0]._id.toString());
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 1);
});

test("concurrent duplicate automatic webhook deliveries persist one message, one job and one fence increment", async () => {
  const policyVersion = new Types.ObjectId().toString();
  const workspace = await createIngestionWorkspace({
    responseMode: "ai_automatic", automaticRepliesEnabled: true, policyVersion,
  });
  const payload = incomingTextPayload(workspace, `wamid.auto-concurrent-duplicate-${new Types.ObjectId()}`);
  const settled = await Promise.allSettled([
    ingestWhatsAppPayload(payload, undefined, { aiAutomaticSendEnabled: true }),
    ingestWhatsAppPayload(payload, undefined, { aiAutomaticSendEnabled: true }),
  ]);
  const results = assertConcurrentOperationsFulfilled("concurrent duplicate automatic ingestion", settled);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.duplicates, 0), 1);
  const [messages, conversation, jobs, business] = await Promise.all([
    Message.find({ businessId: workspace.businessId, direction: "inbound" }).select({ _id: 1 }).lean().exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId }).select({ aiControlVersion: 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ workflow: 1 }).lean().exec(),
    Business.findOne({ _id: workspace.businessId }).select({ "aiSettings.automaticRepliesControlVersion": 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 1);
  assert.equal(conversation.aiControlVersion, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workflow, "ai_automatic");
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 1);
});

test("concurrent distinct automatic inbound messages create two jobs and retain both fences", async () => {
  const policyVersion = new Types.ObjectId().toString();
  const workspace = await createIngestionWorkspace({
    responseMode: "ai_automatic", automaticRepliesEnabled: true, policyVersion,
  });
  const settled = await Promise.allSettled([
    ingestWhatsAppPayload(incomingTextPayload(workspace, `wamid.auto-distinct-a-${new Types.ObjectId()}`), undefined, { aiAutomaticSendEnabled: true }),
    ingestWhatsAppPayload(incomingTextPayload(workspace, `wamid.auto-distinct-b-${new Types.ObjectId()}`), undefined, { aiAutomaticSendEnabled: true }),
  ]);
  const results = assertConcurrentOperationsFulfilled("concurrent distinct automatic ingestion", settled);
  assert.deepEqual(results, [
    { kind: "accepted", inserted: 1, duplicates: 0 },
    { kind: "accepted", inserted: 1, duplicates: 0 },
  ]);
  const [messages, conversation, jobs, business] = await Promise.all([
    Message.find({ businessId: workspace.businessId, direction: "inbound" }).select({ _id: 1 }).lean().exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId }).select({ aiControlVersion: 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ workflow: 1, inboundMessageId: 1 }).lean().exec(),
    Business.findOne({ _id: workspace.businessId }).select({ "aiSettings.automaticRepliesControlVersion": 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 2);
  assert.equal(conversation.aiControlVersion, 2);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.workflow === "ai_automatic"));
  assert.equal(new Set(jobs.map((job) => job.inboundMessageId.toString())).size, 2);
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 2);
});

test("automatic inbound fails closed when the global gate or business opt-in is disabled", async (context) => {
  await context.test("global gate disabled", async () => {
    const policyVersion = new Types.ObjectId().toString();
    const workspace = await createIngestionWorkspace({ responseMode: "ai_automatic", automaticRepliesEnabled: true, policyVersion });
    const result = await ingestWhatsAppPayload(
      incomingTextPayload(workspace, `wamid.auto-gate-off-${new Types.ObjectId()}`),
      undefined,
      { aiAutomaticSendEnabled: false },
    );
    assert.equal(result.kind, "accepted");
    assert.equal(await AiReplyJob.countDocuments({ businessId: workspace.businessId }), 0);
    assert.equal(await Message.countDocuments({ businessId: workspace.businessId }), 1);
  });
  await context.test("business opt-in disabled", async () => {
    const policyVersion = new Types.ObjectId().toString();
    const workspace = await createIngestionWorkspace({ responseMode: "ai_automatic", automaticRepliesEnabled: false, policyVersion });
    const result = await ingestWhatsAppPayload(
      incomingTextPayload(workspace, `wamid.auto-optout-${new Types.ObjectId()}`),
      undefined,
      { aiAutomaticSendEnabled: true },
    );
    assert.equal(result.kind, "accepted");
    assert.equal(await AiReplyJob.countDocuments({ businessId: workspace.businessId }), 0);
    assert.equal(await Message.countDocuments({ businessId: workspace.businessId }), 1);
  });
});

test("automatic job insertion failure rolls back inbound message and both control fences", async () => {
  const policyVersion = new Types.ObjectId().toString();
  const workspace = await createIngestionWorkspace({
    responseMode: "ai_automatic", automaticRepliesEnabled: true, policyVersion,
  });
  const originalCreate = AiReplyJob.create;
  let insertionReached = false;
  AiReplyJob.create = async function (documents, options) {
    insertionReached = true;
    const error = new Error("Injected isolated test failure");
    throw error;
  };
  try {
    await assert.rejects(ingestWhatsAppPayload(
      incomingTextPayload(workspace, `wamid.auto-rollback-${new Types.ObjectId()}`),
      undefined,
      { aiAutomaticSendEnabled: true },
    ));
  } finally {
    AiReplyJob.create = originalCreate;
  }
  assert.equal(insertionReached, true);
  const [messages, conversation, business, jobs] = await Promise.all([
    Message.find({ businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId }).select({ aiControlVersion: 1 }).lean().exec(),
    Business.findOne({ _id: workspace.businessId }).select({ "aiSettings.automaticRepliesControlVersion": 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(messages.length, 0);
  assert.equal(conversation.aiControlVersion, 0);
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 0);
  assert.equal(jobs.length, 0);
});

test("automatic reply snapshot persistence is transactionally fenced by current mode, policy and inbound", async () => {
  const fixture = await createAutomaticReadyFixture();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  await AiReplyJob.updateOne({ _id: fixture.jobId, businessId: fixture.businessId }, {
    $set: { status: "processing", attemptCount: 1, leaseExpiresAt, lockedAt: new Date(), automaticSafetyDecision: "uncertain" },
    $unset: { automaticReplyTextSnapshot: 1 },
  }).exec();
  const result = await persistAutomaticAiReply({
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    jobId: fixture.jobId,
    inboundMessageId: fixture.inboundMessageId,
    attemptCount: 1,
    expectedPolicyVersion: fixture.policyVersion,
    expectedControlVersion: 0,
    safeReplyText: fixture.answer,
    evidence: [{ kind: "faq", recordId: fixture.faqId.toString() }],
    globalGateEnabled: true,
  });
  assert.equal(result.kind, "ready");
  const [conversation, job, business] = await Promise.all([
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId }).select({ responseMode: 1, aiControlVersion: 1 }).lean().exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId }).select({ status: 1, automaticReplyTextSnapshot: 1, automaticSafetyDecision: 1, automaticEvidence: 1, workflowControlVersion: 1 }).lean().exec(),
    Business.findOne({ _id: fixture.businessId }).select({ "aiSettings.automaticRepliesControlVersion": 1 }).lean().exec(),
  ]);
  assert.equal(conversation.responseMode, "ai_automatic");
  assert.equal(conversation.aiControlVersion, 1);
  assert.equal(job.status, "automatic_ready");
  assert.equal(job.automaticReplyTextSnapshot, fixture.answer);
  assert.equal(job.automaticSafetyDecision, "eligible");
  assert.equal(job.automaticEvidence.length, 1);
  assert.equal(job.workflowControlVersion, 1);
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 1);
});

test("automatic snapshot transaction rejects Human takeover and stale business policy", async (context) => {
  await context.test("Human takeover before persistence", async () => {
    const fixture = await createAutomaticReadyFixture();
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await AiReplyJob.updateOne({ _id: fixture.jobId, businessId: fixture.businessId }, {
      $set: { status: "processing", attemptCount: 1, leaseExpiresAt, lockedAt: new Date(), automaticSafetyDecision: "uncertain" },
      $unset: { automaticReplyTextSnapshot: 1 },
    }).exec();
    assert.deepEqual(await setConversationResponseMode(fixture.businessId, fixture.conversationId, "human"), {
      kind: "updated", responseMode: "human",
    });
    const result = await persistAutomaticAiReply({
      businessId: fixture.businessId, conversationId: fixture.conversationId,
      jobId: fixture.jobId, inboundMessageId: fixture.inboundMessageId,
      attemptCount: 1, expectedPolicyVersion: fixture.policyVersion,
      expectedControlVersion: 0, safeReplyText: fixture.answer,
      evidence: [{ kind: "faq", recordId: fixture.faqId.toString() }], globalGateEnabled: true,
    });
    assert.equal(result.kind, "mode_changed");
    const job = await AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ status: 1, automaticReplyTextSnapshot: 1 }).lean().exec();
    assert.equal(job.status, "processing");
    assert.equal(job.automaticReplyTextSnapshot, undefined);
  });

  await context.test("business policy change before persistence", async () => {
    const fixture = await createAutomaticReadyFixture();
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await AiReplyJob.updateOne({ _id: fixture.jobId, businessId: fixture.businessId }, {
      $set: { status: "processing", attemptCount: 1, leaseExpiresAt, lockedAt: new Date(), automaticSafetyDecision: "uncertain" },
      $unset: { automaticReplyTextSnapshot: 1 },
    }).exec();
    await Business.updateOne({ _id: fixture.businessId }, {
      $set: { "aiSettings.automaticRepliesPolicyVersion": new Types.ObjectId().toString() },
      $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
    }).exec();
    const result = await persistAutomaticAiReply({
      businessId: fixture.businessId, conversationId: fixture.conversationId,
      jobId: fixture.jobId, inboundMessageId: fixture.inboundMessageId,
      attemptCount: 1, expectedPolicyVersion: fixture.policyVersion,
      expectedControlVersion: 0, safeReplyText: fixture.answer,
      evidence: [{ kind: "faq", recordId: fixture.faqId.toString() }], globalGateEnabled: true,
    });
    assert.equal(result.kind, "policy_changed");
    const job = await AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ status: 1, automaticReplyTextSnapshot: 1 }).lean().exec();
    assert.equal(job.status, "processing");
    assert.equal(job.automaticReplyTextSnapshot, undefined);
  });
});

test("expired automatic_ready dispatch lease is released and safely reclaimable without regeneration", async () => {
  const fixture = await createAutomaticReadyFixture();
  const expiredAt = new Date(Date.now() - 1);
  await AiReplyJob.updateOne({ _id: fixture.jobId, businessId: fixture.businessId }, {
    $set: { lockedAt: expiredAt, leaseExpiresAt: expiredAt },
  }).exec();
  const recovered = await recoverExpiredAiReplyJobsForWorker(new Date());
  assert.ok(recovered >= 1);
  const claimed = await claimQueuedAiReplyJob(fixture.businessId, { now: new Date() });
  assert.equal(claimed?._id.toString(), fixture.jobId.toString());
  assert.equal(claimed?.status, "automatic_ready");
  assert.equal(claimed?.automaticReplyTextSnapshot, fixture.answer);
  assert.ok(claimed?.leaseExpiresAt > new Date());
  const finished = await finishAutomaticAiReplyJob({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    attemptCount: claimed.attemptCount,
    leaseExpiresAt: claimed.leaseExpiresAt,
    status: "cancelled",
    automaticSafetyDecision: "uncertain",
  });
  assert.equal(finished?.status, "cancelled");
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

test("Human takeover committed before automatic inbound fencing prevents automatic job creation", async () => {
  const policyVersion = new Types.ObjectId().toString();
  const workspace = await createIngestionWorkspace({
    responseMode: "ai_automatic", automaticRepliesEnabled: true, policyVersion,
  });
  let releaseIngestion;
  let reachedFence;
  const atFence = new Promise((resolve) => { reachedFence = resolve; });
  const ingestionMayContinue = new Promise((resolve) => { releaseIngestion = resolve; });
  const originalExec = mongoose.Query.prototype.exec;
  let intercepted = false;
  mongoose.Query.prototype.exec = async function (...args) {
    const isFenceWrite = this.model?.modelName === "Conversation" && this.op === "updateOne" &&
      this._conditions?._id?.toString() === workspace.conversationId.toString() &&
      this._conditions?.businessId?.toString() === workspace.businessId.toString();
    if (isFenceWrite && !intercepted) {
      intercepted = true;
      reachedFence();
      await ingestionMayContinue;
    }
    return originalExec.apply(this, args);
  };
  const ingestion = ingestWhatsAppPayload(
    incomingTextPayload(workspace, `wamid.auto-takeover-race-${new Types.ObjectId()}`),
    undefined,
    { aiAutomaticSendEnabled: true },
  );
  try {
    await atFence;
    assert.deepEqual(await setConversationResponseMode(workspace.businessId, workspace.conversationId, "human"), {
      kind: "updated", responseMode: "human",
    });
  } finally {
    mongoose.Query.prototype.exec = originalExec;
    releaseIngestion();
  }
  assert.deepEqual(await ingestion, { kind: "accepted", inserted: 1, duplicates: 0 });
  const [messages, conversation, jobs] = await Promise.all([
    Message.find({ businessId: workspace.businessId, direction: "inbound" }).select({ _id: 1 }).lean().exec(),
    Conversation.findOne({ _id: workspace.conversationId, businessId: workspace.businessId }).select({ responseMode: 1, aiControlVersion: 1 }).lean().exec(),
    AiReplyJob.find({ businessId: workspace.businessId }).select({ _id: 1 }).lean().exec(),
  ]);
  createdIds.jobs.push(...jobs.map((job) => job._id));
  assert.equal(intercepted, true);
  assert.equal(messages.length, 1);
  assert.equal(conversation.responseMode, "human");
  assert.equal(conversation.aiControlVersion, 2);
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
    const filter = query.getFilter();
    const update = query.getUpdate();
    const allowedModes = filter.responseMode?.$in;
    if (query.model?.modelName !== "Conversation" || query.op !== "findOneAndUpdate" ||
      filter._id?.toString() !== fixture.conversationId.toString() ||
      filter.businessId?.toString() !== fixture.businessId.toString() ||
      !Array.isArray(allowedModes) || !allowedModes.includes("ai")) return false;
    return filter.aiControlVersion !== undefined || update?.$set?.responseMode === "human";
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

test("automatic reservation revalidates current FAQ evidence and commits both shared fences before send", async () => {
  const fixture = await createAutomaticReadyFixture();
  await assertAutomaticFixtureState(fixture);
  const reservation = await reserveAiAutomaticReplyForSending({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    isAutomaticSendEnabled: automaticSendGateEnabled,
  });
  assertAutomaticReservationKind(reservation, "reserved", "eligible automatic reservation");
  assert.equal(reservation.automaticReplyText, fixture.answer);

  const [business, conversation, job] = await Promise.all([
    Business.findOne({ _id: fixture.businessId })
      .select({ "aiSettings.automaticRepliesControlVersion": 1 })
      .lean().exec(),
    Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
      .select({ responseMode: 1, aiControlVersion: 1, activeAiSendJobId: 1 })
      .lean().exec(),
    AiReplyJob.findOne({ _id: fixture.jobId, businessId: fixture.businessId })
      .select({ status: 1, workflow: 1, sendProvenance: 1, automaticReplyTextSnapshot: 1, approvedText: 1 })
      .lean().exec(),
  ]);
  assert.equal(business.aiSettings.automaticRepliesControlVersion, 1);
  assert.equal(conversation.responseMode, "ai_automatic");
  assert.equal(conversation.aiControlVersion, 1);
  assert.equal(conversation.activeAiSendJobId.toString(), fixture.jobId.toString());
  assert.equal(job.status, "sending");
  assert.equal(job.workflow, "ai_automatic");
  assert.equal(job.sendProvenance, "automatic_policy");
  assert.equal(job.automaticReplyTextSnapshot, fixture.answer);
  assert.equal(job.approvedText, undefined);

  const secondReservation = await reserveAiAutomaticReplyForSending({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    isAutomaticSendEnabled: automaticSendGateEnabled,
  });
  assert.equal(secondReservation.kind, "in_progress");

  const completion = await completeAiReplySend({
    businessId: fixture.businessId,
    jobId: fixture.jobId,
    sendAttemptId: reservation.sendAttemptId,
    providerMessageId: `wamid.auto-test-${new Types.ObjectId()}`,
  });
  assert.equal(completion.kind, "sent");
  assert.equal(completion.message.text, fixture.answer);
  assert.equal(completion.message.aiReplyJobId.toString(), fixture.jobId.toString());
});

test("competing automatic workers reserve one job at most once", async () => {
  const fixture = await createAutomaticReadyFixture();
  await assertAutomaticFixtureState(fixture);
  const settled = await withMongoCommandBarrier(
    "competing automatic reservation job reads",
    reservationJobReadMatcher(fixture.businessId, [fixture.jobId, fixture.jobId]),
    () => Promise.allSettled([
      reserveAiAutomaticReplyForSending({ businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: automaticSendGateEnabled }),
      reserveAiAutomaticReplyForSending({ businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: automaticSendGateEnabled }),
    ]),
  );
  const results = assertConcurrentOperationsFulfilled("competing automatic reservations", settled);
  assert.equal(results.filter((result) => result.kind === "reserved").length, 1, results.map(safeAutomaticReservationDiagnostic).join("; "));
  assert.equal(results.filter((result) => result.kind === "in_progress").length, 1, results.map(safeAutomaticReservationDiagnostic).join("; "));
  assert.equal(await AiReplyJob.countDocuments({
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    workflow: "ai_automatic",
    status: "sending",
  }).exec(), 1);
});

test("two eligible-looking automatic jobs for one conversation cannot both reserve", async () => {
  const fixture = await createAutomaticReadyFixture();
  const newerInboundMessageId = new Types.ObjectId();
  const newerJobId = new Types.ObjectId();
  const newerAt = new Date(Date.now() + 2_000);
  createdIds.messages.push(newerInboundMessageId);
  createdIds.jobs.push(newerJobId);
  await Message.create({
    _id: newerInboundMessageId,
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    customerId: fixture.customerId,
    direction: "inbound",
    messageType: "text",
    text: fixture.question,
    status: "received",
    timestamp: newerAt,
    createdAt: newerAt,
    updatedAt: newerAt,
  });
  await Conversation.updateOne(
    { _id: fixture.conversationId, businessId: fixture.businessId },
    { $inc: { aiControlVersion: 1 } },
  ).exec();
  await AiReplyJob.create({
    _id: newerJobId,
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    inboundMessageId: newerInboundMessageId,
    workflow: "ai_automatic",
    status: "automatic_ready",
    attemptCount: 0,
    nextAttemptAt: newerAt,
    automaticReplyTextSnapshot: fixture.answer,
    automaticSafetyDecision: "eligible",
    automaticPolicyVersion: fixture.policyVersion,
    workflowControlVersion: 1,
  });

  await assertAutomaticFixtureState(fixture, { controlVersion: 1, jobControlVersion: 0 });
  await assertAutomaticFixtureState(fixture, {
    jobId: newerJobId,
    controlVersion: 1,
    jobControlVersion: 1,
  });

  const settled = await withMongoCommandBarrier(
    "automatic jobs entering reservation eligibility checks",
    reservationJobReadMatcher(fixture.businessId, [fixture.jobId, newerJobId]),
    () => Promise.allSettled([
      reserveAiAutomaticReplyForSending({ businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: automaticSendGateEnabled }),
      reserveAiAutomaticReplyForSending({ businessId: fixture.businessId, jobId: newerJobId, isAutomaticSendEnabled: automaticSendGateEnabled }),
    ]),
  );
  const results = assertConcurrentOperationsFulfilled("same-conversation automatic jobs", settled);
  assert.equal(results.filter((result) => result.kind === "reserved").length, 1, results.map(safeAutomaticReservationDiagnostic).join("; "));
  assert.equal(results.filter((result) => result.kind === "safety_rejected").length, 1, results.map(safeAutomaticReservationDiagnostic).join("; "));
  assert.equal(await AiReplyJob.countDocuments({
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    workflow: "ai_automatic",
    status: "sending",
  }).exec(), 1);
});

test("opt-out or changed FAQ policy before automatic reservation prevents sending", async (context) => {
  await context.test("business opt-out", async () => {
    const fixture = await createAutomaticReadyFixture();
    await Business.updateOne(
      { _id: fixture.businessId },
      {
        $set: {
          "aiSettings.automaticRepliesEnabled": false,
          "aiSettings.automaticRepliesPolicyVersion": new Types.ObjectId().toString(),
        },
        $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
      },
    ).exec();
    const result = await reserveAiAutomaticReplyForSending({
      businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: () => true,
    });
    assertAutomaticSafetyReason(result, "automatic_replies_disabled", "business opt-out should block reservation");
  });

  await context.test("FAQ change rotates policy version", async () => {
    const fixture = await createAutomaticReadyFixture();
    await Faq.updateOne({ _id: fixture.faqId, businessId: fixture.businessId }, {
      $set: { answer: "Returns are accepted within 30 days." },
    }).exec();
    await Business.updateOne({ _id: fixture.businessId }, {
      $set: { "aiSettings.automaticRepliesPolicyVersion": new Types.ObjectId().toString() },
      $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
    }).exec();
    const result = await reserveAiAutomaticReplyForSending({
      businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: () => true,
    });
    assertAutomaticSafetyReason(result, "stale_policy_version", "changed FAQ policy should block reservation");
  });

  await context.test("wrong business cannot reserve another business job", async () => {
    const fixture = await createAutomaticReadyFixture();
    const result = await reserveAiAutomaticReplyForSending({
      businessId: new Types.ObjectId(), jobId: fixture.jobId, isAutomaticSendEnabled: () => true,
    });
    assert.equal(result.kind, "not_found");
  });

  await context.test("Human mode before reservation is escalated and not reserved", async () => {
    const fixture = await createAutomaticReadyFixture();
    await Conversation.updateOne(
      { _id: fixture.conversationId, businessId: fixture.businessId },
      { $set: { responseMode: "human" }, $inc: { aiControlVersion: 1 } },
    ).exec();
    const result = await reserveAiAutomaticReplyForSending({
      businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: () => true,
    });
    assertAutomaticSafetyReason(result, "conversation_mode_mismatch", "Human mode should block reservation");
  });
});

test("business opt-out racing automatic reservation has one transactionally ordered result", async () => {
  const fixture = await createAutomaticReadyFixture();
  await assertAutomaticFixtureState(fixture);
  const settled = await withMongoCommandBarrier(
    "automatic reservation and business opt-out entering operations",
    (query) => {
      const filter = query.getFilter();
      const reservationRead = reservationJobReadMatcher(fixture.businessId, [fixture.jobId])(query);
      const optOutWrite = query.op === "findOneAndUpdate" && query.model?.modelName === "Business" &&
        filter._id?.toString() === fixture.businessId.toString();
      return reservationRead || optOutWrite;
    },
    () => Promise.allSettled([
      reserveAiAutomaticReplyForSending({
        businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: automaticSendGateEnabled,
      }),
      Business.findOneAndUpdate(
        { _id: fixture.businessId },
        {
          $set: {
            "aiSettings.automaticRepliesEnabled": false,
            "aiSettings.automaticRepliesPolicyVersion": new Types.ObjectId().toString(),
          },
          $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
        },
        { returnDocument: "after" },
      ).exec(),
    ]),
  );
  const results = assertConcurrentOperationsFulfilled("automatic reservation versus business opt-out", settled);
  const reservation = results.find((result) => result && typeof result.kind === "string");
  const settingsUpdate = results.find((result) => result && typeof result.kind !== "string");
  assert.ok(settingsUpdate);
  assert.equal(settingsUpdate.aiSettings.automaticRepliesEnabled, false);
  assert.ok(["reserved", "safety_rejected"].includes(reservation?.kind), safeAutomaticReservationDiagnostic(reservation));
  if (reservation?.kind === "safety_rejected") {
    assert.equal(reservation.validation.reasonCode, "automatic_replies_disabled", safeAutomaticReservationDiagnostic(reservation));
  }
});

test("Human takeover racing automatic reservation never sends and leaves one safe winner", async () => {
  const fixture = await createAutomaticReadyFixture();
  await assertAutomaticFixtureState(fixture);
  const settled = await withMongoCommandBarrier(
    "automatic reservation and takeover entering operations",
    (query) => {
      const filter = query.getFilter();
      const reservationRead = reservationJobReadMatcher(fixture.businessId, [fixture.jobId])(query);
      const takeoverWrite = query.op === "findOneAndUpdate" && query.model?.modelName === "Conversation" &&
        filter._id?.toString() === fixture.conversationId.toString() &&
        filter.businessId?.toString() === fixture.businessId.toString();
      return reservationRead || takeoverWrite;
    },
    () => Promise.allSettled([
      reserveAiAutomaticReplyForSending({ businessId: fixture.businessId, jobId: fixture.jobId, isAutomaticSendEnabled: automaticSendGateEnabled }),
      setConversationResponseMode(fixture.businessId, fixture.conversationId, "human"),
    ]),
  );
  const [reservation, takeover] = assertConcurrentOperationsFulfilled("automatic reservation versus Human takeover", settled);
  const conversation = await Conversation.findOne({ _id: fixture.conversationId, businessId: fixture.businessId })
    .select({ responseMode: 1, activeAiSendJobId: 1 }).lean().exec();
  if (conversation.responseMode === "human") {
    assert.equal(takeover.kind, "updated");
    assert.notEqual(reservation.kind, "reserved", safeAutomaticReservationDiagnostic(reservation));
    assert.equal(conversation.activeAiSendJobId, undefined);
  } else {
    assert.equal(conversation.responseMode, "ai_automatic");
    assertAutomaticReservationKind(reservation, "reserved", "automatic reservation should win before takeover");
    assert.equal(takeover.kind, "send_in_progress");
    assert.equal(conversation.activeAiSendJobId.toString(), fixture.jobId.toString());
  }
});
