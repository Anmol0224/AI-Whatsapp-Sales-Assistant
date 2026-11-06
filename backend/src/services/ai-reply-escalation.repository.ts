import { Types } from "mongoose";
import {
  AiReplyEscalation,
  type AiReplyEscalationCategory,
  type AiReplyEscalationReasonCode,
} from "../models/ai-reply-escalation.model.js";
import { CatalogItem } from "../models/catalog-item.model.js";
import { Conversation, type ConversationStatus } from "../models/conversation.model.js";
import { Customer } from "../models/customer.model.js";
import { Faq } from "../models/faq.model.js";
import { Message } from "../models/message.model.js";

/**
 * Owner-facing escalation reads and the explicit owner resolution transition.
 *
 * Escalations are created only by the automatic-reply safety service. This module never
 * creates escalations, never touches AI reply jobs or conversation modes, and never calls
 * WhatsApp: resolving an escalation records the owner's decision and nothing else.
 */

export const AI_REPLY_ESCALATION_PAGE_LIMIT = 50;
export const AI_REPLY_ESCALATION_NOTE_MAX_LENGTH = 500;
const LIST_MESSAGE_PREVIEW_LENGTH = 280;
const EVIDENCE_LABEL_MAX_LENGTH = 200;

export type AiReplyEscalationStatus = "open" | "resolved" | "dismissed";
export type AiReplyEscalationStatusFilter = AiReplyEscalationStatus | "all";
export type AiReplyEscalationResolutionOutcome = Exclude<AiReplyEscalationStatus, "open">;

export interface AiReplyEscalationCustomerSummary {
  profileName?: string;
  phoneNumber?: string;
}

export interface AiReplyEscalationConversationSummary {
  _id: Types.ObjectId;
  status: ConversationStatus;
  customer: AiReplyEscalationCustomerSummary | null;
}

export interface AiReplyEscalationInboundMessage {
  _id: Types.ObjectId;
  text: string;
  timestamp?: Date;
  createdAt: Date;
}

export interface AiReplyEscalationEvidenceSummary {
  kind: "faq" | "catalog_item";
  recordId: Types.ObjectId;
  /** Owner-authored FAQ question or catalog item name; absent when the record no longer exists. */
  label?: string;
}

export interface AiReplyEscalationRecord {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
  category: AiReplyEscalationCategory;
  reasonCode: AiReplyEscalationReasonCode;
  policyVersion?: string;
  expectedPolicyVersion?: string;
  controlVersion?: number;
  expectedControlVersion?: number;
  status: AiReplyEscalationStatus;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiReplyEscalationListItem extends AiReplyEscalationRecord {
  conversation: AiReplyEscalationConversationSummary | null;
  inboundMessage: AiReplyEscalationInboundMessage | null;
}

export interface AiReplyEscalationDetail extends AiReplyEscalationListItem {
  evidence: AiReplyEscalationEvidenceSummary[];
}

export interface AiReplyEscalationStatusCounts {
  open: number;
  resolved: number;
  dismissed: number;
}

export interface ListAiReplyEscalationsInput {
  businessId: Types.ObjectId;
  page: number;
  limit: number;
  status: AiReplyEscalationStatusFilter;
}

export interface ListAiReplyEscalationsResult {
  escalations: AiReplyEscalationListItem[];
  totalItems: number;
}

export type ResolveAiReplyEscalationResult =
  | {
      kind: "resolved";
      escalation: { _id: Types.ObjectId; status: AiReplyEscalationResolutionOutcome; resolvedAt: Date; resolutionNote?: string };
    }
  | { kind: "not_found" }
  | { kind: "already_closed"; status: AiReplyEscalationStatus };

/** Safe owner-visible projection. Internal identifiers such as businessId and resolvedByUserId are excluded. */
const escalationProjection = {
  _id: 1,
  conversationId: 1,
  inboundMessageId: 1,
  category: 1,
  reasonCode: 1,
  policyVersion: 1,
  expectedPolicyVersion: 1,
  controlVersion: 1,
  expectedControlVersion: 1,
  status: 1,
  resolvedAt: 1,
  resolutionNote: 1,
  createdAt: 1,
  updatedAt: 1,
};

type EscalationWithEvidence = AiReplyEscalationRecord & {
  evidence?: Array<{ kind: "faq" | "catalog_item"; recordId: Types.ObjectId }>;
};

function assertPagination(page: number, limit: number): void {
  if (!Number.isSafeInteger(page) || page < 1 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > AI_REPLY_ESCALATION_PAGE_LIMIT ||
    !Number.isSafeInteger((page - 1) * limit)) {
    throw new Error("INVALID_AI_REPLY_ESCALATION_PAGINATION");
  }
}

function uniqueIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  const seen = new Map<string, Types.ObjectId>();
  for (const id of ids) seen.set(id.toString(), id);
  return [...seen.values()];
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join("")}…` : value;
}

/** Attaches business-scoped conversation, customer and inbound-message context to escalations. */
async function attachEscalationContext(
  businessId: Types.ObjectId,
  escalations: AiReplyEscalationRecord[],
  options: { previewOnly: boolean },
): Promise<AiReplyEscalationListItem[]> {
  if (escalations.length === 0) return [];

  const conversationIds = uniqueIds(escalations.map((item) => item.conversationId));
  const inboundMessageIds = uniqueIds(escalations.map((item) => item.inboundMessageId));
  const [conversations, messages] = await Promise.all([
    Conversation.find({ businessId, _id: { $in: conversationIds } })
      .select({ _id: 1, customerId: 1, status: 1 })
      .lean<Array<{ _id: Types.ObjectId; customerId: Types.ObjectId; status: ConversationStatus }>>()
      .exec(),
    Message.find({
      businessId,
      direction: "inbound",
      _id: { $in: inboundMessageIds },
      conversationId: { $in: conversationIds },
    })
      .select({ _id: 1, conversationId: 1, text: 1, timestamp: 1, createdAt: 1 })
      .lean<Array<AiReplyEscalationInboundMessage & { conversationId: Types.ObjectId }>>()
      .exec(),
  ]);

  const customerIds = uniqueIds(conversations.map((conversation) => conversation.customerId));
  const customers = customerIds.length === 0
    ? []
    : await Customer.find({ businessId, _id: { $in: customerIds } })
      .select({ _id: 1, profileName: 1, phoneNumber: 1 })
      .lean<Array<{ _id: Types.ObjectId; profileName?: string; phoneNumber?: string }>>()
      .exec();

  const customersById = new Map(customers.map((customer) => [customer._id.toString(), customer]));
  const conversationsById = new Map(conversations.map((conversation) => [conversation._id.toString(), conversation]));
  const messagesById = new Map(messages.map((message) => [message._id.toString(), message]));

  return escalations.map((escalation) => {
    const conversation = conversationsById.get(escalation.conversationId.toString());
    const customer = conversation ? customersById.get(conversation.customerId.toString()) : undefined;
    const message = messagesById.get(escalation.inboundMessageId.toString());
    const inboundMessage = message && message.conversationId.equals(escalation.conversationId)
      ? {
          _id: message._id,
          text: options.previewOnly ? truncate(message.text, LIST_MESSAGE_PREVIEW_LENGTH) : message.text,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          createdAt: message.createdAt,
        }
      : null;

    return {
      ...escalation,
      conversation: conversation
        ? {
            _id: conversation._id,
            status: conversation.status,
            customer: customer
              ? {
                  ...(customer.profileName ? { profileName: customer.profileName } : {}),
                  ...(customer.phoneNumber ? { phoneNumber: customer.phoneNumber } : {}),
                }
              : null,
          }
        : null,
      inboundMessage,
    };
  });
}

async function describeEvidence(
  businessId: Types.ObjectId,
  evidence: Array<{ kind: "faq" | "catalog_item"; recordId: Types.ObjectId }>,
): Promise<AiReplyEscalationEvidenceSummary[]> {
  if (evidence.length === 0) return [];
  const faqIds = uniqueIds(evidence.filter((item) => item.kind === "faq").map((item) => item.recordId));
  const catalogIds = uniqueIds(evidence.filter((item) => item.kind === "catalog_item").map((item) => item.recordId));
  const [faqs, catalogItems] = await Promise.all([
    faqIds.length === 0
      ? []
      : Faq.find({ businessId, _id: { $in: faqIds } })
        .select({ _id: 1, question: 1 })
        .lean<Array<{ _id: Types.ObjectId; question?: string }>>()
        .exec(),
    catalogIds.length === 0
      ? []
      : CatalogItem.find({ businessId, _id: { $in: catalogIds } })
        .select({ _id: 1, name: 1 })
        .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
        .exec(),
  ]);
  const faqLabels = new Map(faqs.map((faq) => [faq._id.toString(), faq.question]));
  const catalogLabels = new Map(catalogItems.map((item) => [item._id.toString(), item.name]));

  return evidence.map((item) => {
    const label = item.kind === "faq"
      ? faqLabels.get(item.recordId.toString())
      : catalogLabels.get(item.recordId.toString());
    return {
      kind: item.kind,
      recordId: item.recordId,
      ...(typeof label === "string" && label.trim()
        ? { label: truncate(label.trim(), EVIDENCE_LABEL_MAX_LENGTH) }
        : {}),
    };
  });
}

/** Lists escalations for one business with deterministic newest-first pagination. */
export async function listAiReplyEscalations(
  input: ListAiReplyEscalationsInput,
): Promise<ListAiReplyEscalationsResult> {
  assertPagination(input.page, input.limit);
  const filter = {
    businessId: input.businessId,
    ...(input.status === "all" ? {} : { status: input.status }),
  };
  const [escalations, totalItems] = await Promise.all([
    AiReplyEscalation.find(filter)
      .select(escalationProjection)
      .sort({ createdAt: -1, _id: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<AiReplyEscalationRecord[]>()
      .exec(),
    AiReplyEscalation.countDocuments(filter).exec(),
  ]);
  return {
    escalations: await attachEscalationContext(input.businessId, escalations, { previewOnly: true }),
    totalItems,
  };
}

/** Counts escalations by status for one business. */
export async function countAiReplyEscalationsByStatus(
  businessId: Types.ObjectId,
): Promise<AiReplyEscalationStatusCounts> {
  const [open, resolved, dismissed] = await Promise.all([
    AiReplyEscalation.countDocuments({ businessId, status: "open" }).exec(),
    AiReplyEscalation.countDocuments({ businessId, status: "resolved" }).exec(),
    AiReplyEscalation.countDocuments({ businessId, status: "dismissed" }).exec(),
  ]);
  return { open, resolved, dismissed };
}

/** Retrieves one escalation inside the authenticated business, or null when it is not owned. */
export async function findAiReplyEscalation(
  businessId: Types.ObjectId,
  escalationId: Types.ObjectId,
): Promise<AiReplyEscalationDetail | null> {
  const escalation = await AiReplyEscalation.findOne({ _id: escalationId, businessId })
    .select({ ...escalationProjection, evidence: 1 })
    .lean<EscalationWithEvidence>()
    .exec();
  if (!escalation) return null;

  const { evidence = [], ...record } = escalation;
  const [withContext] = await attachEscalationContext(businessId, [record], { previewOnly: false });
  if (!withContext) return null;
  return { ...withContext, evidence: await describeEvidence(businessId, evidence) };
}

/**
 * Records an explicit owner decision on an open escalation.
 *
 * The update is a single conditional write on `status: "open"`, so concurrent or repeated
 * submissions cannot overwrite an earlier decision or its audit fields.
 */
export async function resolveAiReplyEscalation(input: {
  businessId: Types.ObjectId;
  escalationId: Types.ObjectId;
  userId: Types.ObjectId;
  outcome: AiReplyEscalationResolutionOutcome;
  note?: string;
  now?: Date;
}): Promise<ResolveAiReplyEscalationResult> {
  if (input.outcome !== "resolved" && input.outcome !== "dismissed") {
    throw new Error("INVALID_AI_REPLY_ESCALATION_OUTCOME");
  }
  const note = input.note?.trim();
  if (note && Array.from(note).length > AI_REPLY_ESCALATION_NOTE_MAX_LENGTH) {
    throw new Error("INVALID_AI_REPLY_ESCALATION_NOTE");
  }
  const resolvedAt = input.now ?? new Date();

  const updated = await AiReplyEscalation.updateOne(
    { _id: input.escalationId, businessId: input.businessId, status: "open" },
    {
      $set: {
        status: input.outcome,
        resolvedAt,
        resolvedByUserId: input.userId,
        ...(note ? { resolutionNote: note } : {}),
      },
    },
    { runValidators: true },
  ).exec();

  if (updated.matchedCount === 1) {
    return {
      kind: "resolved",
      escalation: {
        _id: input.escalationId,
        status: input.outcome,
        resolvedAt,
        ...(note ? { resolutionNote: note } : {}),
      },
    };
  }

  const existing = await AiReplyEscalation.findOne({ _id: input.escalationId, businessId: input.businessId })
    .select({ _id: 1, status: 1 })
    .lean<{ _id: Types.ObjectId; status: AiReplyEscalationStatus }>()
    .exec();
  return existing ? { kind: "already_closed", status: existing.status } : { kind: "not_found" };
}
