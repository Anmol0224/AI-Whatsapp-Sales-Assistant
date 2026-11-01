import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type ConversationStatus = "open" | "closed";
export type ConversationResponseMode = "human" | "ai";

export interface ConversationFields {
  businessId: Types.ObjectId;
  customerId: Types.ObjectId;
  status: ConversationStatus;
  responseMode: ConversationResponseMode;
  aiControlVersion: number;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new mongoose.Schema<ConversationFields>(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
      required: true,
    },
    responseMode: {
      type: String,
      enum: ["human", "ai"],
      default: "human",
      required: true,
    },
    aiControlVersion: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "aiControlVersion must be a non-negative safe integer.",
      },
      required: true,
    },
    lastMessageAt: { type: Date },
    lastMessagePreview: {
      type: String,
      trim: true,
      maxlength: 280,
    },
  },
  { timestamps: true },
);

conversationSchema.index(
  { businessId: 1, customerId: 1 },
  { unique: true, name: "conversations_business_customer_unique" },
);
conversationSchema.index(
  { businessId: 1, status: 1, lastMessageAt: -1 },
  { name: "conversations_business_status_last_message" },
);

export type ConversationDocument = HydratedDocument<ConversationFields>;

export const Conversation =
  (mongoose.models.Conversation as Model<ConversationFields> | undefined) ??
  mongoose.model<ConversationFields>("Conversation", conversationSchema);
