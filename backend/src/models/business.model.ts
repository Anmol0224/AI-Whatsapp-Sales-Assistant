import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export interface BusinessWhatsappSettings {
  phoneNumberId?: string;
  displayNumber?: string;
  connectionStatus: string;
  credentialRef?: string;
}

export interface BusinessAiSettings {
  enabledByDefault?: boolean;
  modelIdentifier?: string;
  modelConfiguration?: Record<string, unknown>;
  contextMessageLimit?: number;
  communicationPreferences?: string;
}

export interface BusinessFields {
  ownerUserId: Types.ObjectId;
  name: string;
  description?: string;
  industry?: string;
  contactDetails?: Record<string, unknown>;
  timezone?: string;
  whatsapp: BusinessWhatsappSettings;
  aiSettings?: BusinessAiSettings;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappSettingsSchema = new mongoose.Schema<BusinessWhatsappSettings>(
  {
    phoneNumberId: { type: String, trim: true },
    displayNumber: { type: String, trim: true },
    connectionStatus: { type: String, default: "not_configured", trim: true },
    credentialRef: { type: String, trim: true },
  },
  { _id: false },
);

const aiSettingsSchema = new mongoose.Schema<BusinessAiSettings>(
  {
    enabledByDefault: { type: Boolean },
    modelIdentifier: { type: String, trim: true },
    modelConfiguration: { type: mongoose.Schema.Types.Mixed },
    contextMessageLimit: {
      type: Number,
      min: 1,
      validate: {
        validator: (value: number) => Number.isInteger(value),
        message: "contextMessageLimit must be an integer.",
      },
    },
    communicationPreferences: { type: String, trim: true },
  },
  { _id: false },
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const businessSchema = new mongoose.Schema<BusinessFields>(
  {
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: { type: String, trim: true },
    industry: { type: String, trim: true },
    contactDetails: {
      type: mongoose.Schema.Types.Mixed,
      validate: {
        validator: (value: unknown) => value === undefined || isPlainObject(value),
        message: "contactDetails must be an object.",
      },
    },
    timezone: {
      type: String,
      trim: true,
      validate: {
        validator: isValidTimezone,
        message: "timezone must be a valid IANA timezone.",
      },
    },
    whatsapp: {
      type: whatsappSettingsSchema,
      default: () => ({}),
    },
    aiSettings: { type: aiSettingsSchema },
  },
  { timestamps: true },
);

businessSchema.index(
  { ownerUserId: 1 },
  { unique: true, name: "businesses_owner_user_id_unique" },
);

export type BusinessDocument = HydratedDocument<BusinessFields>;

export const Business =
  (mongoose.models.Business as Model<BusinessFields> | undefined) ??
  mongoose.model<BusinessFields>("Business", businessSchema);
