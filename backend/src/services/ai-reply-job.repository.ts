import mongoose, { type ClientSession, Types } from "mongoose";
import { AiReplyJob, type AiReplyJobDocument, type AiReplyJobErrorCode } from "../models/ai-reply-job.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";

const DEFAULT_LEASE_DURATION_MS = 60_000;
const MAX_DRAFT_LENGTH = 4096;
export const AI_REPLY_JOB_MAX_ATTEMPTS = 3;

export interface CreateAiReplyJobInput {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
}

export interface CreateAiReplyJobResult {
  job: AiReplyJobDocument;
  created: boolean;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

function isValidLeaseDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Creates one queued job per persisted inbound message, returning the existing job on duplicate delivery. */
export async function createOrGetAiReplyJob(
  input: CreateAiReplyJobInput,
): Promise<CreateAiReplyJobResult> {
  const [conversation, inboundMessage] = await Promise.all([
    Conversation.exists({ _id: input.conversationId, businessId: input.businessId }),
    Message.exists({
      _id: input.inboundMessageId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      direction: "inbound",
    }),
  ]);

  if (!conversation || !inboundMessage) {
    throw new Error("AI_REPLY_JOB_REFERENCE_NOT_FOUND");
  }

  try {
    const [job] = await AiReplyJob.create([{
      businessId: input.businessId,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
      status: "queued",
    }]);
    return { job, created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const existing = await AiReplyJob.findOne({
      businessId: input.businessId,
      inboundMessageId: input.inboundMessageId,
    }).exec();
    if (!existing) throw error;
    return { job: existing, created: false };
  }
}

/** Atomically claims one due job for this business. attemptCount acts as a fencing token for completion. */
export async function claimQueuedAiReplyJob(
  businessId: Types.ObjectId,
  options: { now?: Date; leaseDurationMs?: number } = {},
): Promise<AiReplyJobDocument | null> {
  const now = options.now ?? new Date();
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!isValidLeaseDuration(leaseDurationMs)) throw new Error("INVALID_AI_REPLY_JOB_LEASE_DURATION");

  return AiReplyJob.findOneAndUpdate(
    {
      businessId,
      status: "queued",
      nextAttemptAt: { $lte: now },
      attemptCount: { $lt: AI_REPLY_JOB_MAX_ATTEMPTS },
    },
    {
      $set: { status: "processing", lockedAt: now, leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) },
      $inc: { attemptCount: 1 },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: "after",
      runValidators: true,
    },
  ).exec();
}

/** Atomically claims the next due job across workspaces for the trusted background worker. */
export async function claimNextQueuedAiReplyJob(
  options: { now?: Date; leaseDurationMs?: number } = {},
): Promise<AiReplyJobDocument | null> {
  const now = options.now ?? new Date();
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!isValidLeaseDuration(leaseDurationMs)) throw new Error("INVALID_AI_REPLY_JOB_LEASE_DURATION");

  return AiReplyJob.findOneAndUpdate(
    {
      status: "queued",
      nextAttemptAt: { $lte: now },
      attemptCount: { $lt: AI_REPLY_JOB_MAX_ATTEMPTS },
    },
    {
      $set: { status: "processing", lockedAt: now, leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) },
      $inc: { attemptCount: 1 },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: "after",
      runValidators: true,
    },
  ).exec();
}

/** Reads only the response mode for a conversation inside its owning business. */
export async function findAiReplyConversationMode(
  businessId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<"human" | "ai" | null> {
  const conversation = await Conversation.findOne({ _id: conversationId, businessId })
    .select({ _id: 1, responseMode: 1 })
    .lean<{ responseMode?: "human" | "ai" }>()
    .exec();
  return conversation?.responseMode === "human" || conversation?.responseMode === "ai"
    ? conversation.responseMode
    : null;
}

/** Requeues expired generation leases; it does not send or retry WhatsApp messages. */
export async function recoverExpiredAiReplyJobs(
  businessId: Types.ObjectId,
  now = new Date(),
): Promise<number> {
  const [requeued, exhausted] = await Promise.all([
    AiReplyJob.updateMany(
      {
        businessId,
        status: "processing",
        leaseExpiresAt: { $lte: now },
        attemptCount: { $lt: AI_REPLY_JOB_MAX_ATTEMPTS },
      },
      {
        $set: { status: "queued", nextAttemptAt: now },
        $unset: { lockedAt: 1, leaseExpiresAt: 1 },
      },
      { runValidators: true },
    ).exec(),
    AiReplyJob.updateMany(
      {
        businessId,
        status: "processing",
        leaseExpiresAt: { $lte: now },
        attemptCount: { $gte: AI_REPLY_JOB_MAX_ATTEMPTS },
      },
      {
        $set: { status: "failed", errorCode: "internal_error" },
        $unset: { lockedAt: 1, leaseExpiresAt: 1 },
      },
      { runValidators: true },
    ).exec(),
  ]);
  return requeued.modifiedCount + exhausted.modifiedCount;
}

/** Globally recovers expired worker leases and terminally fails attempts that exhausted the retry limit. */
export async function recoverExpiredAiReplyJobsForWorker(
  now = new Date(),
  maxAttempts = AI_REPLY_JOB_MAX_ATTEMPTS,
): Promise<number> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("INVALID_AI_REPLY_JOB_MAX_ATTEMPTS");
  }

  const [requeued, exhausted] = await Promise.all([
    AiReplyJob.updateMany(
      { status: "processing", leaseExpiresAt: { $lte: now }, attemptCount: { $lt: maxAttempts } },
      {
        $set: { status: "queued", nextAttemptAt: now },
        $unset: { lockedAt: 1, leaseExpiresAt: 1 },
      },
      { runValidators: true },
    ).exec(),
    AiReplyJob.updateMany(
      { status: "processing", leaseExpiresAt: { $lte: now }, attemptCount: { $gte: maxAttempts } },
      {
        $set: { status: "failed", errorCode: "internal_error" },
        $unset: { lockedAt: 1, leaseExpiresAt: 1 },
      },
      { runValidators: true },
    ).exec(),
  ]);

  return requeued.modifiedCount + exhausted.modifiedCount;
}

export type AiReplyDraftPersistenceResult =
  | { kind: "saved" }
  | { kind: "mode_changed" }
  | { kind: "stale" };

export interface AiDraftPersistenceSession {
  withTransaction<T>(callback: () => Promise<T>): Promise<T | undefined>;
  endSession(): Promise<void>;
  driverSession?: ClientSession;
}

export interface AiReplyDraftTransitionOperations {
  startSession(): Promise<AiDraftPersistenceSession>;
  incrementConversationFenceIfAi(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
  }, session: AiDraftPersistenceSession): Promise<boolean>;
  saveJobIfCurrent(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    jobId: Types.ObjectId;
    attemptCount: number;
    draft: string;
    now: Date;
  }, session: AiDraftPersistenceSession): Promise<boolean>;
  takeOverConversation(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
  }): Promise<boolean>;
  now(): Date;
}

class DraftTransitionRejected extends Error {
  constructor(readonly result: "mode_changed" | "stale") {
    super("AI draft transaction precondition failed.");
  }
}

/** Creates transaction-coordinated draft completion and takeover operations for the same Conversation document. */
export function createAiReplyDraftTransitions(operations: AiReplyDraftTransitionOperations) {
  async function saveDraft(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    jobId: Types.ObjectId;
    attemptCount: number;
    draft: string;
  }): Promise<AiReplyDraftPersistenceResult> {
    const boundedDraft = input.draft.trim();
    if (!boundedDraft || boundedDraft.length > MAX_DRAFT_LENGTH) {
      throw new Error("INVALID_AI_REPLY_DRAFT");
    }

    const session = await operations.startSession();
    let result: AiReplyDraftPersistenceResult | undefined;
    try {
      try {
        await session.withTransaction(async () => {
          result = undefined;
          const conversationCanDraft = await operations.incrementConversationFenceIfAi(
            { businessId: input.businessId, conversationId: input.conversationId },
            session,
          );
          if (!conversationCanDraft) {
            result = { kind: "mode_changed" };
            throw new DraftTransitionRejected("mode_changed");
          }

          const jobWasSaved = await operations.saveJobIfCurrent({
            ...input,
            draft: boundedDraft,
            now: operations.now(),
          }, session);
          if (!jobWasSaved) {
            result = { kind: "stale" };
            throw new DraftTransitionRejected("stale");
          }
          result = { kind: "saved" };
        });
      } catch (error) {
        if (error instanceof DraftTransitionRejected) return { kind: error.result };
        throw error;
      }

      return result ?? { kind: "stale" };
    } finally {
      await session.endSession();
    }
  }

  async function takeOverConversation(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
  }): Promise<boolean> {
    return operations.takeOverConversation(input);
  }

  return { saveDraft, takeOverConversation };
}

const mongooseDraftTransitions = createAiReplyDraftTransitions({
  startSession: async () => {
    const session = await mongoose.startSession();
    return {
      withTransaction: (callback) => session.withTransaction(callback),
      endSession: () => session.endSession(),
      driverSession: session,
    };
  },
  incrementConversationFenceIfAi: async ({ businessId, conversationId }, session) => {
    const conversation = await Conversation.findOneAndUpdate(
      { _id: conversationId, businessId, responseMode: "ai" },
      { $inc: { aiControlVersion: 1 } },
      { session: session.driverSession, returnDocument: "after", runValidators: true },
    )
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(conversation);
  },
  saveJobIfCurrent: async ({ businessId, conversationId, jobId, attemptCount, draft, now }, session) => {
    const job = await AiReplyJob.findOneAndUpdate(
      {
        _id: jobId,
        businessId,
        conversationId,
        status: "processing",
        attemptCount,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: { status: "draft_ready", generatedDraft: draft },
        $unset: { lockedAt: 1, leaseExpiresAt: 1, errorCode: 1 },
      },
      { session: session.driverSession, returnDocument: "after", runValidators: true },
    )
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(job);
  },
  takeOverConversation: async ({ businessId, conversationId }) => {
    const conversation = await Conversation.findOneAndUpdate(
      { _id: conversationId, businessId, responseMode: "ai" },
      {
        $set: { responseMode: "human" },
        $inc: { aiControlVersion: 1 },
      },
      { returnDocument: "after", runValidators: true },
    )
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(conversation);
  },
  now: () => new Date(),
});

/** Persists the draft and increments the conversation fence in one transaction. */
export async function saveAiReplyDraft(
  businessId: Types.ObjectId,
  conversationId: Types.ObjectId,
  jobId: Types.ObjectId,
  attemptCount: number,
  draft: string,
): Promise<AiReplyDraftPersistenceResult> {
  return mongooseDraftTransitions.saveDraft({ businessId, conversationId, jobId, attemptCount, draft });
}

/** Atomically switches an AI-mode conversation to human mode and increments the shared write fence. */
export async function takeOverConversation(
  businessId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<boolean> {
  return mongooseDraftTransitions.takeOverConversation({ businessId, conversationId });
}

/** Records only a predefined safe category, and only for the current live processing attempt. */
export async function markAiReplyJobFailed(
  businessId: Types.ObjectId,
  jobId: Types.ObjectId,
  attemptCount: number,
  errorCode: AiReplyJobErrorCode,
  now = new Date(),
): Promise<AiReplyJobDocument | null> {
  return AiReplyJob.findOneAndUpdate(
    {
      _id: jobId,
      businessId,
      status: "processing",
      attemptCount,
      leaseExpiresAt: { $gt: now },
    },
    {
      $set: { status: "failed", errorCode },
      $unset: { lockedAt: 1, leaseExpiresAt: 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();
}

/** Schedules a retry only for the exact attempt that still owns a live lease. */
export async function retryAiReplyJob(
  businessId: Types.ObjectId,
  jobId: Types.ObjectId,
  attemptCount: number,
  nextAttemptAt: Date,
  errorCode: AiReplyJobErrorCode,
  now = new Date(),
): Promise<AiReplyJobDocument | null> {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 ||
    attemptCount >= AI_REPLY_JOB_MAX_ATTEMPTS ||
    !(nextAttemptAt instanceof Date) || !Number.isFinite(nextAttemptAt.getTime())) {
    throw new Error("INVALID_AI_REPLY_JOB_RETRY");
  }

  return AiReplyJob.findOneAndUpdate(
    {
      _id: jobId,
      businessId,
      status: "processing",
      attemptCount,
      leaseExpiresAt: { $gt: now },
    },
    {
      $set: { status: "queued", nextAttemptAt, errorCode },
      $unset: { lockedAt: 1, leaseExpiresAt: 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();
}

/** Cancels only the current live processing attempt, so an older worker cannot cancel a newer attempt. */
export async function cancelProcessingAiReplyJob(
  businessId: Types.ObjectId,
  jobId: Types.ObjectId,
  attemptCount: number,
  now = new Date(),
): Promise<AiReplyJobDocument | null> {
  return AiReplyJob.findOneAndUpdate(
    {
      _id: jobId,
      businessId,
      status: "processing",
      attemptCount,
      leaseExpiresAt: { $gt: now },
    },
    {
      $set: { status: "cancelled" },
      $unset: { lockedAt: 1, leaseExpiresAt: 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();
}

/** Cancels queued or processing work; stale workers can no longer complete because status changed. */
export async function cancelAiReplyJob(
  businessId: Types.ObjectId,
  jobId: Types.ObjectId,
): Promise<AiReplyJobDocument | null> {
  return AiReplyJob.findOneAndUpdate(
    { _id: jobId, businessId, status: { $in: ["queued", "processing"] } },
    {
      $set: { status: "cancelled" },
      $unset: { lockedAt: 1, leaseExpiresAt: 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();
}
