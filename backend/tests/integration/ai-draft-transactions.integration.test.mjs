import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { AiReplyJob } from "../../dist/models/ai-reply-job.model.js";
import { Conversation } from "../../dist/models/conversation.model.js";
import { Message } from "../../dist/models/message.model.js";
import {
  cancelProcessingAiReplyJob,
  claimQueuedAiReplyJob,
  saveAiReplyDraft,
  takeOverConversation,
} from "../../dist/services/ai-reply-job.repository.js";

const TEST_DATABASE_NAME = "whatsapp_sales_assistant_test";
const createdIds = {
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
    conversationId,
    jobId,
    attemptCount: claimedJob.attemptCount,
  };
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

  assert.equal(await takeOverConversation(fixture.businessId, fixture.conversationId), true);
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
  assert.equal(await takeOverConversation(fixture.businessId, fixture.conversationId), true);

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
