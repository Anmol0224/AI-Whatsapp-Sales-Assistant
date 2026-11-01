import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type AiReplyJobStatus =
  | "queued"
  | "processing"
  | "draft_ready"
  | "approved"
  | "rejected"
  | "sending"
  | "sent"
  | "send_failed"
  | "send_uncertain"
  | "failed"
  | "cancelled";
export type AiReplyJobErrorCode =
  | "context_unavailable"
  | "provider_unavailable"
  | "provider_timeout"
  | "database_unavailable"
  | "invalid_output"
  | "internal_error";
export type AiReplySendErrorCode =
  | "provider_rejected"
  | "provider_timeout"
  | "provider_network_error"
  | "provider_unavailable"
  | "invalid_provider_response"
  | "persistence_unavailable"
  | "send_lease_expired"
  | "internal_error";
export type AiReplySendOutcome = "accepted" | "rejected" | "uncertain";

export interface AiReplyJobFields {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
  status: AiReplyJobStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lockedAt?: Date;
  leaseExpiresAt?: Date;
  generatedDraft?: string;
  draftControlVersion?: number;
  approvedText?: string;
  approvedByUserId?: Types.ObjectId;
  approvedAt?: Date;
  approvalEdited?: boolean;
  approvedControlVersion?: number;
  rejectedByUserId?: Types.ObjectId;
  rejectedAt?: Date;
  rejectionReason?: string;
  sendAttemptId?: string;
  sendStartedAt?: Date;
  sendLeaseExpiresAt?: Date;
  sendFinishedAt?: Date;
  sendOutcome?: AiReplySendOutcome;
  sendErrorCode?: AiReplySendErrorCode;
  providerStatusCode?: number;
  providerMessageId?: string;
  outboundMessageId?: Types.ObjectId;
  errorCode?: AiReplyJobErrorCode;
  createdAt: Date;
  updatedAt: Date;
}

const aiReplyJobSchema = new mongoose.Schema<AiReplyJobFields>(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    inboundMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    status: {
      type: String,
      enum: [
        "queued",
        "processing",
        "draft_ready",
        "approved",
        "rejected",
        "sending",
        "sent",
        "send_failed",
        "send_uncertain",
        "failed",
        "cancelled",
      ],
      default: "queued",
      required: true,
    },
    attemptCount: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "attemptCount must be a non-negative safe integer.",
      },
      required: true,
    },
    nextAttemptAt: { type: Date, default: Date.now, required: true },
    lockedAt: { type: Date },
    leaseExpiresAt: { type: Date },
    generatedDraft: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 4096,
    },
    draftControlVersion: {
      type: Number,
      min: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "draftControlVersion must be a non-negative safe integer.",
      },
    },
    approvedText: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 4096,
    },
    approvedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedAt: { type: Date },
    approvalEdited: { type: Boolean },
    approvedControlVersion: {
      type: Number,
      min: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "approvedControlVersion must be a non-negative safe integer.",
      },
    },
    rejectedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
    sendAttemptId: {
      type: String,
      trim: true,
      minlength: 36,
      maxlength: 36,
      match: [/^[a-f\d-]{36}$/i, "sendAttemptId must be a UUID."],
    },
    sendStartedAt: { type: Date },
    sendLeaseExpiresAt: { type: Date },
    sendFinishedAt: { type: Date },
    sendOutcome: {
      type: String,
      enum: ["accepted", "rejected", "uncertain"],
    },
    sendErrorCode: {
      type: String,
      enum: [
        "provider_rejected",
        "provider_timeout",
        "provider_network_error",
        "provider_unavailable",
        "invalid_provider_response",
        "persistence_unavailable",
        "send_lease_expired",
        "internal_error",
      ],
      maxlength: 64,
    },
    providerStatusCode: { type: Number, min: 100, max: 599, validate: Number.isInteger },
    providerMessageId: { type: String, trim: true, minlength: 1, maxlength: 256 },
    outboundMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    errorCode: {
      type: String,
      enum: [
        "context_unavailable",
        "provider_unavailable",
        "provider_timeout",
        "database_unavailable",
        "invalid_output",
        "internal_error",
      ],
      maxlength: 64,
    },
  },
  { timestamps: true },
);

aiReplyJobSchema.index(
  { businessId: 1, inboundMessageId: 1 },
  { unique: true, name: "ai_reply_jobs_business_inbound_unique" },
);
aiReplyJobSchema.index(
  { businessId: 1, status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: "ai_reply_jobs_business_pending" },
);
aiReplyJobSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: "ai_reply_jobs_worker_pending" },
);
aiReplyJobSchema.index(
  { businessId: 1, status: 1, leaseExpiresAt: 1 },
  { name: "ai_reply_jobs_business_expired_leases" },
);
aiReplyJobSchema.index(
  { status: 1, leaseExpiresAt: 1, attemptCount: 1 },
  { name: "ai_reply_jobs_worker_expired_leases" },
);
aiReplyJobSchema.index(
  { businessId: 1, conversationId: 1, createdAt: -1 },
  { name: "ai_reply_jobs_business_conversation" },
);
aiReplyJobSchema.index(
  { businessId: 1, status: 1, createdAt: -1, _id: -1 },
  { name: "ai_reply_jobs_business_review" },
);
aiReplyJobSchema.index(
  { businessId: 1, conversationId: 1 },
  {
    unique: true,
    name: "ai_reply_jobs_one_sending_per_conversation",
    partialFilterExpression: { status: "sending" },
  },
);

export type AiReplyJobDocument = HydratedDocument<AiReplyJobFields>;

export const AiReplyJob =
  (mongoose.models.AiReplyJob as Model<AiReplyJobFields> | undefined) ??
  mongoose.model<AiReplyJobFields>("AiReplyJob", aiReplyJobSchema);
