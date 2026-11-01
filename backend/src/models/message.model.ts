import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type MessageDirection = "inbound" | "outbound";
export type MessageType = "text";
export type MessageStatus = "received" | "sent" | "delivered" | "read" | "failed";

export interface MessageFields {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  customerId: Types.ObjectId;
  aiReplyJobId?: Types.ObjectId;
  direction: MessageDirection;
  messageType: MessageType;
  text: string;
  providerMessageId?: string;
  status: MessageStatus;
  timestamp?: Date;
  providerStatusAt?: Date;
  providerErrorCode?: string;
  providerErrorTitle?: string;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new mongoose.Schema<MessageFields>(
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
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    aiReplyJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiReplyJob",
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["text"],
      default: "text",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 4096,
    },
    providerMessageId: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 256,
    },
    status: {
      type: String,
      enum: ["received", "sent", "delivered", "read", "failed"],
      required: true,
    },
    timestamp: { type: Date },
    providerStatusAt: { type: Date },
    providerErrorCode: { type: String, trim: true, maxlength: 64 },
    providerErrorTitle: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

messageSchema.index(
  { businessId: 1, providerMessageId: 1 },
  {
    unique: true,
    name: "messages_business_provider_id_unique",
    partialFilterExpression: {
      providerMessageId: { $type: "string", $gt: "" },
    },
  },
);
messageSchema.index(
  { businessId: 1, conversationId: 1, createdAt: -1 },
  { name: "messages_business_conversation_history" },
);
messageSchema.index(
  { businessId: 1, createdAt: -1 },
  { name: "messages_business_created_at" },
);
messageSchema.index(
  { businessId: 1, aiReplyJobId: 1 },
  {
    unique: true,
    name: "messages_business_ai_reply_job_unique",
    partialFilterExpression: { aiReplyJobId: { $type: "objectId" } },
  },
);

export type MessageDocument = HydratedDocument<MessageFields>;

export const Message =
  (mongoose.models.Message as Model<MessageFields> | undefined) ??
  mongoose.model<MessageFields>("Message", messageSchema);
