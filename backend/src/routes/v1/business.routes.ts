import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import { Business } from "../../models/business.model.js";

const businessRouter = Router();
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

businessRouter.use(authenticate);

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
      { new: true, runValidators: true },
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

export default businessRouter;
