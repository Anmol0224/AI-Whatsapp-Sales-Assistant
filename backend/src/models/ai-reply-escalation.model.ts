import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type AiReplyEscalationCategory =
  | "needs_owner_review"
  | "unsupported_information"
  | "ambiguous_request"
  | "missing_business_information"
  | "policy_conflict"
  | "invalid_or_empty_response";

export type AiReplyEscalationReasonCode =
  | "automatic_replies_disabled"
  | "source_message_unavailable"
  | "conversation_mode_mismatch"
  | "stale_control_version"
  | "stale_policy_version"
  | "business_evidence_unavailable"
  | "evidence_incomplete"
  | "faq_not_exact"
  | "faq_answers_conflict"
  | "catalog_intent_unsupported"
  | "catalog_item_missing"
  | "catalog_item_ambiguous"
  | "catalog_price_missing"
  | "faq_exact_answer"
  | "catalog_price_response"
  | "catalog_listing_response"
  | "generated_response_mismatch"
  | "generated_response_invalid"
  | "provider_generation_failed"
  | "validation_failed";

export interface AiReplyEscalationEvidenceReference {
  kind: "faq" | "catalog_item";
  recordId: Types.ObjectId;
}

export interface AiReplyEscalationFields {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
  category: AiReplyEscalationCategory;
  reasonCode: AiReplyEscalationReasonCode;
  policyVersion?: string;
  expectedPolicyVersion?: string;
  controlVersion?: number;
  expectedControlVersion?: number;
  evidence: AiReplyEscalationEvidenceReference[];
  status: "open" | "resolved" | "dismissed";
  resolvedAt?: Date;
  resolvedByUserId?: Types.ObjectId;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const evidenceReferenceSchema = new mongoose.Schema<AiReplyEscalationEvidenceReference>(
  {
    kind: { type: String, enum: ["faq", "catalog_item"], required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false },
);

const aiReplyEscalationSchema = new mongoose.Schema<AiReplyEscalationFields>(
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
    category: {
      type: String,
      enum: [
        "needs_owner_review",
        "unsupported_information",
        "ambiguous_request",
        "missing_business_information",
        "policy_conflict",
        "invalid_or_empty_response",
      ],
      required: true,
    },
    reasonCode: {
      type: String,
      enum: [
        "automatic_replies_disabled",
        "source_message_unavailable",
        "conversation_mode_mismatch",
        "stale_control_version",
        "stale_policy_version",
        "business_evidence_unavailable",
        "evidence_incomplete",
        "faq_not_exact",
        "faq_answers_conflict",
        "catalog_intent_unsupported",
        "catalog_item_missing",
        "catalog_item_ambiguous",
        "catalog_price_missing",
        "faq_exact_answer",
        "catalog_price_response",
        "catalog_listing_response",
        "generated_response_mismatch",
        "generated_response_invalid",
        "provider_generation_failed",
        "validation_failed",
      ],
      required: true,
    },
    policyVersion: {
      type: String,
      trim: true,
      maxlength: 64,
      match: /^[A-Za-z0-9._-]+$/,
    },
    expectedPolicyVersion: {
      type: String,
      trim: true,
      maxlength: 64,
      match: /^[A-Za-z0-9._-]+$/,
    },
    controlVersion: {
      type: Number,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "controlVersion must be a safe integer." },
    },
    expectedControlVersion: {
      type: Number,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "expectedControlVersion must be a safe integer." },
    },
    evidence: {
      type: [evidenceReferenceSchema],
      default: [],
      validate: {
        validator: (value: AiReplyEscalationEvidenceReference[]) => value.length <= 50,
        message: "Escalation evidence references must be bounded.",
      },
    },
    status: {
      type: String,
      enum: ["open", "resolved", "dismissed"],
      default: "open",
      required: true,
    },
    resolvedAt: { type: Date },
    resolvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolutionNote: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    collection: "ai_reply_escalations",
    // Escalation indexes are provisioned only by the explicit guarded migration.
    autoIndex: false,
    autoCreate: false,
  },
);

aiReplyEscalationSchema.index(
  { businessId: 1, inboundMessageId: 1 },
  { unique: true, name: "ai_reply_escalations_business_inbound_unique" },
);
aiReplyEscalationSchema.index(
  { businessId: 1, status: 1, createdAt: -1, _id: -1 },
  { name: "ai_reply_escalations_business_status_created" },
);

export type AiReplyEscalationDocument = HydratedDocument<AiReplyEscalationFields>;

export const AiReplyEscalation =
  (mongoose.models.AiReplyEscalation as Model<AiReplyEscalationFields> | undefined) ??
  mongoose.model<AiReplyEscalationFields>("AiReplyEscalation", aiReplyEscalationSchema);
