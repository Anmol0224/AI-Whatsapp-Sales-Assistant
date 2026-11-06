import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { Business, type BusinessAiSettings } from "../../models/business.model.js";
import {
  getWhatsAppPhoneNumberMetadata,
  WhatsAppPhoneMetadataError,
  type WhatsAppPhoneMetadata,
  type WhatsAppPhoneMetadataErrorCategory,
} from "../../services/whatsapp-cloud-api.service.js";

const profileProjection = {
  name: 1,
  description: 1,
  industry: 1,
  "contactDetails.phone": 1,
  "contactDetails.email": 1,
  "contactDetails.website": 1,
  "contactDetails.address": 1,
  timezone: 1,
};
const whatsappProjection = {
  "whatsapp.phoneNumberId": 1,
  "whatsapp.displayNumber": 1,
  "whatsapp.connectionStatus": 1,
  "whatsapp.verifiedPhoneNumberId": 1,
  "whatsapp.lastVerificationAt": 1,
  "whatsapp.verificationFailureCategory": 1,
  "whatsapp.verifiedDisplayNumber": 1,
  "whatsapp.verifiedName": 1,
  "whatsapp.qualityRating": 1,
};
const automaticRepliesProjection = {
  "aiSettings.automaticRepliesEnabled": 1,
  "aiSettings.automaticRepliesEnabledAt": 1,
  "aiSettings.automaticRepliesEnabledByUserId": 1,
  "aiSettings.automaticRepliesDisabledAt": 1,
  "aiSettings.automaticRepliesDisabledByUserId": 1,
  "aiSettings.automaticRepliesPolicyVersion": 1,
};

type AutomaticRepliesSettings = Pick<
  BusinessAiSettings,
  | "automaticRepliesEnabled"
  | "automaticRepliesEnabledAt"
  | "automaticRepliesEnabledByUserId"
  | "automaticRepliesDisabledAt"
  | "automaticRepliesDisabledByUserId"
  | "automaticRepliesPolicyVersion"
>;

interface BusinessAiSettingsRecord {
  aiSettings?: AutomaticRepliesSettings;
}

export interface BusinessAiSettingsRouteDependencies {
  findAiSettings(businessId: Types.ObjectId, ownerUserId: Types.ObjectId): Promise<BusinessAiSettingsRecord | null>;
  updateAutomaticReplies(
    businessId: Types.ObjectId,
    ownerUserId: Types.ObjectId,
    enabled: boolean,
    changedAt: Date,
    policyVersion: string,
  ): Promise<BusinessAiSettingsRecord | null>;
}

interface WhatsAppSettingsRecord {
  whatsapp?: {
    phoneNumberId?: string;
    displayNumber?: string;
    connectionStatus?: string;
    verifiedPhoneNumberId?: string;
    lastVerificationAt?: Date;
    verificationFailureCategory?: string;
    verifiedDisplayNumber?: string;
    verifiedName?: string;
    qualityRating?: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  };
}

export interface BusinessWhatsAppVerificationRouteDependencies {
  findWhatsAppSettings(businessId: Types.ObjectId, ownerUserId: Types.ObjectId): Promise<WhatsAppSettingsRecord | null>;
  saveWhatsAppSettings(
    businessId: Types.ObjectId,
    ownerUserId: Types.ObjectId,
    phoneNumberId: string,
    displayNumber?: string,
  ): Promise<WhatsAppSettingsRecord | null>;
  beginWhatsAppVerification(
    businessId: Types.ObjectId,
    ownerUserId: Types.ObjectId,
    phoneNumberId: string,
    attemptedAt: Date,
  ): Promise<boolean>;
  completeWhatsAppVerification(
    businessId: Types.ObjectId,
    ownerUserId: Types.ObjectId,
    phoneNumberId: string,
    metadata: WhatsAppPhoneMetadata,
    verifiedAt: Date,
  ): Promise<WhatsAppSettingsRecord | null>;
  failWhatsAppVerification(
    businessId: Types.ObjectId,
    ownerUserId: Types.ObjectId,
    phoneNumberId: string,
    category: WhatsAppVerificationFailureCategory,
    failedAt: Date,
  ): Promise<WhatsAppSettingsRecord | null>;
  verifyPhoneNumber(phoneNumberId: string): Promise<WhatsAppPhoneMetadata>;
}

type WhatsAppVerificationFailureCategory = WhatsAppPhoneMetadataErrorCategory | "phone_number_id_mismatch";

const mongooseWhatsAppVerificationDependencies: BusinessWhatsAppVerificationRouteDependencies = {
  findWhatsAppSettings: (businessId, ownerUserId) =>
    Business.findOne({ _id: businessId, ownerUserId })
      .select(whatsappProjection)
      .lean<WhatsAppSettingsRecord>()
      .exec(),
  saveWhatsAppSettings: (businessId, ownerUserId, phoneNumberId, displayNumber) =>
    Business.findOneAndUpdate(
      { _id: businessId, ownerUserId },
      {
        $set: {
          "whatsapp.phoneNumberId": phoneNumberId,
          "whatsapp.connectionStatus": "configured_not_verified",
          ...(displayNumber !== undefined ? { "whatsapp.displayNumber": displayNumber } : {}),
        },
        $unset: {
          "whatsapp.verifiedPhoneNumberId": "",
          "whatsapp.lastVerificationAt": "",
          "whatsapp.verificationFailureCategory": "",
          "whatsapp.verifiedDisplayNumber": "",
          "whatsapp.verifiedName": "",
          "whatsapp.qualityRating": "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select(whatsappProjection).lean<WhatsAppSettingsRecord>().exec(),
  beginWhatsAppVerification: async (businessId, ownerUserId, phoneNumberId, attemptedAt) => {
    const result = await Business.findOneAndUpdate(
      { _id: businessId, ownerUserId, "whatsapp.phoneNumberId": phoneNumberId },
      {
        $set: { "whatsapp.connectionStatus": "configured_not_verified", "whatsapp.lastVerificationAt": attemptedAt },
        $unset: {
          "whatsapp.verifiedPhoneNumberId": "",
          "whatsapp.verificationFailureCategory": "",
          "whatsapp.verifiedDisplayNumber": "",
          "whatsapp.verifiedName": "",
          "whatsapp.qualityRating": "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select({ _id: 1 }).lean().exec();
    return result !== null;
  },
  completeWhatsAppVerification: (businessId, ownerUserId, phoneNumberId, metadata, verifiedAt) =>
    Business.findOneAndUpdate(
      { _id: businessId, ownerUserId, "whatsapp.phoneNumberId": phoneNumberId },
      {
        $set: {
          "whatsapp.connectionStatus": "verified",
          "whatsapp.verifiedPhoneNumberId": metadata.id,
          "whatsapp.lastVerificationAt": verifiedAt,
          ...(metadata.displayPhoneNumber ? { "whatsapp.verifiedDisplayNumber": metadata.displayPhoneNumber } : {}),
          ...(metadata.verifiedName ? { "whatsapp.verifiedName": metadata.verifiedName } : {}),
          ...(metadata.qualityRating ? { "whatsapp.qualityRating": metadata.qualityRating } : {}),
        },
        $unset: { "whatsapp.verificationFailureCategory": "" },
      },
      { returnDocument: "after", runValidators: true },
    ).select(whatsappProjection).lean<WhatsAppSettingsRecord>().exec(),
  failWhatsAppVerification: (businessId, ownerUserId, phoneNumberId, category, failedAt) =>
    Business.findOneAndUpdate(
      { _id: businessId, ownerUserId, "whatsapp.phoneNumberId": phoneNumberId },
      {
        $set: {
          "whatsapp.connectionStatus": "verification_failed",
          "whatsapp.verificationFailureCategory": category,
          "whatsapp.lastVerificationAt": failedAt,
        },
        $unset: {
          "whatsapp.verifiedPhoneNumberId": "",
          "whatsapp.verifiedDisplayNumber": "",
          "whatsapp.verifiedName": "",
          "whatsapp.qualityRating": "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select(whatsappProjection).lean<WhatsAppSettingsRecord>().exec(),
  verifyPhoneNumber: getWhatsAppPhoneNumberMetadata,
};

const mongooseAiSettingsDependencies: BusinessAiSettingsRouteDependencies = {
  findAiSettings: (businessId, ownerUserId) =>
    Business.findOne({ _id: businessId, ownerUserId })
      .select(automaticRepliesProjection)
      .lean<BusinessAiSettingsRecord>()
      .exec(),
  updateAutomaticReplies: async (businessId, ownerUserId, enabled, changedAt, policyVersion) => {
    const updates: Record<string, unknown> = {
      "aiSettings.automaticRepliesEnabled": enabled,
      "aiSettings.automaticRepliesPolicyVersion": policyVersion,
    };
    if (enabled) {
      updates["aiSettings.automaticRepliesEnabledAt"] = changedAt;
      updates["aiSettings.automaticRepliesEnabledByUserId"] = ownerUserId;
    } else {
      updates["aiSettings.automaticRepliesDisabledAt"] = changedAt;
      updates["aiSettings.automaticRepliesDisabledByUserId"] = ownerUserId;
    }

    return Business.findOneAndUpdate(
      { _id: businessId, ownerUserId },
      {
        $set: updates,
        $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
      },
      { returnDocument: "after", runValidators: true },
    )
      .select(automaticRepliesProjection)
      .lean<BusinessAiSettingsRecord>()
      .exec();
  },
};

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const contactDetailsPatchSchema = z
  .object({
    phone: z.string().trim().min(1).max(40).optional(),
    email: z.string().trim().email().max(254).optional(),
    website: z.string().trim().url().max(2048).optional(),
    address: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one contact detail.",
  });

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    industry: z.string().trim().min(1).max(100).optional(),
    contactDetails: contactDetailsPatchSchema.optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimezone, "timezone must be a valid IANA timezone.")
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one profile field to update.",
  });

const whatsappSettingsPatchSchema = z
  .object({
    phoneNumberId: z.string().trim().min(1).max(32).regex(/^\d+$/),
    displayNumber: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^\+?[1-9]\d{6,14}$/)
      .optional(),
  })
  .strict();
const automaticRepliesPatchSchema = z
  .object({ automaticRepliesEnabled: z.boolean() })
  .strict();

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

function safeBusinessProfile(business: {
  _id: { toString(): string };
  name: string;
  description?: string;
  industry?: string;
  contactDetails?: Record<string, unknown>;
  timezone?: string;
}) {
  const storedContactDetails = business.contactDetails;
  const contactDetails =
    storedContactDetails &&
    typeof storedContactDetails === "object" &&
    !Array.isArray(storedContactDetails)
      ? storedContactDetails
      : {};

  return {
    id: business._id.toString(),
    name: business.name,
    description: business.description,
    industry: business.industry,
    contactDetails: {
      phone: typeof contactDetails.phone === "string" ? contactDetails.phone : undefined,
      email: typeof contactDetails.email === "string" ? contactDetails.email : undefined,
      website: typeof contactDetails.website === "string" ? contactDetails.website : undefined,
      address: typeof contactDetails.address === "string" ? contactDetails.address : undefined,
    },
    timezone: business.timezone,
  };
}

function safeWhatsAppSettings(business: {
  whatsapp?: {
    phoneNumberId?: string;
    displayNumber?: string;
    connectionStatus?: string;
    verifiedPhoneNumberId?: string;
    lastVerificationAt?: Date;
    verificationFailureCategory?: string;
    verifiedDisplayNumber?: string;
    verifiedName?: string;
    qualityRating?: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  };
}) {
  const phoneNumberId = business.whatsapp?.phoneNumberId?.trim() || undefined;
  const displayNumber = business.whatsapp?.displayNumber?.trim() || undefined;
  const storedStatus = business.whatsapp?.connectionStatus;
  const verificationMatchesSavedId = Boolean(
    phoneNumberId && storedStatus === "verified" && business.whatsapp?.verifiedPhoneNumberId === phoneNumberId,
  );
  const connectionStatus = !phoneNumberId
    ? "not_configured"
    : storedStatus === "verified" && !verificationMatchesSavedId
      ? "configured_not_verified"
      : storedStatus ?? "configured_not_verified";

  return {
    phoneNumberId,
    displayNumber,
    connectionStatus,
    ...(verificationMatchesSavedId ? { verifiedPhoneNumberId: business.whatsapp?.verifiedPhoneNumberId } : {}),
    ...(phoneNumberId && business.whatsapp?.lastVerificationAt ? { lastVerificationAt: business.whatsapp.lastVerificationAt.toISOString() } : {}),
    ...(phoneNumberId && business.whatsapp?.verificationFailureCategory ? { verificationFailureCategory: business.whatsapp.verificationFailureCategory } : {}),
    ...(verificationMatchesSavedId && business.whatsapp?.verifiedDisplayNumber ? { verifiedDisplayNumber: business.whatsapp.verifiedDisplayNumber } : {}),
    ...(verificationMatchesSavedId && business.whatsapp?.verifiedName ? { verifiedName: business.whatsapp.verifiedName } : {}),
    ...(verificationMatchesSavedId && business.whatsapp?.qualityRating ? { qualityRating: business.whatsapp.qualityRating } : {}),
  };
}

function whatsappVerificationFailureMessage(category: WhatsAppVerificationFailureCategory): string {
  switch (category) {
    case "missing_access_token":
      return "WhatsApp verification is not configured on the server. Contact support.";
    case "missing_graph_api_version":
      return "WhatsApp verification is not configured on the server. Contact support.";
    case "provider_authentication_failed":
      return "Meta rejected the server access token. Ask an administrator to check the WhatsApp credentials.";
    case "missing_permissions":
      return "The Meta access token lacks permission to read this WhatsApp number.";
    case "invalid_phone_number_id":
    case "invalid_phone_number_id_at_provider":
      return "Meta could not find this Phone Number ID. Check the saved ID in your Meta app.";
    case "provider_rate_limited":
      return "Meta is temporarily rate limiting verification. Wait a moment and try again.";
    case "provider_timeout":
      return "Meta did not respond before the verification timed out. Try again later.";
    case "provider_network_error":
    case "provider_unavailable":
      return "Meta could not be reached right now. Try again later.";
    case "unexpected_provider_response":
      return "Meta returned an unexpected verification response. Check the configuration or try again later.";
    case "phone_number_id_mismatch":
      return "Meta returned a different Phone Number ID. The saved configuration was not verified.";
  }
}

function safeAutomaticRepliesSettings(business: BusinessAiSettingsRecord) {
  const settings = business.aiSettings;
  return {
    automaticRepliesEnabled: settings?.automaticRepliesEnabled === true,
    ...(settings?.automaticRepliesEnabledAt
      ? { automaticRepliesEnabledAt: settings.automaticRepliesEnabledAt.toISOString() }
      : {}),
    ...(settings?.automaticRepliesDisabledAt
      ? { automaticRepliesDisabledAt: settings.automaticRepliesDisabledAt.toISOString() }
      : {}),
    ...(settings?.automaticRepliesPolicyVersion
      ? { automaticRepliesPolicyVersion: settings.automaticRepliesPolicyVersion }
      : {}),
  };
}

export function createBusinessRouter(
  aiSettingsDependencies: BusinessAiSettingsRouteDependencies = mongooseAiSettingsDependencies,
  authentication: RequestHandler = authenticate,
  isAutomaticSendEnabled: () => boolean = () => env.AI_AUTOMATIC_SEND_ENABLED,
  whatsappVerificationDependencies: BusinessWhatsAppVerificationRouteDependencies = mongooseWhatsAppVerificationDependencies,
) {
  const businessRouter = Router();
  businessRouter.use(authentication);

businessRouter.get("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  try {
    const business = await Business.findOne({
      _id: auth.businessId,
      ownerUserId: auth.userId,
    }).select(profileProjection);

    if (!business) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      business: safeBusinessProfile(business),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.patch("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = profilePatchSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid business profile data.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  const updates: Record<string, string> = {};
  const { name, description, industry, contactDetails, timezone } = parsedBody.data;

  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (industry !== undefined) updates.industry = industry;
  if (timezone !== undefined) updates.timezone = timezone;

  if (contactDetails) {
    for (const [field, value] of Object.entries(contactDetails)) {
      if (value !== undefined) updates[`contactDetails.${field}`] = value;
    }
  }

  try {
    const business = await Business.findOneAndUpdate(
      { _id: auth.businessId, ownerUserId: auth.userId },
      { $set: updates },
      { returnDocument: "after", runValidators: true },
    ).select(profileProjection);

    if (!business) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      business: safeBusinessProfile(business),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.get("/whatsapp", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  try {
    const business = await Business.findOne({
      _id: auth.businessId,
      ownerUserId: auth.userId,
    }).select(whatsappProjection);

    if (!business) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      whatsapp: safeWhatsAppSettings(business),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.patch("/whatsapp", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = whatsappSettingsPatchSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid WhatsApp number configuration.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  const { phoneNumberId, displayNumber } = parsedBody.data;

  try {
    const business = await whatsappVerificationDependencies.saveWhatsAppSettings(
      new Types.ObjectId(auth.businessId),
      new Types.ObjectId(auth.userId),
      phoneNumberId,
      displayNumber,
    );

    if (!business) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      whatsapp: safeWhatsAppSettings(business),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.post("/whatsapp/verify", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = z.object({}).strict().safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({ success: false, message: "Verification request must have an empty JSON body." });
    return;
  }

  const businessId = new Types.ObjectId(auth.businessId);
  const ownerUserId = new Types.ObjectId(auth.userId);
  try {
    const current = await whatsappVerificationDependencies.findWhatsAppSettings(businessId, ownerUserId);
    if (!current) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    const phoneNumberId = current.whatsapp?.phoneNumberId?.trim();
    if (!phoneNumberId) {
      response.status(409).json({
        success: false,
        message: "Save a WhatsApp Phone Number ID before verifying the configuration.",
        code: "missing_phone_number_id",
      });
      return;
    }

    const attemptedAt = new Date();
    const began = await whatsappVerificationDependencies.beginWhatsAppVerification(
      businessId,
      ownerUserId,
      phoneNumberId,
      attemptedAt,
    );
    if (!began) {
      response.status(409).json({ success: false, message: "WhatsApp settings changed. Reload and try again.", code: "configuration_changed" });
      return;
    }

    let metadata: WhatsAppPhoneMetadata;
    try {
      metadata = await whatsappVerificationDependencies.verifyPhoneNumber(phoneNumberId);
    } catch (error) {
      const category: WhatsAppVerificationFailureCategory = error instanceof WhatsAppPhoneMetadataError
        ? error.category
        : "unexpected_provider_response";
      const failed = await whatsappVerificationDependencies.failWhatsAppVerification(
        businessId,
        ownerUserId,
        phoneNumberId,
        category,
        new Date(),
      );
      if (!failed) {
        response.status(409).json({ success: false, message: "WhatsApp settings changed during verification. Reload the page.", code: "configuration_changed" });
        return;
      }
      response.status(category === "provider_timeout" ? 504 : category === "provider_unavailable" || category === "provider_network_error" ? 502 : 422).json({
        success: false,
        message: whatsappVerificationFailureMessage(category),
        code: category,
        whatsapp: safeWhatsAppSettings(failed),
      });
      return;
    }

    if (metadata.id !== phoneNumberId) {
      const category = "phone_number_id_mismatch" as const;
      const failed = await whatsappVerificationDependencies.failWhatsAppVerification(
        businessId,
        ownerUserId,
        phoneNumberId,
        category,
        new Date(),
      );
      if (!failed) {
        response.status(409).json({ success: false, message: "WhatsApp settings changed during verification. Reload the page.", code: "configuration_changed" });
        return;
      }
      response.status(502).json({
        success: false,
        message: whatsappVerificationFailureMessage(category),
        code: category,
        whatsapp: safeWhatsAppSettings(failed),
      });
      return;
    }

    const verified = await whatsappVerificationDependencies.completeWhatsAppVerification(
      businessId,
      ownerUserId,
      phoneNumberId,
      metadata,
      new Date(),
    );
    if (!verified) {
      response.status(409).json({ success: false, message: "WhatsApp settings changed during verification. Reload the page.", code: "configuration_changed" });
      return;
    }
    response.status(200).json({
      success: true,
      message: "WhatsApp Cloud API configuration verified successfully.",
      whatsapp: safeWhatsAppSettings(verified),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.get("/ai-settings", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  try {
    const settings = await aiSettingsDependencies.findAiSettings(
      new Types.ObjectId(auth.businessId),
      new Types.ObjectId(auth.userId),
    );
    if (!settings) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      aiSettings: safeAutomaticRepliesSettings(settings),
      automaticSendAvailable: isAutomaticSendEnabled(),
    });
  } catch (error) {
    next(error);
  }
});

businessRouter.patch("/ai-settings", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = automaticRepliesPatchSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid business AI settings.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  if (parsedBody.data.automaticRepliesEnabled && !isAutomaticSendEnabled()) {
    response.status(409).json({
      success: false,
      message: "Automatic replies are not enabled for this application.",
      code: "automatic_send_disabled",
    });
    return;
  }

  try {
    const changedAt = new Date();
    const settings = await aiSettingsDependencies.updateAutomaticReplies(
      new Types.ObjectId(auth.businessId),
      new Types.ObjectId(auth.userId),
      parsedBody.data.automaticRepliesEnabled,
      changedAt,
      randomUUID(),
    );
    if (!settings) {
      response.status(404).json({ success: false, message: "Business not found." });
      return;
    }

    response.status(200).json({
      success: true,
      message: "Business AI settings updated successfully.",
      aiSettings: safeAutomaticRepliesSettings(settings),
      automaticSendAvailable: isAutomaticSendEnabled(),
    });
  } catch (error) {
    next(error);
  }
});

  return businessRouter;
}

export default createBusinessRouter();
