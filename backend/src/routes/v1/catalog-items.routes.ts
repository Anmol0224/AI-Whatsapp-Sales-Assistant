import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import { CatalogItem } from "../../models/catalog-item.model.js";

const catalogItemsRouter = Router();
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "A valid catalog item ID is required.");
const kindSchema = z.enum(["product", "service"]);
const nameSchema = z.string().trim().min(1).max(150);
const descriptionSchema = z.string().trim().max(2000);
const priceSchema = z.number().int().safe().min(0);
const currencySchema = z.literal("INR");
const availabilitySchema = z.string().trim().max(1000);

const createItemSchema = z
  .object({
    kind: kindSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    priceInPaise: priceSchema.optional(),
    currency: currencySchema.optional().default("INR"),
    availability: availabilitySchema.optional(),
  })
  .strict();

const updateItemSchema = z
  .object({
    kind: kindSchema.optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    priceInPaise: priceSchema.optional(),
    currency: currencySchema.optional(),
    availability: availabilitySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one catalog item field to update.",
  });

const listQuerySchema = z
  .object({
    kind: kindSchema.optional(),
    isActive: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    page: z.coerce.number().int().positive().safe().default(1),
    limit: z.coerce.number().int().positive().max(100).safe().default(20),
  })
  .strict()
  .refine((value) => Number.isSafeInteger((value.page - 1) * value.limit), {
    path: ["page"],
    message: "The requested page is too large.",
  });

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

function safeCatalogItem(item: {
  _id: { toString(): string };
  kind: "product" | "service";
  name: string;
  description?: string;
  priceInPaise?: number;
  currency: "INR";
  availability?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item._id.toString(),
    kind: item.kind,
    name: item.name,
    description: item.description,
    priceInPaise: item.priceInPaise,
    currency: item.currency,
    availability: item.availability,
    isActive: item.isActive,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

catalogItemsRouter.use(authenticate);

catalogItemsRouter.get("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedQuery = listQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog filters.",
      errors: validationErrors(parsedQuery.error.issues),
    });
    return;
  }

  const { kind, isActive, page, limit } = parsedQuery.data;
  const filters = {
    businessId: auth.businessId,
    isActive: isActive ?? true,
    ...(kind ? { kind } : {}),
  };

  try {
    const [items, totalItems] = await Promise.all([
      CatalogItem.find(filters)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CatalogItem.countDocuments(filters),
    ]);

    response.status(200).json({
      success: true,
      items: items.map(safeCatalogItem),
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

catalogItemsRouter.post("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = createItemSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog item data.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  try {
    const item = await CatalogItem.create({
      ...parsedBody.data,
      businessId: auth.businessId,
      isActive: true,
    });
    response.status(201).json({ success: true, item: safeCatalogItem(item) });
  } catch (error) {
    next(error);
  }
});

catalogItemsRouter.get("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = objectIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog item ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  try {
    const item = await CatalogItem.findOne({
      _id: parsedId.data,
      businessId: auth.businessId,
    });

    if (!item) {
      response.status(404).json({ success: false, message: "Catalog item not found." });
      return;
    }

    response.status(200).json({ success: true, item: safeCatalogItem(item) });
  } catch (error) {
    next(error);
  }
});

catalogItemsRouter.patch("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = objectIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog item ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  const parsedBody = updateItemSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog item update.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  try {
    const item = await CatalogItem.findOneAndUpdate(
      { _id: parsedId.data, businessId: auth.businessId },
      { $set: parsedBody.data },
      { new: true, runValidators: true },
    );

    if (!item) {
      response.status(404).json({ success: false, message: "Catalog item not found." });
      return;
    }

    response.status(200).json({ success: true, item: safeCatalogItem(item) });
  } catch (error) {
    next(error);
  }
});

catalogItemsRouter.delete("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = objectIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid catalog item ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  try {
    const item = await CatalogItem.findOneAndUpdate(
      { _id: parsedId.data, businessId: auth.businessId },
      { $set: { isActive: false } },
      { new: true, runValidators: true },
    );

    if (!item) {
      response.status(404).json({ success: false, message: "Catalog item not found." });
      return;
    }

    response.status(200).json({
      success: true,
      message: "Catalog item deactivated successfully.",
      item: safeCatalogItem(item),
    });
  } catch (error) {
    next(error);
  }
});

export default catalogItemsRouter;
