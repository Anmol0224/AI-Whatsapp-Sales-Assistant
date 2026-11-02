import { Types } from "mongoose";
import { performance } from "node:perf_hooks";
import { logAiPipelineTiming, type AiPipelineProviderCategory } from "./ai-pipeline-telemetry.js";
import {
  AI_REPLY_JOB_MAX_ATTEMPTS,
  cancelProcessingAiReplyJob,
  claimNextQueuedAiReplyJob,
  findAiReplyConversationMode,
  markAiReplyJobFailed,
  recoverExpiredAiReplyJobsForWorker,
  retryAiReplyJob,
  saveAiReplyDraft,
  type AiReplyDraftPersistenceResult,
} from "./ai-reply-job.repository.js";
import {
  GeminiServiceError,
  type GeminiTextGenerationResult,
} from "./gemini.service.js";
import {
  businessContextService,
  type BusinessContextResult,
} from "./business-context.service.js";
import {
  buildBusinessReplyPrompt,
  type BusinessPromptBuildResult,
} from "./business-prompt-builder.service.js";

export const AI_DRAFT_RETRY_BASE_DELAY_MS = 1_000;
export const AI_DRAFT_RETRY_MAX_DELAY_MS = 30_000;
const MAX_DRAFT_CHARACTERS = 4_096;

export interface ClaimedAiReplyJob {
  _id: Types.ObjectId | string;
  businessId: Types.ObjectId | string;
  conversationId: Types.ObjectId | string;
  inboundMessageId: Types.ObjectId | string;
  attemptCount: number;
  createdAt?: Date;
  nextAttemptAt?: Date;
}

export type AiDraftWorkerOutcome =
  | { kind: "idle" }
  | { kind: "draft_ready" }
  | { kind: "cancelled" }
  | { kind: "failed"; errorCode: string }
  | { kind: "retry_scheduled"; nextAttemptAt: Date }
  | { kind: "stale" }
  | { kind: "deferred" };

export interface AiDraftWorkerRepository {
  recoverExpired(now: Date, maxAttempts: number): Promise<number>;
  claimNext(now: Date): Promise<ClaimedAiReplyJob | null>;
  findConversationMode(
    businessId: Types.ObjectId,
    conversationId: Types.ObjectId,
  ): Promise<"human" | "ai" | null>;
  cancelCurrentAttempt(
    businessId: Types.ObjectId,
    jobId: Types.ObjectId,
    attemptCount: number,
    now: Date,
  ): Promise<unknown | null>;
  scheduleRetry(
    businessId: Types.ObjectId,
    jobId: Types.ObjectId,
    attemptCount: number,
    nextAttemptAt: Date,
    errorCode: "context_unavailable" | "provider_unavailable" | "provider_timeout" | "database_unavailable" | "invalid_output" | "internal_error",
    now: Date,
  ): Promise<unknown | null>;
  markFailed(
    businessId: Types.ObjectId,
    jobId: Types.ObjectId,
    attemptCount: number,
    errorCode: "context_unavailable" | "provider_unavailable" | "provider_timeout" | "database_unavailable" | "invalid_output" | "internal_error",
    now: Date,
  ): Promise<unknown | null>;
  saveDraft(
    businessId: Types.ObjectId,
    conversationId: Types.ObjectId,
    jobId: Types.ObjectId,
    attemptCount: number,
    draft: string,
  ): Promise<AiReplyDraftPersistenceResult>;
}

export interface AiDraftContextService {
  retrieve(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    inboundMessageId: Types.ObjectId;
  }): Promise<BusinessContextResult>;
}

export interface AiDraftPromptBuilder {
  (result: Extract<BusinessContextResult, { status: "ready" }>): BusinessPromptBuildResult;
}

export interface AiDraftGenerator {
  generateText(request: { prompt: string }): Promise<GeminiTextGenerationResult>;
}

export interface AiDraftProcessorOptions {
  repository?: AiDraftWorkerRepository;
  contextService?: AiDraftContextService;
  promptBuilder?: AiDraftPromptBuilder;
  generator: AiDraftGenerator;
  now?: () => Date;
}

const mongooseRepository: AiDraftWorkerRepository = {
  recoverExpired: recoverExpiredAiReplyJobsForWorker,
  claimNext: (now) => claimNextQueuedAiReplyJob({ now }),
  findConversationMode: findAiReplyConversationMode,
  cancelCurrentAttempt: cancelProcessingAiReplyJob,
  scheduleRetry: retryAiReplyJob,
  markFailed: markAiReplyJobFailed,
  saveDraft: saveAiReplyDraft,
};

function toObjectId(value: Types.ObjectId | string): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  return typeof value === "string" && Types.ObjectId.isValid(value)
    ? new Types.ObjectId(value)
    : null;
}

function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (/Mongo(Network|ServerSelection|NetworkTimeout|Timeout)|MongooseServerSelection/i.test(name)) {
    return true;
  }

  const code = "code" in error ? error.code : undefined;
  const codeName = "codeName" in error && typeof error.codeName === "string" ? error.codeName : "";
  if (code === 112 || codeName === "WriteConflict") return true;
  if (typeof code === "string" && [
    "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  ].includes(code)) return true;

  if ("hasErrorLabel" in error && typeof error.hasErrorLabel === "function") {
    try {
      return error.hasErrorLabel("RetryableWriteError") ||
        error.hasErrorLabel("TransientTransactionError") ||
        error.hasErrorLabel("UnknownTransactionCommitResult");
    } catch {
      return false;
    }
  }
  return false;
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(AI_DRAFT_RETRY_BASE_DELAY_MS * (2 ** exponent), AI_DRAFT_RETRY_MAX_DELAY_MS);
}

function validateDraft(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_DRAFT_CHARACTERS) return null;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return null;
  return text;
}

function categorizeGeminiFailure(error: unknown): {
  retryable: boolean;
  errorCode: "provider_unavailable" | "provider_timeout" | "invalid_output" | "internal_error";
  providerCategory?: AiPipelineProviderCategory;
  providerHttpStatus?: number;
  providerNetworkCode?: string;
} {
  if (!(error instanceof GeminiServiceError)) {
    return isTransientDatabaseError(error)
      ? { retryable: true, errorCode: "provider_unavailable" }
      : { retryable: false, errorCode: "internal_error" };
  }

  const diagnosticFields = {
    providerCategory: error.diagnostic?.category ?? error.category,
    ...(error.diagnostic?.httpStatus === undefined ? {} : { providerHttpStatus: error.diagnostic.httpStatus }),
    ...(error.diagnostic?.networkCode === undefined ? {} : { providerNetworkCode: error.diagnostic.networkCode }),
  };

  switch (error.category) {
    case "timeout":
      return { retryable: true, errorCode: "provider_timeout", ...diagnosticFields };
    case "rate_limited":
    case "provider_error":
      return { retryable: true, errorCode: "provider_unavailable", ...diagnosticFields };
    case "empty_response":
    case "invalid_response":
    case "output_too_large":
      return { retryable: false, errorCode: "invalid_output", ...diagnosticFields };
    case "missing_credentials":
    case "authentication_failed":
    case "permission_denied":
      return { retryable: false, errorCode: "provider_unavailable", ...diagnosticFields };
    case "invalid_request":
    case "input_too_large":
      return { retryable: false, errorCode: "internal_error", ...diagnosticFields };
  }
}

export function createAiDraftProcessor(options: AiDraftProcessorOptions) {
  const repository = options.repository ?? mongooseRepository;
  const contextService = options.contextService ?? businessContextService;
  const promptBuilder = options.promptBuilder ?? buildBusinessReplyPrompt;
  const now = options.now ?? (() => new Date());

  async function failOrRetry(
    job: ClaimedAiReplyJob,
    businessId: Types.ObjectId,
    jobId: Types.ObjectId,
    errorCode: "context_unavailable" | "provider_unavailable" | "provider_timeout" | "database_unavailable" | "invalid_output" | "internal_error",
    retryable: boolean,
  ): Promise<AiDraftWorkerOutcome> {
    const timestamp = now();
    if (retryable && job.attemptCount < AI_REPLY_JOB_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(timestamp.getTime() + retryDelayMs(job.attemptCount));
      const updated = await repository.scheduleRetry(
        businessId, jobId, job.attemptCount, nextAttemptAt, errorCode, timestamp,
      );
      return updated ? { kind: "retry_scheduled", nextAttemptAt } : { kind: "stale" };
    }

    const updated = await repository.markFailed(
      businessId, jobId, job.attemptCount, errorCode, timestamp,
    );
    return updated ? { kind: "failed", errorCode } : { kind: "stale" };
  }

  async function cancel(job: ClaimedAiReplyJob, businessId: Types.ObjectId, jobId: Types.ObjectId) {
    const updated = await repository.cancelCurrentAttempt(
      businessId, jobId, job.attemptCount, now(),
    );
    return updated ? { kind: "cancelled" as const } : { kind: "stale" as const };
  }

  async function readConversationMode(
    job: ClaimedAiReplyJob,
    businessId: Types.ObjectId,
    jobId: Types.ObjectId,
    conversationId: Types.ObjectId,
  ): Promise<{ mode: "human" | "ai" | null } | { outcome: AiDraftWorkerOutcome }> {
    try {
      return { mode: await repository.findConversationMode(businessId, conversationId) };
    } catch (error) {
      const transient = isTransientDatabaseError(error);
      return {
        outcome: await failOrRetry(
          job, businessId, jobId,
          transient ? "database_unavailable" : "internal_error",
          transient,
        ),
      };
    }
  }

  async function processClaimed(job: ClaimedAiReplyJob): Promise<AiDraftWorkerOutcome> {
    const processingStartedAt = performance.now();
    let outcome: AiDraftWorkerOutcome["kind"] | "error" = "error";
    try {
      const result = await processClaimedJob(job);
      outcome = result.kind;
      return result;
    } finally {
      logAiPipelineTiming({
        event: "ai_pipeline.job_processing",
        stage: "job_processing",
        durationMs: performance.now() - processingStartedAt,
        outcome,
        jobId: String(job._id),
        attemptNumber: job.attemptCount,
      });
    }
  }

  async function processClaimedJob(job: ClaimedAiReplyJob): Promise<AiDraftWorkerOutcome> {
    const businessId = toObjectId(job.businessId);
    const jobId = toObjectId(job._id);
    const conversationId = toObjectId(job.conversationId);
    const inboundMessageId = toObjectId(job.inboundMessageId);
    if (!businessId || !jobId || !conversationId || !inboundMessageId ||
      !Number.isSafeInteger(job.attemptCount) || job.attemptCount < 1) {
      if (!businessId || !jobId || !Number.isSafeInteger(job.attemptCount) || job.attemptCount < 1) {
        // The claimed record cannot be safely fenced; lease recovery will terminate or requeue it.
        return { kind: "deferred" };
      }
      return failOrRetry(job, businessId, jobId, "context_unavailable", false);
    }

    const firstMode = await readConversationMode(job, businessId, jobId, conversationId);
    if ("outcome" in firstMode) return firstMode.outcome;
    if (firstMode.mode !== "ai") return cancel(job, businessId, jobId);

    let contextResult: BusinessContextResult;
    const contextStartedAt = performance.now();
    try {
      contextResult = await contextService.retrieve({ businessId, conversationId, inboundMessageId });
    } catch (error) {
      const transient = isTransientDatabaseError(error);
      logAiPipelineTiming({
        event: "ai_pipeline.context_retrieval",
        stage: "business_context",
        durationMs: performance.now() - contextStartedAt,
        outcome: transient ? "database_unavailable" : "internal_error",
        jobId: jobId.toString(),
        attemptNumber: job.attemptCount,
      });
      return failOrRetry(
        job, businessId, jobId,
        transient ? "database_unavailable" : "internal_error",
        transient,
      );
    }

    logAiPipelineTiming({
      event: "ai_pipeline.context_retrieval",
      stage: "business_context",
      durationMs: performance.now() - contextStartedAt,
      outcome: contextResult.status,
      jobId: jobId.toString(),
      attemptNumber: job.attemptCount,
    });

    if (contextResult.status !== "ready") {
      const transient = contextResult.reason === "context_unavailable";
      return failOrRetry(
        job, businessId, jobId,
        transient ? "database_unavailable" : "context_unavailable",
        transient,
      );
    }

    let promptResult: BusinessPromptBuildResult;
    try {
      promptResult = promptBuilder(contextResult);
    } catch {
      return failOrRetry(job, businessId, jobId, "internal_error", false);
    }
    if (promptResult.status !== "ready") {
      return failOrRetry(job, businessId, jobId, "context_unavailable", false);
    }

    // Avoid starting a provider request if human takeover occurred during context retrieval.
    const generationMode = await readConversationMode(job, businessId, jobId, conversationId);
    if ("outcome" in generationMode) return generationMode.outcome;
    if (generationMode.mode !== "ai") return cancel(job, businessId, jobId);

    let generatedText: unknown;
    const generationStartedAt = performance.now();
    try {
      generatedText = (await options.generator.generateText(promptResult.request)).text;
    } catch (error) {
      const failure = categorizeGeminiFailure(error);
      logAiPipelineTiming({
        event: "ai_pipeline.gemini_request",
        stage: "gemini_generation",
        durationMs: performance.now() - generationStartedAt,
        outcome: failure.errorCode,
        providerCategory: failure.providerCategory,
        providerHttpStatus: failure.providerHttpStatus,
        providerNetworkCode: failure.providerNetworkCode,
        retryable: failure.retryable,
        jobId: jobId.toString(),
        attemptNumber: job.attemptCount,
      });
      return failOrRetry(job, businessId, jobId, failure.errorCode, failure.retryable);
    }

    logAiPipelineTiming({
      event: "ai_pipeline.gemini_request",
      stage: "gemini_generation",
      durationMs: performance.now() - generationStartedAt,
      outcome: "success",
      jobId: jobId.toString(),
      attemptNumber: job.attemptCount,
    });

    const draft = validateDraft(generatedText);
    if (!draft) return failOrRetry(job, businessId, jobId, "invalid_output", false);

    // The transactional repository check is the final response-mode check and shares a Conversation write fence with takeover.
    const persistenceStartedAt = performance.now();
    try {
      const saved = await repository.saveDraft(
        businessId, conversationId, jobId, job.attemptCount, draft,
      );
      logAiPipelineTiming({
        event: "ai_pipeline.draft_persistence",
        stage: "draft_persistence",
        durationMs: performance.now() - persistenceStartedAt,
        outcome: saved.kind,
        jobId: jobId.toString(),
        attemptNumber: job.attemptCount,
      });
      if (saved.kind === "saved") return { kind: "draft_ready" };
      if (saved.kind === "mode_changed") return cancel(job, businessId, jobId);
      return { kind: "stale" };
    } catch (error) {
      const transient = isTransientDatabaseError(error);
      logAiPipelineTiming({
        event: "ai_pipeline.draft_persistence",
        stage: "draft_persistence",
        durationMs: performance.now() - persistenceStartedAt,
        outcome: transient ? "database_unavailable" : "internal_error",
        jobId: jobId.toString(),
        attemptNumber: job.attemptCount,
      });
      if (transient) {
        // If the write committed despite a lost acknowledgement, the status fence prevents a second draft.
        return failOrRetry(job, businessId, jobId, "database_unavailable", true);
      }
      return failOrRetry(job, businessId, jobId, "internal_error", false);
    }
  }

  async function processNext(): Promise<AiDraftWorkerOutcome> {
    const timestamp = now();
    const cycleStartedAt = performance.now();
    const recoveryStartedAt = performance.now();
    let recoveryDurationMs = 0;
    try {
      await repository.recoverExpired(timestamp, AI_REPLY_JOB_MAX_ATTEMPTS);
      recoveryDurationMs = performance.now() - recoveryStartedAt;
    } catch (error) {
      logAiPipelineTiming({
        event: "ai_pipeline.queue_cycle",
        stage: "queue_recovery_and_claim",
        durationMs: performance.now() - cycleStartedAt,
        recoveryDurationMs: performance.now() - recoveryStartedAt,
        outcome: "recovery_error",
      });
      throw error;
    }

    const claimStartedAt = performance.now();
    let job: ClaimedAiReplyJob | null;
    try {
      job = await repository.claimNext(timestamp);
    } catch (error) {
      logAiPipelineTiming({
        event: "ai_pipeline.queue_cycle",
        stage: "queue_recovery_and_claim",
        durationMs: performance.now() - cycleStartedAt,
        recoveryDurationMs,
        claimDurationMs: performance.now() - claimStartedAt,
        outcome: "claim_error",
      });
      throw error;
    }

    const claimedAt = new Date();
    const queueDueAt = job?.nextAttemptAt instanceof Date
      ? job.nextAttemptAt
      : job?.createdAt instanceof Date ? job.createdAt : undefined;
    logAiPipelineTiming({
      event: "ai_pipeline.queue_cycle",
      stage: "queue_recovery_and_claim",
      durationMs: performance.now() - cycleStartedAt,
      recoveryDurationMs,
      claimDurationMs: performance.now() - claimStartedAt,
      outcome: job ? "claimed" : "idle",
      ...(job ? {
        jobId: String(job._id),
        attemptNumber: job.attemptCount,
        ...(queueDueAt ? { queueWaitMs: Math.max(0, claimedAt.getTime() - queueDueAt.getTime()) } : {}),
      } : {}),
    });
    if (!job) return { kind: "idle" };

    try {
      return await processClaimed(job);
    } catch {
      // Leave uncertain repository outcomes under their lease; recovery will fence and handle them.
      return { kind: "deferred" };
    }
  }

  return { processNext };
}
