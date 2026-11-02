import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import mongoose, { Types } from "mongoose";

const TEST_DATABASE_NAME = "whatsapp_sales_assistant_test";
const SAFE_DIAGNOSTIC_CATEGORIES = new Set([
  "rate_limited",
  "authentication_failed",
  "permission_denied",
  "timeout",
  "network_error",
  "provider_5xx",
  "provider_error",
]);
const SAFE_DIAGNOSTIC_HTTP_STATUSES = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(scriptDirectory, "../.env"), quiet: true });

class ManualTestError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function verifiedTestUri(value) {
  if (!value) throw new ManualTestError("missing_test_database_uri");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManualTestError("invalid_test_database_uri");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new ManualTestError("invalid_test_database_name");
  }

  if (!(["mongodb:", "mongodb+srv:"].includes(parsed.protocol)) ||
    !parsed.hostname || databaseName !== TEST_DATABASE_NAME || parsed.hash) {
    throw new ManualTestError("test_database_must_be_whatsapp_sales_assistant_test");
  }

  return value;
}

function configuredGemini() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new ManualTestError("missing_gemini_api_key");

  const model = process.env.GEMINI_TEST_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-3.8-flash";
  if (model.length > 128 || !/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new ManualTestError("invalid_gemini_model_configuration");
  }
  return { apiKey, model };
}

function printResult({ outcome, generationDurationMs, geminiDiagnostic }) {
  const safeCategory = SAFE_DIAGNOSTIC_CATEGORIES.has(geminiDiagnostic?.category)
    ? geminiDiagnostic.category
    : "none";
  const safeHttpStatus = Number.isInteger(geminiDiagnostic?.httpStatus) &&
      SAFE_DIAGNOSTIC_HTTP_STATUSES.has(geminiDiagnostic.httpStatus)
    ? geminiDiagnostic.httpStatus
    : "none";
  const retryable = outcome?.kind === "retry_scheduled"
    ? true
    : outcome?.kind === "failed"
      ? false
      : "not_applicable";
  console.log("Controlled Gemini draft test result:");
  console.log(`  outcome: ${outcome?.kind ?? "unavailable"}`);
  console.log(`  geminiDiagnosticCategory: ${safeCategory}`);
  console.log(`  geminiDiagnosticHttpStatus: ${safeHttpStatus}`);
  console.log(`  retryable: ${retryable}`);
  console.log(`  generationDurationMs: ${Number.isFinite(generationDurationMs) ? Math.round(generationDurationMs) : "unavailable"}`);
}

async function run() {
  const testUri = verifiedTestUri(process.env.MONGODB_TEST_URI);
  const { apiKey, model } = configuredGemini();
  const runId = randomUUID();
  const ids = {
    userId: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    customerId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    messageId: new Types.ObjectId(),
    jobId: new Types.ObjectId(),
  };
  let connected = false;
  let cleanupFailed = false;
  let testPassed = false;

  let User;
  let Business;
  let Customer;
  let Conversation;
  let Message;
  let AiReplyJob;
  let createAiDraftProcessor;
  let GeminiServiceError;
  let createGeminiService;
  let claimQueuedAiReplyJob;
  let cancelProcessingAiReplyJob;
  let findAiReplyConversationMode;
  let markAiReplyJobFailed;
  let recoverExpiredAiReplyJobs;
  let retryAiReplyJob;
  let saveAiReplyDraft;

  try {
    await mongoose.connect(testUri, {
      dbName: TEST_DATABASE_NAME,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    connected = true;
    if (mongoose.connection.name !== TEST_DATABASE_NAME) {
      throw new ManualTestError("connected_database_name_mismatch");
    }

    [
      { User },
      { Business },
      { Customer },
      { Conversation },
      { Message },
      { AiReplyJob },
    ] = await Promise.all([
      import("../dist/models/user.model.js"),
      import("../dist/models/business.model.js"),
      import("../dist/models/customer.model.js"),
      import("../dist/models/conversation.model.js"),
      import("../dist/models/message.model.js"),
      import("../dist/models/ai-reply-job.model.js"),
    ]);
    ({ createAiDraftProcessor } = await import("../dist/services/ai-draft-processor.service.js"));
    ({ createGeminiService, GeminiServiceError } = await import("../dist/services/gemini.service.js"));
    ({
      claimQueuedAiReplyJob,
      cancelProcessingAiReplyJob,
      findAiReplyConversationMode,
      markAiReplyJobFailed,
      recoverExpiredAiReplyJobs,
      retryAiReplyJob,
      saveAiReplyDraft,
    } = await import("../dist/services/ai-reply-job.repository.js"));

    const existingJobs = await AiReplyJob.countDocuments({ businessId: ids.businessId }).exec();
    if (existingJobs !== 0) throw new ManualTestError("synthetic_business_already_has_jobs");

    const ownerPasswordHash = await bcrypt.hash(randomUUID(), 10);
    await User.create({
      _id: ids.userId,
      name: "Synthetic Gemini test owner",
      email: `gemini-manual-${runId}@example.invalid`,
      passwordHash: ownerPasswordHash,
      businessId: ids.businessId,
      role: "owner",
    });
    await Business.create({
      _id: ids.businessId,
      ownerUserId: ids.userId,
      name: "Synthetic Notebook Shop",
      description: "A test shop that sells handmade notebooks. Specific prices, stock, delivery times, and return policies have not been provided.",
    });
    await Customer.create({
      _id: ids.customerId,
      businessId: ids.businessId,
      phoneNumber: "919000000001",
      profileName: "Synthetic Test Customer",
    });
    await Conversation.create({
      _id: ids.conversationId,
      businessId: ids.businessId,
      customerId: ids.customerId,
      status: "open",
      responseMode: "ai",
      aiControlVersion: 0,
    });
    const createdMessage = await Message.create({
      _id: ids.messageId,
      businessId: ids.businessId,
      conversationId: ids.conversationId,
      customerId: ids.customerId,
      direction: "inbound",
      messageType: "text",
      text: "Do you have handmade notebooks? What is the price?",
      providerMessageId: `manual-gemini-${runId}`,
      status: "received",
      timestamp: new Date(),
    });
    await Conversation.updateOne(
      { _id: ids.conversationId, businessId: ids.businessId },
      { $set: { lastMessageAt: createdMessage.timestamp, lastMessagePreview: createdMessage.text } },
      { runValidators: true },
    ).exec();
    await AiReplyJob.create({
      _id: ids.jobId,
      businessId: ids.businessId,
      conversationId: ids.conversationId,
      inboundMessageId: ids.messageId,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    const queuedJobCount = await AiReplyJob.countDocuments({
      businessId: ids.businessId,
      status: "queued",
    }).exec();
    if (queuedJobCount !== 1) throw new ManualTestError("synthetic_job_isolation_check_failed");

    const realGemini = createGeminiService({ apiKey, model });
    let generationCalls = 0;
    let generationDurationMs;
    let geminiDiagnostic;
    const generator = {
      async generateText(request) {
        generationCalls += 1;
        const startedAt = performance.now();
        try {
          return await realGemini.generateText(request);
        } catch (error) {
          if (error instanceof GeminiServiceError && error.diagnostic) {
            geminiDiagnostic = error.diagnostic;
          }
          throw error;
        } finally {
          generationDurationMs = performance.now() - startedAt;
        }
      },
    };
    const repository = {
      recoverExpired: (now) => recoverExpiredAiReplyJobs(ids.businessId, now),
      claimNext: (now) => claimQueuedAiReplyJob(ids.businessId, { now }),
      findConversationMode: findAiReplyConversationMode,
      cancelCurrentAttempt: cancelProcessingAiReplyJob,
      scheduleRetry: retryAiReplyJob,
      markFailed: markAiReplyJobFailed,
      saveDraft: saveAiReplyDraft,
    };
    const processor = createAiDraftProcessor({ generator, repository });
    const outcome = await processor.processNext();

    const [job, conversation, outboundMessageCount] = await Promise.all([
      AiReplyJob.findOne({ _id: ids.jobId, businessId: ids.businessId })
        .select({ _id: 1, status: 1, generatedDraft: 1, errorCode: 1 })
        .lean()
        .exec(),
      Conversation.findOne({ _id: ids.conversationId, businessId: ids.businessId })
        .select({ _id: 1, responseMode: 1 })
        .lean()
        .exec(),
      Message.countDocuments({ businessId: ids.businessId, direction: "outbound" }).exec(),
    ]);
    printResult({ outcome, generationDurationMs, geminiDiagnostic });

    if (outcome.kind === "draft_ready" && job?.status === "draft_ready" &&
      typeof job.generatedDraft === "string" && job.generatedDraft.trim().length > 0 &&
      job.generatedDraft.length <= 4_096 && conversation?.responseMode === "ai" &&
      outboundMessageCount === 0 && generationCalls === 1) {
      testPassed = true;
    }
  } catch (error) {
    const category = error instanceof ManualTestError ? error.category : "manual_gemini_test_failed";
    console.error(`Controlled Gemini draft test did not complete: ${category}.`);
  } finally {
    if (connected) {
      const cleanup = [
        () => AiReplyJob?.deleteOne({ _id: ids.jobId, businessId: ids.businessId }).exec(),
        () => Message?.deleteOne({ _id: ids.messageId, businessId: ids.businessId }).exec(),
        () => Conversation?.deleteOne({ _id: ids.conversationId, businessId: ids.businessId }).exec(),
        () => Customer?.deleteOne({ _id: ids.customerId, businessId: ids.businessId }).exec(),
        () => User?.deleteOne({ _id: ids.userId, businessId: ids.businessId }).exec(),
        () => Business?.deleteOne({ _id: ids.businessId }).exec(),
      ];
      for (const removeFixtureRecord of cleanup) {
        try {
          await removeFixtureRecord();
        } catch {
          cleanupFailed = true;
        }
      }
    }
    try {
      await mongoose.disconnect();
    } catch {
      cleanupFailed = true;
    }
  }

  if (cleanupFailed) {
    console.error("Controlled Gemini draft test cleanup failed for one or more synthetic fixture records.");
    process.exitCode = 1;
  } else if (!testPassed) {
    process.exitCode = 1;
  } else {
    console.log("Controlled Gemini draft test passed; synthetic fixture cleanup completed.");
  }
}

void run();
