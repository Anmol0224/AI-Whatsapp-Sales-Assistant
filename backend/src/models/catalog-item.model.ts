import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type CatalogItemKind = "product" | "service";
export type CatalogCurrency = "INR";

export interface CatalogItemFields {
  businessId: Types.ObjectId;
  kind: CatalogItemKind;
  name: string;
  description?: string;
  priceInPaise?: number;
  currency: CatalogCurrency;
  availability?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const catalogItemSchema = new mongoose.Schema<CatalogItemFields>(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    kind: {
      type: String,
      enum: ["product", "service"],
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: { type: String, trim: true },
    priceInPaise: {
      type: Number,
      min: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "priceInPaise must be a non-negative safe integer.",
      },
    },
    currency: {
      type: String,
      enum: ["INR"],
      default: "INR",
      required: true,
    },
    availability: { type: String, trim: true },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true },
);

catalogItemSchema.index(
  { businessId: 1, isActive: 1, kind: 1 },
  { name: "catalog_items_business_active_kind" },
);

export type CatalogItemDocument = HydratedDocument<CatalogItemFields>;

export const CatalogItem =
  (mongoose.models.CatalogItem as Model<CatalogItemFields> | undefined) ??
  mongoose.model<CatalogItemFields>("CatalogItem", catalogItemSchema);
