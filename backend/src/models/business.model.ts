import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export interface BusinessWhatsappSettings {
  phoneNumberId?: string;
  displayNumber?: string;
  connectionStatus: string;
  credentialRef?: string;
  verifiedPhoneNumberId?: string;
  lastVerificationAt?: Date;
  verificationFailureCategory?: string;
  verifiedDisplayNumber?: string;
  verifiedName?: string;
  qualityRating?: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
}

export interface BusinessAiSettings {
  enabledByDefault?: boolean;
  modelIdentifier?: string;
  modelConfiguration?: Record<string, unknown>;
  contextMessageLimit?: number;
  communicationPreferences?: string;
  automaticRepliesEnabled?: boolean;
  automaticRepliesEnabledAt?: Date;
  automaticRepliesEnabledByUserId?: Types.ObjectId;
  automaticRepliesDisabledAt?: Date;
  automaticRepliesDisabledByUserId?: Types.ObjectId;
  automaticRepliesPolicyVersion?: string;
  /** Internal fence shared by automatic-send reservations and policy/source mutations. */
  automaticRepliesControlVersion?: number;
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
    verifiedPhoneNumberId: { type: String, trim: true },
    lastVerificationAt: { type: Date },
    verificationFailureCategory: {
      type: String,
      trim: true,
      enum: [
        "missing_access_token",
        "missing_graph_api_version",
        "provider_authentication_failed",
        "missing_permissions",
        "invalid_phone_number_id",
        "invalid_phone_number_id_at_provider",
        "provider_rate_limited",
        "provider_timeout",
        "provider_network_error",
        "provider_unavailable",
        "unexpected_provider_response",
        "phone_number_id_mismatch",
      ],
    },
    verifiedDisplayNumber: { type: String, trim: true, maxlength: 32 },
    verifiedName: { type: String, trim: true, maxlength: 256 },
    qualityRating: { type: String, enum: ["GREEN", "YELLOW", "RED", "UNKNOWN"] },
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
    automaticRepliesEnabled: { type: Boolean, default: false },
    automaticRepliesEnabledAt: { type: Date },
    automaticRepliesEnabledByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    automaticRepliesDisabledAt: { type: Date },
    automaticRepliesDisabledByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    automaticRepliesPolicyVersion: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 64,
      match: [/^[A-Za-z0-9._-]+$/, "automaticRepliesPolicyVersion must be a safe version identifier."],
    },
    automaticRepliesControlVersion: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value),
        message: "automaticRepliesControlVersion must be a non-negative safe integer.",
      },
    },
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
    aiSettings: { type: aiSettingsSchema, default: () => ({}) },
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
