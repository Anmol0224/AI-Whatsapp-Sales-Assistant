import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type AiReplyJobStatus = "queued" | "processing" | "draft_ready" | "failed" | "cancelled";
export type AiReplyJobErrorCode =
  | "context_unavailable"
  | "provider_unavailable"
  | "provider_timeout"
  | "database_unavailable"
  | "invalid_output"
  | "internal_error";

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
      enum: ["queued", "processing", "draft_ready", "failed", "cancelled"],
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

export type AiReplyJobDocument = HydratedDocument<AiReplyJobFields>;

export const AiReplyJob =
  (mongoose.models.AiReplyJob as Model<AiReplyJobFields> | undefined) ??
  mongoose.model<AiReplyJobFields>("AiReplyJob", aiReplyJobSchema);
