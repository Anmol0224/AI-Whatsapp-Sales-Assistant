import mongoose, { type ClientSession, Types } from "mongoose";
import { randomUUID } from "node:crypto";
import {
  AiReplyJob,
  type AiReplyJobDocument,
  type AiReplyJobErrorCode,
  type AiReplyJobStatus,
} from "../models/ai-reply-job.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";

const DEFAULT_LEASE_DURATION_MS = 60_000;
const MAX_DRAFT_LENGTH = 4096;
export const AI_REPLY_JOB_MAX_ATTEMPTS = 3;
export const AI_REPLY_DRAFT_PAGE_LIMIT = 100;

export interface AiReplyDraftReviewRecord {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  sourceMessage: AiReplyDraftSourceMessage | null;
  status: AiReplyJobStatus;
  generatedDraft?: string;
  approvedText?: string;
  approvalEdited?: boolean;
  approvedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiReplyDraftSourceMessage {
  _id: Types.ObjectId;
  text: string;
  timestamp?: Date;
  createdAt: Date;
}

interface AiReplyDraftJobRecord extends Omit<AiReplyDraftReviewRecord, "sourceMessage"> {
  inboundMessageId: Types.ObjectId;
}

export interface ListAiReplyDraftsInput {
  businessId: Types.ObjectId;
  page: number;
  limit: number;
  status?: AiReplyJobStatus;
  conversationId?: Types.ObjectId;
}

export interface ListAiReplyDraftsResult {
  drafts: AiReplyDraftReviewRecord[];
  totalItems: number;
}

const aiReplyDraftReviewProjection = {
  _id: 1,
  conversationId: 1,
  inboundMessageId: 1,
  status: 1,
  generatedDraft: 1,
  approvedText: 1,
  approvalEdited: 1,
  approvedAt: 1,
  rejectedAt: 1,
  rejectionReason: 1,
  createdAt: 1,
  updatedAt: 1,
};

/** Lists safe review fields with deterministic business-scoped pagination. */
export async function listAiReplyDrafts(
  input: ListAiReplyDraftsInput,
): Promise<ListAiReplyDraftsResult> {
  return listAiReplyDraftsByFilter(input);
}

/** Lists drafts for an already business-verified conversation; the query also scopes both IDs. */
export async function listAiReplyDraftsForConversation(
  input: ListAiReplyDraftsInput & { conversationId: Types.ObjectId },
): Promise<ListAiReplyDraftsResult> {
  return listAiReplyDraftsByFilter(input);
}

async function listAiReplyDraftsByFilter(
  input: ListAiReplyDraftsInput,
): Promise<ListAiReplyDraftsResult> {
  if (!Number.isSafeInteger(input.page) || input.page < 1 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > AI_REPLY_DRAFT_PAGE_LIMIT ||
    !Number.isSafeInteger((input.page - 1) * input.limit)) {
    throw new Error("INVALID_AI_REPLY_DRAFT_PAGINATION");
  }

  const filter = {
    businessId: input.businessId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    status: input.status ?? "draft_ready",
  };
  const [drafts, totalItems] = await Promise.all([
    AiReplyJob.find(filter)
      .select(aiReplyDraftReviewProjection)
      .sort({ createdAt: -1, _id: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<AiReplyDraftJobRecord[]>()
      .exec(),
    AiReplyJob.countDocuments(filter).exec(),
  ]);
  return { drafts: await attachDraftSourceMessages(input.businessId, drafts), totalItems };
}

/** Retrieves one review-safe draft projection inside the authenticated business. */
export async function findAiReplyDraft(
  businessId: Types.ObjectId,
  jobId: Types.ObjectId,
): Promise<AiReplyDraftReviewRecord | null> {
  const draft = await AiReplyJob.findOne({ _id: jobId, businessId })
    .select(aiReplyDraftReviewProjection)
    .lean<AiReplyDraftJobRecord>()
    .exec();
  if (!draft) return null;
  const [withSource] = await attachDraftSourceMessages(businessId, [draft]);
  return withSource ?? null;
}

async function attachDraftSourceMessages(
  businessId: Types.ObjectId,
  drafts: AiReplyDraftJobRecord[],
): Promise<AiReplyDraftReviewRecord[]> {
  if (drafts.length === 0) return [];

  const messages = await Message.find({
    businessId,
    direction: "inbound",
    _id: { $in: drafts.map((draft) => draft.inboundMessageId) },
    conversationId: { $in: drafts.map((draft) => draft.conversationId) },
  })
    .select({ _id: 1, conversationId: 1, text: 1, timestamp: 1, createdAt: 1 })
    .lean<Array<AiReplyDraftSourceMessage & { conversationId: Types.ObjectId }>>()
    .exec();

  const messagesById = new Map(messages.map((message) => [message._id.toString(), message]));
  return drafts.map((draft) => {
    const source = messagesById.get(draft.inboundMessageId.toString());
    const sourceMessage = source && source.conversationId.equals(draft.conversationId)
      ? {
          _id: source._id,
          text: source.text,
          ...(source.timestamp ? { timestamp: source.timestamp } : {}),
          createdAt: source.createdAt,
        }
      : null;
    const reviewFields = { ...draft } as AiReplyDraftJobRecord;
    delete (reviewFields as Partial<AiReplyDraftJobRecord>).inboundMessageId;
    return { ...reviewFields, sourceMessage };
  });
}

export interface CreateAiReplyJobInput {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
}

export interface CreateAiReplyJobResult {
  job: AiReplyJobDocument;
  created: boolean;
}

export interface CreateAiReplyJobInSessionInput {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
  session: ClientSession;
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

/** Creates or confirms an eligible inbound job inside the caller's message-persistence transaction. */
export async function createAiReplyJobInSession(
  input: CreateAiReplyJobInSessionInput,
): Promise<"created" | "exists"> {
  const conversation = await Conversation.findOne({
    _id: input.conversationId,
    businessId: input.businessId,
    responseMode: "ai",
  })
    .select({ _id: 1 })
    .session(input.session)
    .lean()
    .exec();
  if (!conversation) {
    throw new Error("AI_REPLY_JOB_REFERENCE_NOT_FOUND");
  }

  const inboundMessage = await Message.findOne({
    _id: input.inboundMessageId,
    businessId: input.businessId,
    conversationId: input.conversationId,
    direction: "inbound",
  })
    .select({ _id: 1 })
    .session(input.session)
    .lean()
    .exec();
  if (!inboundMessage) throw new Error("AI_REPLY_JOB_REFERENCE_NOT_FOUND");

  const existingJob = await AiReplyJob.findOne({
    businessId: input.businessId,
    inboundMessageId: input.inboundMessageId,
  })
    .select({ _id: 1, conversationId: 1 })
    .session(input.session)
    .lean<{ conversationId: Types.ObjectId }>()
    .exec();

  if (existingJob) {
    if (!existingJob.conversationId.equals(input.conversationId)) {
      throw new Error("AI_REPLY_JOB_REFERENCE_CONFLICT");
    }
    return "exists";
  }

  await AiReplyJob.create([{
    businessId: input.businessId,
    conversationId: input.conversationId,
    inboundMessageId: input.inboundMessageId,
    status: "queued",
  }], { session: input.session });

  return "created";
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

export type HumanTakeoverResult =
  | { kind: "taken_over" }
  | { kind: "already_human" }
  | { kind: "send_in_progress" }
  | { kind: "conflict" }
  | { kind: "not_found" };

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
  }, session: AiDraftPersistenceSession): Promise<number | null>;
  saveJobIfCurrent(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    jobId: Types.ObjectId;
    attemptCount: number;
    draft: string;
    draftControlVersion: number;
    now: Date;
  }, session: AiDraftPersistenceSession): Promise<boolean>;
  takeOverConversation(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
  }): Promise<HumanTakeoverResult>;
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
          const draftControlVersion = await operations.incrementConversationFenceIfAi(
            { businessId: input.businessId, conversationId: input.conversationId },
            session,
          );
          if (draftControlVersion === null) {
            result = { kind: "mode_changed" };
            throw new DraftTransitionRejected("mode_changed");
          }

          const jobWasSaved = await operations.saveJobIfCurrent({
            ...input,
            draft: boundedDraft,
            draftControlVersion,
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
  }): Promise<HumanTakeoverResult> {
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
      {
        _id: conversationId,
        businessId,
        responseMode: "ai",
        ...hasNoActiveSendMarker(),
      },
      { $inc: { aiControlVersion: 1 } },
      { session: session.driverSession, returnDocument: "after", runValidators: true },
    )
      .select({ _id: 1, aiControlVersion: 1 })
      .lean<{ aiControlVersion: number }>()
      .exec();
    return conversation?.aiControlVersion ?? null;
  },
  saveJobIfCurrent: async ({
    businessId, conversationId, jobId, attemptCount, draft, draftControlVersion, now,
  }, session) => {
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
        $set: { status: "draft_ready", generatedDraft: draft, draftControlVersion },
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
      {
        _id: conversationId,
        businessId,
        responseMode: "ai",
        $or: [
          { activeAiSendJobId: { $exists: false } },
          { activeAiSendJobId: null },
        ],
      },
      {
        $set: { responseMode: "human" },
        $inc: { aiControlVersion: 1 },
      },
      { returnDocument: "after", runValidators: true },
    )
      .select({ _id: 1 })
      .lean()
      .exec();
    if (conversation) return { kind: "taken_over" };

    const current = await Conversation.findOne({ _id: conversationId, businessId })
      .select({ _id: 1, responseMode: 1, activeAiSendJobId: 1 })
      .lean<{ responseMode?: "human" | "ai"; activeAiSendJobId?: Types.ObjectId }>()
      .exec();
    if (!current) return { kind: "not_found" };
    if (current.activeAiSendJobId) return { kind: "send_in_progress" };
    return current.responseMode === "human" || current.responseMode === undefined
      ? { kind: "already_human" }
      : { kind: "conflict" };
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
): Promise<HumanTakeoverResult> {
  return mongooseDraftTransitions.takeOverConversation({ businessId, conversationId });
}

export type ConversationResponseModeResult =
  | { kind: "updated"; responseMode: "human" | "ai" }
  | { kind: "already_set"; responseMode: "human" | "ai" }
  | { kind: "send_in_progress" }
  | { kind: "conflict" }
  | { kind: "not_found" };

/** Changes response mode with business-scoped compare-and-set behavior on the Conversation fence. */
export async function setConversationResponseMode(
  businessId: Types.ObjectId,
  conversationId: Types.ObjectId,
  responseMode: "human" | "ai",
): Promise<ConversationResponseModeResult> {
  if (responseMode === "human") {
    const takeover = await takeOverConversation(businessId, conversationId);
    if (takeover.kind === "taken_over") return { kind: "updated", responseMode: "human" };
    if (takeover.kind === "already_human") return { kind: "already_set", responseMode: "human" };
    return takeover;
  }

  const conversation = await Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      businessId,
      $and: [
        { $or: [{ responseMode: "human" }, { responseMode: { $exists: false } }] },
        hasNoActiveSendMarker(),
      ],
    },
    {
      $set: { responseMode: "ai" },
      $inc: { aiControlVersion: 1 },
    },
    { returnDocument: "after", runValidators: true },
  )
    .select({ _id: 1 })
    .lean()
    .exec();
  if (conversation) return { kind: "updated", responseMode: "ai" };

  const current = await Conversation.findOne({ _id: conversationId, businessId })
    .select({ _id: 1, responseMode: 1, activeAiSendJobId: 1 })
    .lean<{ responseMode?: "human" | "ai"; activeAiSendJobId?: Types.ObjectId }>()
    .exec();
  if (!current) return { kind: "not_found" };
  if (current.activeAiSendJobId) return { kind: "send_in_progress" };
  if (current.responseMode === "ai") return { kind: "already_set", responseMode: "ai" };
  return { kind: "conflict" };
}

export type DraftApprovalResult =
  | { kind: "approved"; approvedText: string; approvedControlVersion: number }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "mode_changed" }
  | { kind: "stale" }
  | { kind: "send_in_progress" };

export type DraftRejectionResult = { kind: "rejected" } | { kind: "not_found" } | { kind: "conflict" };
export type SendReservationResult =
  | { kind: "reserved"; sendAttemptId: string; approvedText: string; conversationId: Types.ObjectId; leaseExpiresAt: Date }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "mode_changed" };
export type SendCompletionResult =
  | { kind: "sent"; message: import("../models/message.model.js").MessageDocument }
  | { kind: "already_sent"; outboundMessageId: Types.ObjectId }
  | { kind: "stale" };
export type SendOutcomeResult = { kind: "recorded" } | { kind: "stale" };

class AiReplyTransitionAborted extends Error {
  constructor(readonly result: string) {
    super("AI reply transition precondition failed.");
  }
}

async function inTransaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    if (result === undefined) throw new Error("AI_REPLY_TRANSACTION_RESULT_MISSING");
    return result;
  } finally {
    await session.endSession();
  }
}

function hasNoActiveSendMarker() {
  return {
    $or: [
      { activeAiSendJobId: { $exists: false } },
      { activeAiSendJobId: null },
    ],
  };
}

function activeSendReservationFilter(jobId: Types.ObjectId) {
  return {
    $or: [
      { activeAiSendJobId: jobId },
      { activeAiSendJobId: { $exists: false } },
      { activeAiSendJobId: null },
    ],
  };
}

function isSafeText(value: string, maxLength = MAX_DRAFT_LENGTH): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

/** Approves the exact draft text in an AI-mode conversation and records the owner decision atomically. */
export async function approveAiReplyDraft(input: {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  jobId: Types.ObjectId;
  approvedText?: string;
  now?: Date;
}): Promise<DraftApprovalResult> {
  const now = input.now ?? new Date();

  try {
    return await inTransaction(async (session) => {
      const job = await AiReplyJob.findOne({ _id: input.jobId, businessId: input.businessId })
        .select({
          _id: 1,
          conversationId: 1,
          inboundMessageId: 1,
          status: 1,
          generatedDraft: 1,
          draftControlVersion: 1,
        })
        .session(session)
        .lean<{
          conversationId: Types.ObjectId;
          inboundMessageId: Types.ObjectId;
          status: string;
          generatedDraft?: string;
          draftControlVersion?: number;
        }>()
        .exec();
      if (!job) return { kind: "not_found" };
      if (job.status !== "draft_ready") return { kind: "conflict" };
      if (!Number.isSafeInteger(job.draftControlVersion)) return { kind: "stale" };

      const latestInboundMessage = await Message.findOne({
        businessId: input.businessId,
        conversationId: job.conversationId,
        direction: "inbound",
      })
        .select({ _id: 1 })
        .sort({ createdAt: -1, _id: -1 })
        .session(session)
        .lean<{ _id: Types.ObjectId }>()
        .exec();
      if (!latestInboundMessage || !latestInboundMessage._id.equals(job.inboundMessageId)) {
        return { kind: "stale" };
      }

      const text = input.approvedText === undefined ? job.generatedDraft : input.approvedText;
      if (!text || !isSafeText(text)) throw new Error("INVALID_AI_REPLY_APPROVED_TEXT");
      const approvedText = text.trim();

      const conversation = await Conversation.findOneAndUpdate(
        {
          _id: job.conversationId,
          businessId: input.businessId,
          responseMode: "ai",
          aiControlVersion: job.draftControlVersion,
          ...hasNoActiveSendMarker(),
        },
        { $inc: { aiControlVersion: 1 } },
        { session, returnDocument: "after", runValidators: true },
      )
        .select({ _id: 1, aiControlVersion: 1 })
        .lean<{ aiControlVersion: number }>()
        .exec();
      if (!conversation) {
        const current = await Conversation.findOne({ _id: job.conversationId, businessId: input.businessId })
          .select({ _id: 1, responseMode: 1, aiControlVersion: 1, activeAiSendJobId: 1 })
          .session(session)
          .lean<{
            responseMode?: "human" | "ai";
            aiControlVersion?: number;
            activeAiSendJobId?: Types.ObjectId;
          }>()
          .exec();
        if (!current) throw new AiReplyTransitionAborted("not_found");
        if (current.activeAiSendJobId) throw new AiReplyTransitionAborted("send_in_progress");
        if (current.responseMode !== "ai") throw new AiReplyTransitionAborted("mode_changed");
        throw new AiReplyTransitionAborted("stale");
      }

      const updated = await AiReplyJob.updateOne(
        { _id: input.jobId, businessId: input.businessId, conversationId: job.conversationId, status: "draft_ready" },
        {
          $set: {
            status: "approved",
            approvedText,
            approvedByUserId: input.userId,
            approvedAt: now,
            approvalEdited: approvedText !== (job.generatedDraft?.trim() ?? ""),
            approvedControlVersion: conversation.aiControlVersion,
          },
        },
        { session, runValidators: true },
      ).exec();
      if (updated.matchedCount !== 1) throw new AiReplyTransitionAborted("conflict");
      return { kind: "approved", approvedText, approvedControlVersion: conversation.aiControlVersion };
    });
  } catch (error) {
    if (error instanceof AiReplyTransitionAborted) {
      if (error.result === "not_found") return { kind: "not_found" };
      if (error.result === "send_in_progress") return { kind: "send_in_progress" };
      if (error.result === "mode_changed") return { kind: "mode_changed" };
      if (error.result === "stale") return { kind: "stale" };
      return { kind: "conflict" };
    }
    throw error;
  }
}

/** Rejects a pending draft once and stores only a bounded, owner-provided reason. */
export async function rejectAiReplyDraft(input: {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  jobId: Types.ObjectId;
  reason?: string;
  now?: Date;
}): Promise<DraftRejectionResult> {
  const reason = input.reason?.trim();
  if (reason && reason.length > 500) throw new Error("INVALID_AI_REPLY_REJECTION_REASON");
  const updated = await AiReplyJob.updateOne(
    { _id: input.jobId, businessId: input.businessId, status: "draft_ready" },
    {
      $set: {
        status: "rejected",
        rejectedByUserId: input.userId,
        rejectedAt: input.now ?? new Date(),
        ...(reason ? { rejectionReason: reason } : {}),
      },
    },
    { runValidators: true },
  ).exec();
  if (updated.matchedCount === 1) return { kind: "rejected" };
  const exists = await AiReplyJob.exists({ _id: input.jobId, businessId: input.businessId });
  return exists ? { kind: "conflict" } : { kind: "not_found" };
}

/** Atomically reserves one approved draft. No provider call belongs inside this transaction. */
export async function reserveAiReplyDraftForSending(input: {
  businessId: Types.ObjectId;
  jobId: Types.ObjectId;
  now?: Date;
  leaseDurationMs?: number;
}): Promise<SendReservationResult> {
  const now = input.now ?? new Date();
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!isValidLeaseDuration(leaseDurationMs) || leaseDurationMs > 5 * 60_000) {
    throw new Error("INVALID_AI_REPLY_SEND_LEASE_DURATION");
  }
  const sendAttemptId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  try {
    return await inTransaction(async (session) => {
      const job = await AiReplyJob.findOne({ _id: input.jobId, businessId: input.businessId })
        .select({ _id: 1, conversationId: 1, status: 1, approvedText: 1, approvedControlVersion: 1 })
        .session(session)
        .lean<{
          conversationId: Types.ObjectId;
          status: string;
          approvedText?: string;
          approvedControlVersion?: number;
        }>()
        .exec();
      if (!job) return { kind: "not_found" };
      if (job.status !== "approved" || !job.approvedText || job.approvedControlVersion === undefined) {
        return { kind: "conflict" };
      }

      const conversation = await Conversation.findOneAndUpdate(
        {
          _id: job.conversationId,
          businessId: input.businessId,
          responseMode: "ai",
          aiControlVersion: job.approvedControlVersion,
          ...hasNoActiveSendMarker(),
        },
        { $set: { activeAiSendJobId: input.jobId }, $inc: { aiControlVersion: 1 } },
        { session, returnDocument: "after", runValidators: true },
      )
        .select({ _id: 1 })
        .lean()
        .exec();
      if (!conversation) throw new AiReplyTransitionAborted("mode_changed");

      const updated = await AiReplyJob.updateOne(
        { _id: input.jobId, businessId: input.businessId, conversationId: job.conversationId, status: "approved" },
        {
          $set: { status: "sending", sendAttemptId, sendStartedAt: now, sendLeaseExpiresAt: leaseExpiresAt },
        },
        { session, runValidators: true },
      ).exec();
      if (updated.matchedCount !== 1) throw new AiReplyTransitionAborted("conflict");
      return {
        kind: "reserved",
        sendAttemptId,
        approvedText: job.approvedText,
        conversationId: job.conversationId,
        leaseExpiresAt,
      };
    });
  } catch (error) {
    if (error instanceof AiReplyTransitionAborted) {
      return error.result === "mode_changed" ? { kind: "mode_changed" } : { kind: "conflict" };
    }
    throw error;
  }
}

/** Atomically persists a confirmed provider acceptance, outbound Message and conversation summary. */
export async function completeAiReplySend(input: {
  businessId: Types.ObjectId;
  jobId: Types.ObjectId;
  sendAttemptId: string;
  providerMessageId: string;
  now?: Date;
}): Promise<SendCompletionResult> {
  const providerMessageId = input.providerMessageId.trim();
  if (!providerMessageId || providerMessageId.length > 256 || !input.sendAttemptId) {
    throw new Error("INVALID_AI_REPLY_SEND_COMPLETION");
  }
  const now = input.now ?? new Date();

  try {
    return await inTransaction(async (session) => {
      const job = await AiReplyJob.findOne({
        _id: input.jobId,
        businessId: input.businessId,
        status: "sending",
        sendAttemptId: input.sendAttemptId,
      })
        .select({ _id: 1, conversationId: 1, approvedText: 1 })
        .session(session)
        .lean<{ conversationId: Types.ObjectId; approvedText: string }>()
        .exec();
      if (!job) {
        const completed = await AiReplyJob.findOne({
          _id: input.jobId,
          businessId: input.businessId,
          status: "sent",
          sendAttemptId: input.sendAttemptId,
          outboundMessageId: { $exists: true },
        })
          .select({ outboundMessageId: 1 })
          .session(session)
          .lean<{ outboundMessageId: Types.ObjectId }>()
          .exec();
        return completed
          ? { kind: "already_sent", outboundMessageId: completed.outboundMessageId }
          : { kind: "stale" };
      }

      const conversation = await Conversation.findOne({
        _id: job.conversationId,
        businessId: input.businessId,
        activeAiSendJobId: input.jobId,
      })
        .select({ _id: 1, customerId: 1 })
        .session(session)
        .lean<{ customerId: Types.ObjectId }>()
        .exec();
      if (!conversation) throw new AiReplyTransitionAborted("stale");

      const [message] = await Message.create([{
        businessId: input.businessId,
        conversationId: job.conversationId,
        customerId: conversation.customerId,
        aiReplyJobId: input.jobId,
        direction: "outbound",
        messageType: "text",
        text: job.approvedText,
        providerMessageId,
        status: "sent",
        timestamp: now,
      }], { session });

      const conversationUpdate = await Conversation.updateOne(
        {
          _id: job.conversationId,
          businessId: input.businessId,
          ...activeSendReservationFilter(input.jobId),
        },
        {
          $set: { lastMessageAt: now, lastMessagePreview: job.approvedText.slice(0, 280) },
          $unset: { activeAiSendJobId: 1 },
          $inc: { aiControlVersion: 1 },
        },
        { session, runValidators: true },
      ).exec();
      if (conversationUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");

      const jobUpdate = await AiReplyJob.updateOne(
        {
          _id: input.jobId,
          businessId: input.businessId,
          status: "sending",
          sendAttemptId: input.sendAttemptId,
        },
        {
          $set: {
            status: "sent",
            sendOutcome: "accepted",
            providerMessageId,
            outboundMessageId: message._id,
            sendFinishedAt: now,
          },
          $unset: { sendLeaseExpiresAt: 1 },
        },
        { session, runValidators: true },
      ).exec();
      if (jobUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");
      return { kind: "sent", message };
    });
  } catch (error) {
    if (error instanceof AiReplyTransitionAborted) return { kind: "stale" };
    throw error;
  }
}

/** Records definitive rejection or ambiguity; it never retries or resends the provider request. */
export async function recordAiReplySendOutcome(input: {
  businessId: Types.ObjectId;
  jobId: Types.ObjectId;
  sendAttemptId: string;
  outcome: "rejected" | "uncertain";
  errorCode: import("../models/ai-reply-job.model.js").AiReplySendErrorCode;
  providerStatusCode?: number;
  providerMessageId?: string;
  now?: Date;
}): Promise<SendOutcomeResult> {
  if (input.providerStatusCode !== undefined &&
    (!Number.isInteger(input.providerStatusCode) || input.providerStatusCode < 100 || input.providerStatusCode > 599)) {
    throw new Error("INVALID_AI_REPLY_PROVIDER_STATUS_CODE");
  }
  if (input.providerMessageId !== undefined &&
    (!input.providerMessageId.trim() || input.providerMessageId.trim().length > 256)) {
    throw new Error("INVALID_AI_REPLY_PROVIDER_MESSAGE_ID");
  }
  const now = input.now ?? new Date();

  try {
    return await inTransaction(async (session) => {
      const job = await AiReplyJob.findOne({
        _id: input.jobId,
        businessId: input.businessId,
        status: "sending",
        sendAttemptId: input.sendAttemptId,
      })
        .select({ _id: 1, conversationId: 1 })
        .session(session)
        .lean<{ conversationId: Types.ObjectId }>()
        .exec();
      if (!job) return { kind: "stale" };

      const conversationUpdate = await Conversation.updateOne(
        { _id: job.conversationId, businessId: input.businessId, activeAiSendJobId: input.jobId },
        { $unset: { activeAiSendJobId: 1 }, $inc: { aiControlVersion: 1 } },
        { session, runValidators: true },
      ).exec();
      if (conversationUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");

      const jobUpdate = await AiReplyJob.updateOne(
        {
          _id: input.jobId,
          businessId: input.businessId,
          status: "sending",
          sendAttemptId: input.sendAttemptId,
        },
        {
          $set: {
            status: input.outcome === "rejected" ? "send_failed" : "send_uncertain",
            sendOutcome: input.outcome,
            sendErrorCode: input.errorCode,
            sendFinishedAt: now,
            ...(input.providerStatusCode !== undefined ? { providerStatusCode: input.providerStatusCode } : {}),
            ...(input.providerMessageId ? { providerMessageId: input.providerMessageId.trim() } : {}),
          },
          $unset: { sendLeaseExpiresAt: 1 },
        },
        { session, runValidators: true },
      ).exec();
      if (jobUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");
      return { kind: "recorded" };
    });
  } catch (error) {
    if (error instanceof AiReplyTransitionAborted) return { kind: "stale" };
    throw error;
  }
}

/** Expires send leases to an uncertain terminal state; this operation deliberately never requeues sends. */
export async function recoverExpiredAiReplySendReservations(
  now = new Date(),
  limit = 100,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("INVALID_AI_REPLY_SEND_RECOVERY_LIMIT");
  const candidates = await AiReplyJob.find({ status: "sending", sendLeaseExpiresAt: { $lte: now } })
    .select({ _id: 1, businessId: 1, conversationId: 1, sendAttemptId: 1 })
    .sort({ sendLeaseExpiresAt: 1 })
    .limit(limit)
    .lean<Array<{ _id: Types.ObjectId; businessId: Types.ObjectId; conversationId: Types.ObjectId; sendAttemptId?: string }>>()
    .exec();

  let recovered = 0;
  for (const candidate of candidates) {
    if (!candidate.sendAttemptId) continue;
    try {
      const didRecover = await inTransaction(async (session) => {
        const current = await AiReplyJob.findOne({
          _id: candidate._id,
          businessId: candidate.businessId,
          conversationId: candidate.conversationId,
          status: "sending",
          sendAttemptId: candidate.sendAttemptId,
          sendLeaseExpiresAt: { $lte: now },
        })
          .select({ _id: 1 })
          .session(session)
          .lean()
          .exec();
        if (!current) return false;

        const convUpdate = await Conversation.updateOne(
          {
            _id: candidate.conversationId,
            businessId: candidate.businessId,
            ...activeSendReservationFilter(candidate._id),
          },
          { $unset: { activeAiSendJobId: 1 }, $inc: { aiControlVersion: 1 } },
          { session, runValidators: true },
        ).exec();
        if (convUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");

        const jobUpdate = await AiReplyJob.updateOne(
          {
            _id: candidate._id,
            businessId: candidate.businessId,
            status: "sending",
            sendAttemptId: candidate.sendAttemptId,
            sendLeaseExpiresAt: { $lte: now },
          },
          {
            $set: {
              status: "send_uncertain",
              sendOutcome: "uncertain",
              sendErrorCode: "send_lease_expired",
              sendFinishedAt: now,
            },
            $unset: { sendLeaseExpiresAt: 1 },
          },
          { session, runValidators: true },
        ).exec();
        if (jobUpdate.matchedCount !== 1) throw new AiReplyTransitionAborted("stale");
        return true;
      });
      if (didRecover) recovered += 1;
    } catch (error) {
      if (!(error instanceof AiReplyTransitionAborted)) throw error;
    }
  }
  return recovered;
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
