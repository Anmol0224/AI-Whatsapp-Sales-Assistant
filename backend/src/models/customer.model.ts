import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export interface CustomerFields {
  businessId: Types.ObjectId;
  phoneNumber: string;
  profileName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new mongoose.Schema<CustomerFields>(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      match: [/^[1-9]\d{6,14}$/, "phoneNumber must be a normalized international number without a plus sign."],
    },
    profileName: {
      type: String,
      trim: true,
      maxlength: 100,
    },
  },
  { timestamps: true },
);

customerSchema.index(
  { businessId: 1, phoneNumber: 1 },
  { unique: true, name: "customers_business_phone_unique" },
);

export type CustomerDocument = HydratedDocument<CustomerFields>;

export const Customer =
  (mongoose.models.Customer as Model<CustomerFields> | undefined) ??
  mongoose.model<CustomerFields>("Customer", customerSchema);
