import { Router, type RequestHandler } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import type { AiReplyJobStatus } from "../../models/ai-reply-job.model.js";
import {
  AI_REPLY_DRAFT_PAGE_LIMIT,
  findAiReplyDraft,
  listAiReplyDrafts,
  listAiReplyDraftsForConversation,
  approveAiReplyDraft,
  rejectAiReplyDraft,
  type AiReplyDraftReviewRecord,
  type ListAiReplyDraftsResult,
} from "../../services/ai-reply-job.repository.js";
import { Conversation } from "../../models/conversation.model.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const jobStatuses = [
  "queued",
  "processing",
  "draft_ready",
  "approved",
  "rejected",
  "sending",
  "sent",
  "send_failed",
  "send_uncertain",
  "failed",
  "cancelled",
] as const satisfies readonly AiReplyJobStatus[];

const querySchema = z
  .object({
    page: z.coerce.number().int().positive().safe().default(1),
    limit: z.coerce.number().int().positive().max(AI_REPLY_DRAFT_PAGE_LIMIT).safe().default(20),
    status: z.enum(jobStatuses).default("draft_ready"),
  })
  .strict()
  .refine((value) => Number.isSafeInteger((value.page - 1) * value.limit), {
    path: ["page"],
    message: "The requested page is too large.",
  });
const approvalBodySchema = z.object({
  approvedText: z.string().trim().min(1).max(4096).optional(),
}).strict();
const rejectionBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

export interface AiDraftsRouteDependencies {
  listDrafts: typeof listAiReplyDrafts;
  listConversationDrafts: typeof listAiReplyDraftsForConversation;
  findDraft: typeof findAiReplyDraft;
  approveDraft: typeof approveAiReplyDraft;
  rejectDraft: typeof rejectAiReplyDraft;
  conversationExists(conversationId: Types.ObjectId, businessId: Types.ObjectId): Promise<boolean>;
}

const mongooseDependencies: AiDraftsRouteDependencies = {
  listDrafts: listAiReplyDrafts,
  listConversationDrafts: listAiReplyDraftsForConversation,
  findDraft: findAiReplyDraft,
  approveDraft: approveAiReplyDraft,
  rejectDraft: rejectAiReplyDraft,
  conversationExists: async (conversationId, businessId) =>
    Boolean(await Conversation.exists({ _id: conversationId, businessId })),
};

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}

function safeDraft(draft: AiReplyDraftReviewRecord) {
  return {
    id: draft._id.toString(),
    conversationId: draft.conversationId.toString(),
    sourceMessage: draft.sourceMessage
      ? {
          id: draft.sourceMessage._id.toString(),
          text: draft.sourceMessage.text,
          ...(draft.sourceMessage.timestamp
            ? { timestamp: draft.sourceMessage.timestamp.toISOString() }
            : {}),
          createdAt: draft.sourceMessage.createdAt.toISOString(),
        }
      : null,
    status: draft.status,
    ...(draft.generatedDraft !== undefined ? { generatedDraft: draft.generatedDraft } : {}),
    ...(draft.approvedText !== undefined ? { approvedText: draft.approvedText } : {}),
    ...(draft.approvalEdited !== undefined ? { approvalEdited: draft.approvalEdited } : {}),
    ...(draft.approvedAt ? { approvedAt: draft.approvedAt.toISOString() } : {}),
    ...(draft.rejectedAt ? { rejectedAt: draft.rejectedAt.toISOString() } : {}),
    ...(draft.rejectionReason !== undefined ? { rejectionReason: draft.rejectionReason } : {}),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function sendDraftList(
  response: import("express").Response,
  result: ListAiReplyDraftsResult,
  page: number,
  limit: number,
): void {
  response.status(200).json({
    success: true,
    drafts: result.drafts.map(safeDraft),
    pagination: {
      page,
      limit,
      totalItems: result.totalItems,
      totalPages: Math.ceil(result.totalItems / limit),
    },
  });
}

export function createAiDraftsRouter(
  dependencies: AiDraftsRouteDependencies = mongooseDependencies,
  authentication: RequestHandler = authenticate,
) {
  const router = Router();
  router.use(authentication);

  router.get("/", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({
        success: false,
        message: "Invalid AI draft filters.",
        errors: validationErrors(parsedQuery.error.issues),
      });
      return;
    }

    const { page, limit, status } = parsedQuery.data;
    try {
      const result = await dependencies.listDrafts({
        businessId: new Types.ObjectId(auth.businessId),
        page,
        limit,
        status,
      });
      sendDraftList(response, result, page, limit);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:draftId", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.draftId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid AI draft ID." });
      return;
    }

    try {
      const draft = await dependencies.findDraft(
        new Types.ObjectId(auth.businessId),
        new Types.ObjectId(parsedId.data),
      );
      if (!draft) {
        response.status(404).json({ success: false, message: "AI draft not found." });
        return;
      }

      response.status(200).json({ success: true, draft: safeDraft(draft) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:draftId/approve", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.draftId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid AI draft ID." });
      return;
    }

    const parsedBody = approvalBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      response.status(400).json({
        success: false,
        message: "Invalid AI draft approval data.",
        errors: validationErrors(parsedBody.error.issues),
      });
      return;
    }

    try {
      const result = await dependencies.approveDraft({
        businessId: new Types.ObjectId(auth.businessId),
        userId: new Types.ObjectId(auth.userId),
        jobId: new Types.ObjectId(parsedId.data),
        ...(parsedBody.data.approvedText !== undefined
          ? { approvedText: parsedBody.data.approvedText }
          : {}),
      });

      if (result.kind === "not_found") {
        response.status(404).json({ success: false, message: "AI draft not found." });
        return;
      }
      if (result.kind !== "approved") {
        const message = result.kind === "mode_changed"
          ? "AI replies are not enabled for this conversation."
          : result.kind === "send_in_progress"
            ? "A WhatsApp send is already in progress for this conversation."
            : result.kind === "stale"
              ? "This AI draft is stale and must be regenerated."
              : "AI draft is no longer available for approval.";
        response.status(409).json({ success: false, message, code: result.kind });
        return;
      }

      response.status(200).json({
        success: true,
        message: "AI draft approved successfully.",
        draft: {
          id: parsedId.data,
          status: "approved",
          approvedText: result.approvedText,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:draftId/reject", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.draftId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid AI draft ID." });
      return;
    }

    const parsedBody = rejectionBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      response.status(400).json({
        success: false,
        message: "Invalid AI draft rejection data.",
        errors: validationErrors(parsedBody.error.issues),
      });
      return;
    }

    try {
      const result = await dependencies.rejectDraft({
        businessId: new Types.ObjectId(auth.businessId),
        userId: new Types.ObjectId(auth.userId),
        jobId: new Types.ObjectId(parsedId.data),
        ...(parsedBody.data.reason !== undefined ? { reason: parsedBody.data.reason } : {}),
      });
      if (result.kind === "not_found") {
        response.status(404).json({ success: false, message: "AI draft not found." });
        return;
      }
      if (result.kind === "conflict") {
        response.status(409).json({
          success: false,
          message: "AI draft is no longer available for rejection.",
          code: "conflict",
        });
        return;
      }

      response.status(200).json({
        success: true,
        message: "AI draft rejected successfully.",
        draft: { id: parsedId.data, status: "rejected" },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createConversationAiDraftsRouter(
  dependencies: AiDraftsRouteDependencies = mongooseDependencies,
  authentication: RequestHandler = authenticate,
) {
  const router = Router({ mergeParams: true });
  router.use(authentication);

  router.get("/", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(
      (request.params as { conversationId?: string }).conversationId,
    );
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid conversation ID." });
      return;
    }

    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({
        success: false,
        message: "Invalid AI draft filters.",
        errors: validationErrors(parsedQuery.error.issues),
      });
      return;
    }

    const businessId = new Types.ObjectId(auth.businessId);
    const conversationId = new Types.ObjectId(parsedId.data);
    const { page, limit, status } = parsedQuery.data;

    try {
      if (!(await dependencies.conversationExists(conversationId, businessId))) {
        response.status(404).json({ success: false, message: "Conversation not found." });
        return;
      }

      const result = await dependencies.listConversationDrafts({
        businessId,
        conversationId,
        page,
        limit,
        status,
      });
      sendDraftList(response, result, page, limit);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAiDraftsRouter();
