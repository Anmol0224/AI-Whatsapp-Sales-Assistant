import { Router, type RequestHandler } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import {
  AI_REPLY_ESCALATION_NOTE_MAX_LENGTH,
  AI_REPLY_ESCALATION_PAGE_LIMIT,
  countAiReplyEscalationsByStatus,
  findAiReplyEscalation,
  listAiReplyEscalations,
  resolveAiReplyEscalation,
  type AiReplyEscalationDetail,
  type AiReplyEscalationListItem,
  type AiReplyEscalationStatusCounts,
} from "../../services/ai-reply-escalation.repository.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const statusFilterValues = ["open", "resolved", "dismissed", "all"] as const;
const resolutionOutcomeValues = ["resolved", "dismissed"] as const;

const listQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().safe().default(1),
    limit: z.coerce.number().int().positive().max(AI_REPLY_ESCALATION_PAGE_LIMIT).safe().default(20),
    status: z.enum(statusFilterValues).default("open"),
  })
  .strict()
  .refine((value) => Number.isSafeInteger((value.page - 1) * value.limit), {
    path: ["page"],
    message: "The requested page is too large.",
  });

const resolveBodySchema = z
  .object({
    outcome: z.enum(resolutionOutcomeValues).default("resolved"),
    note: z.string().trim().max(AI_REPLY_ESCALATION_NOTE_MAX_LENGTH).optional(),
  })
  .strict();

export interface AiEscalationsRouteDependencies {
  listEscalations: typeof listAiReplyEscalations;
  countEscalations: typeof countAiReplyEscalationsByStatus;
  findEscalation: typeof findAiReplyEscalation;
  resolveEscalation: typeof resolveAiReplyEscalation;
}

const mongooseDependencies: AiEscalationsRouteDependencies = {
  listEscalations: listAiReplyEscalations,
  countEscalations: countAiReplyEscalationsByStatus,
  findEscalation: findAiReplyEscalation,
  resolveEscalation: resolveAiReplyEscalation,
};

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

function safeEscalationBase(escalation: AiReplyEscalationListItem) {
  return {
    id: escalation._id.toString(),
    conversationId: escalation.conversationId.toString(),
    conversation: escalation.conversation
      ? {
          id: escalation.conversation._id.toString(),
          status: escalation.conversation.status,
          customer: escalation.conversation.customer
            ? {
                ...(escalation.conversation.customer.profileName !== undefined
                  ? { profileName: escalation.conversation.customer.profileName }
                  : {}),
                ...(escalation.conversation.customer.phoneNumber !== undefined
                  ? { phoneNumber: escalation.conversation.customer.phoneNumber }
                  : {}),
              }
            : null,
        }
      : null,
    inboundMessage: escalation.inboundMessage
      ? {
          id: escalation.inboundMessage._id.toString(),
          text: escalation.inboundMessage.text,
          ...(escalation.inboundMessage.timestamp
            ? { timestamp: escalation.inboundMessage.timestamp.toISOString() }
            : {}),
          createdAt: escalation.inboundMessage.createdAt.toISOString(),
        }
      : null,
    category: escalation.category,
    reasonCode: escalation.reasonCode,
    ...(escalation.policyVersion !== undefined ? { policyVersion: escalation.policyVersion } : {}),
    ...(escalation.expectedPolicyVersion !== undefined
      ? { expectedPolicyVersion: escalation.expectedPolicyVersion }
      : {}),
    ...(escalation.controlVersion !== undefined ? { controlVersion: escalation.controlVersion } : {}),
    ...(escalation.expectedControlVersion !== undefined
      ? { expectedControlVersion: escalation.expectedControlVersion }
      : {}),
    status: escalation.status,
    ...(escalation.resolvedAt ? { resolvedAt: escalation.resolvedAt.toISOString() } : {}),
    ...(escalation.resolutionNote !== undefined ? { resolutionNote: escalation.resolutionNote } : {}),
    createdAt: escalation.createdAt.toISOString(),
    updatedAt: escalation.updatedAt.toISOString(),
  };
}

function safeEscalationDetail(escalation: AiReplyEscalationDetail) {
  return {
    ...safeEscalationBase(escalation),
    evidence: escalation.evidence.map((item) => ({
      kind: item.kind,
      recordId: item.recordId.toString(),
      ...(item.label !== undefined ? { label: item.label } : {}),
    })),
  };
}

function safeCounts(counts: AiReplyEscalationStatusCounts) {
  return {
    pending: counts.open,
    resolved: counts.resolved,
    dismissed: counts.dismissed,
    total: counts.open + counts.resolved + counts.dismissed,
  };
}

export function createAiEscalationsRouter(
  dependencies: AiEscalationsRouteDependencies = mongooseDependencies,
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

    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({
        success: false,
        message: "Invalid escalation filters.",
        errors: validationErrors(parsedQuery.error.issues),
      });
      return;
    }

    const { page, limit, status } = parsedQuery.data;
    const businessId = new Types.ObjectId(auth.businessId);
    try {
      const [result, counts] = await Promise.all([
        dependencies.listEscalations({ businessId, page, limit, status }),
        dependencies.countEscalations(businessId),
      ]);
      response.status(200).json({
        success: true,
        escalations: result.escalations.map(safeEscalationBase),
        counts: safeCounts(counts),
        pagination: {
          page,
          limit,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:escalationId", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.escalationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid escalation ID." });
      return;
    }

    try {
      const escalation = await dependencies.findEscalation(
        new Types.ObjectId(auth.businessId),
        new Types.ObjectId(parsedId.data),
      );
      if (!escalation) {
        response.status(404).json({ success: false, message: "Escalation not found." });
        return;
      }

      response.status(200).json({
        success: true,
        escalation: safeEscalationDetail(escalation),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:escalationId/resolve", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.escalationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid escalation ID." });
      return;
    }

    const parsedBody = resolveBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      response.status(400).json({
        success: false,
        message: "Invalid escalation resolution data.",
        errors: validationErrors(parsedBody.error.issues),
      });
      return;
    }

    const note = parsedBody.data.note?.trim();
    try {
      const result = await dependencies.resolveEscalation({
        businessId: new Types.ObjectId(auth.businessId),
        escalationId: new Types.ObjectId(parsedId.data),
        userId: new Types.ObjectId(auth.userId),
        outcome: parsedBody.data.outcome,
        ...(note ? { note } : {}),
      });

      if (result.kind === "not_found") {
        response.status(404).json({ success: false, message: "Escalation not found." });
        return;
      }

      if (result.kind === "already_closed") {
        response.status(409).json({
          success: false,
          message:
            result.status === "dismissed"
              ? "This escalation has already been dismissed."
              : "This escalation has already been resolved.",
          code: "already_closed",
        });
        return;
      }

      response.status(200).json({
        success: true,
        message:
          result.escalation.status === "dismissed"
            ? "Escalation dismissed. No WhatsApp message was sent."
            : "Escalation marked as resolved. No WhatsApp message was sent.",
        escalation: {
          id: result.escalation._id.toString(),
          status: result.escalation.status,
          resolvedAt: result.escalation.resolvedAt.toISOString(),
          ...(result.escalation.resolutionNote !== undefined
            ? { resolutionNote: result.escalation.resolutionNote }
            : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAiEscalationsRouter();
