import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export interface FaqFields {
  businessId: Types.ObjectId;
  question: string;
  answer: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const faqSchema = new mongoose.Schema<FaqFields>(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true },
);

faqSchema.index(
  { businessId: 1, isActive: 1 },
  { name: "faqs_business_active" },
);

export type FaqDocument = HydratedDocument<FaqFields>;

export const Faq =
  (mongoose.models.Faq as Model<FaqFields> | undefined) ?? mongoose.model<FaqFields>("Faq", faqSchema);
