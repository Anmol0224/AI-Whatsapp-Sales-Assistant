import { Router, type RequestHandler } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.middleware.js";
import { Business, type BusinessDocument } from "../../models/business.model.js";
import { Conversation, type ConversationStatus } from "../../models/conversation.model.js";
import { Customer } from "../../models/customer.model.js";
import { Message, type MessageDocument, type MessageFields } from "../../models/message.model.js";
import {
  sendWhatsAppTextMessage,
  WhatsAppCloudApiError,
} from "../../services/whatsapp-cloud-api.service.js";
import { setConversationResponseMode } from "../../services/ai-reply-job.repository.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const paginationSchema = z
  .object({
    page: z.coerce.number().int().positive().safe().default(1),
    limit: z.coerce.number().int().positive().max(100).safe().default(20),
  })
  .strict()
  .refine((value) => Number.isSafeInteger((value.page - 1) * value.limit), {
    path: ["page"],
    message: "The requested page is too large.",
  });
const sendMessageBodySchema = z
  .object({ text: z.string().trim().min(1).max(4096) })
  .strict();
const responseModeBodySchema = z
  .object({ responseMode: z.enum(["human", "ai"]) })
  .strict();

interface ConversationRecord {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
}

interface CustomerRecord {
  phoneNumber: string;
}

interface ConversationSummaryUpdate {
  lastMessageAt: Date;
  lastMessagePreview: string;
}

interface ConversationListRecord {
  _id: Types.ObjectId;
  status: ConversationStatus;
  lastMessagePreview?: string;
  lastMessageAt?: Date;
  lastActivityAt: Date;
  customer?: {
    profileName?: string;
    phoneNumber?: string;
  };
}

interface PaginatedResult<T> {
  items: T[];
  totalItems: number;
}

export interface ConversationsRouteDependencies {
  listConversations(
    businessId: Types.ObjectId,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<ConversationListRecord>>;
  findConversation(
    conversationId: Types.ObjectId,
    businessId: Types.ObjectId,
  ): Promise<ConversationRecord | null>;
  listMessages(
    conversationId: Types.ObjectId,
    businessId: Types.ObjectId,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<MessageDocument>>;
  findCustomer(customerId: Types.ObjectId, businessId: Types.ObjectId): Promise<CustomerRecord | null>;
  findBusiness(businessId: Types.ObjectId, userId: Types.ObjectId): Promise<BusinessDocument | null>;
  sendText: typeof sendWhatsAppTextMessage;
  createMessage(data: Omit<MessageFields, "createdAt" | "updatedAt">): Promise<MessageDocument>;
  findMessageByProviderId(
    businessId: Types.ObjectId,
    providerMessageId: string,
  ): Promise<MessageDocument | null>;
  updateConversationSummary(
    conversationId: Types.ObjectId,
    businessId: Types.ObjectId,
    summary: ConversationSummaryUpdate,
  ): Promise<boolean>;
  getResponseMode(
    conversationId: Types.ObjectId,
    businessId: Types.ObjectId,
  ): Promise<{ responseMode: "human" | "ai" } | null>;
  changeResponseMode(
    businessId: Types.ObjectId,
    conversationId: Types.ObjectId,
    responseMode: "human" | "ai",
  ): ReturnType<typeof setConversationResponseMode>;
}

const mongooseDependencies: ConversationsRouteDependencies = {
  listConversations: async (businessId, page, limit) => {
    const offset = (page - 1) * limit;
    const [result] = await Conversation.aggregate<{
      conversations: ConversationListRecord[];
      metadata: { totalItems: number }[];
    }>([
      { $match: { businessId } },
      { $addFields: { lastActivityAt: { $ifNull: ["$lastMessageAt", "$updatedAt"] } } },
      { $sort: { lastActivityAt: -1, _id: -1 } },
      {
        $facet: {
          metadata: [{ $count: "totalItems" }],
          conversations: [
            { $skip: offset },
            { $limit: limit },
            {
              $lookup: {
                from: Customer.collection.name,
                let: { customerId: "$customerId", businessId: "$businessId" },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ["$_id", "$$customerId"] },
                          { $eq: ["$businessId", "$$businessId"] },
                        ],
                      },
                    },
                  },
                  { $project: { _id: 0, profileName: 1, phoneNumber: 1 } },
                  { $limit: 1 },
                ],
                as: "customer",
              },
            },
            { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                _id: 1,
                status: 1,
                lastMessagePreview: 1,
                lastMessageAt: 1,
                lastActivityAt: 1,
                customer: 1,
              },
            },
          ],
        },
      },
    ]).exec();

    return {
      items: result?.conversations ?? [],
      totalItems: result?.metadata[0]?.totalItems ?? 0,
    };
  },
  findConversation: (conversationId, businessId) =>
    Conversation.findOne({ _id: conversationId, businessId })
      .select({ _id: 1, customerId: 1 })
      .exec(),
  listMessages: async (conversationId, businessId, page, limit) => {
    const filters = { conversationId, businessId };
    const [messages, totalItems] = await Promise.all([
      Message.find(filters)
        .select({
          _id: 1,
          direction: 1,
          messageType: 1,
          text: 1,
          status: 1,
          providerErrorCode: 1,
          providerErrorTitle: 1,
          timestamp: 1,
          createdAt: 1,
        })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      Message.countDocuments(filters),
    ]);

    return { items: messages, totalItems };
  },
  findCustomer: (customerId, businessId) =>
    Customer.findOne({ _id: customerId, businessId })
      .select({ phoneNumber: 1 })
      .exec(),
  findBusiness: (businessId, userId) =>
    Business.findOne({ _id: businessId, ownerUserId: userId })
      .select({ "whatsapp.phoneNumberId": 1 })
      .exec(),
  sendText: sendWhatsAppTextMessage,
  createMessage: (data) => Message.create(data),
  findMessageByProviderId: (businessId, providerMessageId) =>
    Message.findOne({ businessId, providerMessageId }).exec(),
  updateConversationSummary: async (conversationId, businessId, summary) => {
    const result = await Conversation.updateOne(
      { _id: conversationId, businessId },
      { $set: summary },
      { runValidators: true },
    );
    return result.matchedCount === 1;
  },
  getResponseMode: async (conversationId, businessId) =>
    Conversation.findOne({ _id: conversationId, businessId })
      .select({ _id: 1, responseMode: 1 })
      .lean<{ responseMode: "human" | "ai" }>()
      .exec(),
  changeResponseMode: setConversationResponseMode,
};

function validationErrors(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

function safeMessage(message: MessageDocument) {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    customerId: message.customerId.toString(),
    direction: message.direction,
    messageType: message.messageType,
    text: message.text,
    providerMessageId: message.providerMessageId,
    status: message.status,
    timestamp: message.timestamp?.toISOString(),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function safeHistoryMessage(message: MessageDocument) {
  return {
    id: message._id.toString(),
    direction: message.direction,
    messageType: message.messageType,
    text: message.text,
    status: message.status,
    ...(message.providerErrorCode
      ? { providerErrorCode: message.providerErrorCode.slice(0, 64) }
      : {}),
    ...(message.providerErrorTitle
      ? { providerErrorTitle: message.providerErrorTitle.slice(0, 200) }
      : {}),
    timestamp: message.timestamp?.toISOString(),
    createdAt: message.createdAt.toISOString(),
  };
}

function safeConversation(conversation: ConversationListRecord) {
  return {
    id: conversation._id.toString(),
    customer: conversation.customer
      ? {
          profileName: conversation.customer.profileName,
          phoneNumber: conversation.customer.phoneNumber,
        }
      : undefined,
    status: conversation.status,
    lastMessagePreview: conversation.lastMessagePreview,
    lastActivityAt: conversation.lastActivityAt.toISOString(),
  };
}

function mayHaveBeenAccepted(response: import("express").Response): void {
  response.status(503).json({
    success: false,
    message:
      "WhatsApp may have accepted this message, but local persistence did not complete. Check the conversation before retrying.",
  });
}

export function createConversationsRouter(
  dependencies: ConversationsRouteDependencies = mongooseDependencies,
  authentication: RequestHandler = authenticate,
) {
  const conversationsRouter = Router();
  conversationsRouter.use(authentication);

  conversationsRouter.get("/:conversationId/response-mode", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.conversationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid conversation ID." });
      return;
    }

    try {
      const conversation = await dependencies.getResponseMode(
        new Types.ObjectId(parsedId.data),
        new Types.ObjectId(auth.businessId),
      );
      if (!conversation) {
        response.status(404).json({ success: false, message: "Conversation not found." });
        return;
      }

      response.status(200).json({
        success: true,
        conversation: { id: parsedId.data, responseMode: conversation.responseMode },
      });
    } catch (error) {
      next(error);
    }
  });

  conversationsRouter.patch("/:conversationId/response-mode", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.conversationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid conversation ID." });
      return;
    }

    const parsedBody = responseModeBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      response.status(400).json({
        success: false,
        message: "Invalid conversation response mode.",
        errors: validationErrors(parsedBody.error.issues),
      });
      return;
    }

    try {
      const result = await dependencies.changeResponseMode(
        new Types.ObjectId(auth.businessId),
        new Types.ObjectId(parsedId.data),
        parsedBody.data.responseMode,
      );
      if (result.kind === "not_found") {
        response.status(404).json({ success: false, message: "Conversation not found." });
        return;
      }
      if (result.kind === "send_in_progress") {
        response.status(409).json({
          success: false,
          message: "A WhatsApp send is already in progress for this conversation.",
          code: "send_in_progress",
        });
        return;
      }
      if (result.kind === "conflict") {
        response.status(409).json({
          success: false,
          message: "Conversation response mode could not be changed.",
          code: "conflict",
        });
        return;
      }

      response.status(200).json({
        success: true,
        message: result.kind === "already_set"
          ? "Conversation response mode is already set."
          : "Conversation response mode updated successfully.",
        conversation: {
          id: parsedId.data,
          responseMode: result.responseMode,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  conversationsRouter.get("/", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedQuery = paginationSchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({
        success: false,
        message: "Invalid conversation filters.",
        errors: validationErrors(parsedQuery.error.issues),
      });
      return;
    }

    const { page, limit } = parsedQuery.data;
    try {
      const result = await dependencies.listConversations(
        new Types.ObjectId(auth.businessId),
        page,
        limit,
      );

      response.status(200).json({
        success: true,
        conversations: result.items.map(safeConversation),
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

  conversationsRouter.get("/:conversationId/messages", async (request, response, next) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.conversationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid conversation ID." });
      return;
    }

    const parsedQuery = paginationSchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({
        success: false,
        message: "Invalid message history filters.",
        errors: validationErrors(parsedQuery.error.issues),
      });
      return;
    }

    const businessId = new Types.ObjectId(auth.businessId);
    const conversationId = new Types.ObjectId(parsedId.data);
    const { page, limit } = parsedQuery.data;

    try {
      const conversation = await dependencies.findConversation(conversationId, businessId);
      if (!conversation) {
        response.status(404).json({ success: false, message: "Conversation not found." });
        return;
      }

      const result = await dependencies.listMessages(
        conversationId,
        businessId,
        page,
        limit,
      );

      response.status(200).json({
        success: true,
        messages: result.items.slice().reverse().map(safeHistoryMessage),
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

  conversationsRouter.post("/:conversationId/messages", async (request, response) => {
    const auth = request.auth;
    if (!auth) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const parsedId = objectIdSchema.safeParse(request.params.conversationId);
    if (!parsedId.success) {
      response.status(400).json({ success: false, message: "Invalid conversation ID." });
      return;
    }

    const parsedBody = sendMessageBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      response.status(400).json({
        success: false,
        message: "Invalid message data.",
        errors: validationErrors(parsedBody.error.issues),
      });
      return;
    }

    const businessId = new Types.ObjectId(auth.businessId);
    const userId = new Types.ObjectId(auth.userId);
    const conversationId = new Types.ObjectId(parsedId.data);

    try {
      const conversation = await dependencies.findConversation(conversationId, businessId);
      if (!conversation) {
        response.status(404).json({ success: false, message: "Conversation not found." });
        return;
      }

      const customer = await dependencies.findCustomer(conversation.customerId, businessId);
      if (!customer) {
        response.status(404).json({ success: false, message: "Conversation customer not found." });
        return;
      }

      const business = await dependencies.findBusiness(businessId, userId);
      if (!business) {
        response.status(404).json({ success: false, message: "Business not found." });
        return;
      }

      let providerMessageId: string;
      try {
        const sendResult = await dependencies.sendText(business, customer.phoneNumber, parsedBody.data.text);
        providerMessageId = sendResult.providerMessageId;
      } catch (error) {
        if (error instanceof WhatsAppCloudApiError) {
          if (
            error.category === "provider_http_error" &&
            (error.providerStatusCode ?? 0) < 500
          ) {
            response.status(502).json({
              success: false,
              message: "WhatsApp did not accept the message.",
            });
            return;
          }

          if (
            error.category === "provider_network_error" ||
            error.category === "provider_timeout" ||
            error.category === "invalid_provider_response" ||
            error.category === "provider_http_error"
          ) {
            response.status(502).json({
              success: false,
              message: "Could not confirm whether WhatsApp accepted the message. Check the conversation before retrying.",
            });
            return;
          }

          response.status(503).json({
            success: false,
            message: "WhatsApp message sending is not configured correctly.",
          });
          return;
        }

        response.status(502).json({
          success: false,
          message: "Could not confirm whether WhatsApp accepted the message. Check the conversation before retrying.",
        });
        return;
      }

      let message: MessageDocument;
      try {
        message = await dependencies.createMessage({
          businessId,
          conversationId,
          customerId: conversation.customerId,
          direction: "outbound",
          messageType: "text",
          text: parsedBody.data.text,
          providerMessageId,
          status: "sent",
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          try {
            const existingMessage = await dependencies.findMessageByProviderId(
              businessId,
              providerMessageId,
            );
            if (
              existingMessage &&
              existingMessage.conversationId.toString() === conversationId.toString() &&
              existingMessage.direction === "outbound" &&
              existingMessage.text === parsedBody.data.text
            ) {
              response.status(200).json({
                success: true,
                message: "Message was already recorded.",
                data: { message: safeMessage(existingMessage) },
              });
              return;
            }
          } catch {
            // Keep provider and database error details out of the HTTP response.
          }
        }

        mayHaveBeenAccepted(response);
        return;
      }

      try {
        const updated = await dependencies.updateConversationSummary(
          conversationId,
          businessId,
          {
            lastMessageAt: message.timestamp ?? message.createdAt,
            lastMessagePreview: message.text.slice(0, 280),
          },
        );
        if (!updated) {
          mayHaveBeenAccepted(response);
          return;
        }
      } catch {
        mayHaveBeenAccepted(response);
        return;
      }

      response.status(201).json({
        success: true,
        message: "WhatsApp message sent successfully.",
        data: { message: safeMessage(message) },
      });
    } catch {
      response.status(500).json({
        success: false,
        message: "Unable to process the message request.",
      });
    }
  });

  return conversationsRouter;
}

export default createConversationsRouter();
