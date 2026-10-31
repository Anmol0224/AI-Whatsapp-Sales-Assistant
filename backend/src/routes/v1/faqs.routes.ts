import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import { Faq } from "../../models/faq.model.js";

const faqsRouter = Router();
const faqIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "A valid FAQ ID is required.");
const faqTextSchema = z.string().trim().min(1);

const createFaqSchema = z
  .object({
    question: faqTextSchema,
    answer: faqTextSchema,
  })
  .strict();

const updateFaqSchema = z
  .object({
    question: faqTextSchema.optional(),
    answer: faqTextSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one FAQ field to update.",
  });

const listQuerySchema = z
  .object({
    isActive: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  })
  .strict();

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

function safeFaq(faq: {
  _id: { toString(): string };
  question: string;
  answer: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: faq._id.toString(),
    question: faq.question,
    answer: faq.answer,
    isActive: faq.isActive,
    createdAt: faq.createdAt,
    updatedAt: faq.updatedAt,
  };
}

faqsRouter.use(authenticate);

faqsRouter.get("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedQuery = listQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ filters.",
      errors: validationErrors(parsedQuery.error.issues),
    });
    return;
  }

  try {
    const faqs = await Faq.find({
      businessId: auth.businessId,
      isActive: parsedQuery.data.isActive ?? true,
    }).sort({ createdAt: -1 });

    response.status(200).json({
      success: true,
      faqs: faqs.map(safeFaq),
    });
  } catch (error) {
    next(error);
  }
});

faqsRouter.post("/", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedBody = createFaqSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ data.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  try {
    const faq = await Faq.create({
      ...parsedBody.data,
      businessId: auth.businessId,
      isActive: true,
    });
    response.status(201).json({ success: true, faq: safeFaq(faq) });
  } catch (error) {
    next(error);
  }
});

faqsRouter.get("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = faqIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  try {
    const faq = await Faq.findOne({ _id: parsedId.data, businessId: auth.businessId });

    if (!faq) {
      response.status(404).json({ success: false, message: "FAQ not found." });
      return;
    }

    response.status(200).json({ success: true, faq: safeFaq(faq) });
  } catch (error) {
    next(error);
  }
});

faqsRouter.patch("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = faqIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  const parsedBody = updateFaqSchema.safeParse(request.body);
  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ update.",
      errors: validationErrors(parsedBody.error.issues),
    });
    return;
  }

  try {
    const faq = await Faq.findOneAndUpdate(
      { _id: parsedId.data, businessId: auth.businessId },
      { $set: parsedBody.data },
      { new: true, runValidators: true },
    );

    if (!faq) {
      response.status(404).json({ success: false, message: "FAQ not found." });
      return;
    }

    response.status(200).json({ success: true, faq: safeFaq(faq) });
  } catch (error) {
    next(error);
  }
});

faqsRouter.delete("/:id", async (request, response, next) => {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  const parsedId = faqIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    response.status(400).json({
      success: false,
      message: "Invalid FAQ ID.",
      errors: validationErrors(parsedId.error.issues),
    });
    return;
  }

  try {
    const faq = await Faq.findOneAndUpdate(
      { _id: parsedId.data, businessId: auth.businessId },
      { $set: { isActive: false } },
      { new: true, runValidators: true },
    );

    if (!faq) {
      response.status(404).json({ success: false, message: "FAQ not found." });
      return;
    }

    response.status(200).json({
      success: true,
      message: "FAQ deactivated successfully.",
      faq: safeFaq(faq),
    });
  } catch (error) {
    next(error);
  }
});

export default faqsRouter;
