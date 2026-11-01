import { Types } from "mongoose";
import { Business } from "../models/business.model.js";
import { CatalogItem } from "../models/catalog-item.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Customer } from "../models/customer.model.js";
import { Faq } from "../models/faq.model.js";
import { Message } from "../models/message.model.js";

export const DEFAULT_BUSINESS_CONTEXT_LIMITS = {
  recentMessages: 12,
  catalogItems: 30,
  faqs: 20,
  maxSerializedBytes: 16_384,
} as const;

const MAX_TRIGGER_MESSAGE_BYTES = 6_000;
const CONTEXT_SIZE_RESERVE_BYTES = 256;
const ALLOWED_OUTBOUND_HISTORY_STATUSES = ["sent", "delivered", "read"] as const;

export type ContextObjectId = Types.ObjectId | string;

export interface BusinessContextLimits {
  recentMessages: number;
  catalogItems: number;
  faqs: number;
  maxSerializedBytes: number;
}

export interface BusinessAiContext {
  business: {
    name: string;
    industry?: string;
    description?: string;
    contactDetails?: {
      phone?: string;
      email?: string;
      website?: string;
      address?: string;
    };
  };
  customer?: { displayName: string };
  catalogItems: Array<{
    kind: "product" | "service";
    name: string;
    description?: string;
    priceInPaise?: number;
    currency?: "INR";
    availabilityNote?: string;
  }>;
  faqs: Array<{ question: string; answer: string }>;
  recentMessages: Array<{
    direction: "inbound" | "outbound";
    text: string;
    createdAt: string;
  }>;
  latestCustomerMessage: { text: string; createdAt: string };
  coverage: {
    businessProfileMayBeIncomplete: boolean;
    catalogMayBeIncomplete: boolean;
    faqsMayBeIncomplete: boolean;
    historyMayBeIncomplete: boolean;
  };
}

export type BusinessContextUnavailableReason =
  | "invalid_reference"
  | "business_not_found"
  | "conversation_not_found"
  | "trigger_message_not_found"
  | "business_profile_incomplete"
  | "trigger_message_too_large"
  | "insufficient_business_knowledge"
  | "context_size_exceeded"
  | "context_unavailable";

export type BusinessContextResult =
  | { status: "ready"; context: BusinessAiContext; serializedBytes: number }
  | { status: "unavailable"; reason: BusinessContextUnavailableReason };

interface BusinessRecord {
  _id: ContextObjectId;
  name?: unknown;
  industry?: unknown;
  description?: unknown;
  contactDetails?: unknown;
}

interface ConversationRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  customerId: ContextObjectId;
}

interface CustomerRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  profileName?: unknown;
}

interface InboundMessageRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  conversationId: ContextObjectId;
  customerId: ContextObjectId;
  direction: unknown;
  messageType: unknown;
  text?: unknown;
  createdAt: Date;
}

interface CatalogRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  kind?: unknown;
  name?: unknown;
  description?: unknown;
  priceInPaise?: unknown;
  currency?: unknown;
  availability?: unknown;
  isActive?: unknown;
}

interface FaqRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  question?: unknown;
  answer?: unknown;
  isActive?: unknown;
  createdAt?: Date;
}

interface HistoryMessageRecord {
  _id: ContextObjectId;
  businessId: ContextObjectId;
  conversationId: ContextObjectId;
  customerId: ContextObjectId;
  direction?: unknown;
  messageType?: unknown;
  status?: unknown;
  text?: unknown;
  createdAt?: Date;
}

export interface BusinessContextRepository {
  findBusiness(businessId: Types.ObjectId): Promise<BusinessRecord | null>;
  findConversation(
    businessId: Types.ObjectId,
    conversationId: Types.ObjectId,
  ): Promise<ConversationRecord | null>;
  findCustomer(
    businessId: Types.ObjectId,
    customerId: Types.ObjectId,
  ): Promise<CustomerRecord | null>;
  findInboundMessage(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    customerId: Types.ObjectId;
    inboundMessageId: Types.ObjectId;
  }): Promise<InboundMessageRecord | null>;
  listActiveCatalogItems(
    businessId: Types.ObjectId,
    limit: number,
  ): Promise<CatalogRecord[]>;
  listActiveFaqs(businessId: Types.ObjectId, limit: number): Promise<FaqRecord[]>;
  listRecentMessages(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    customerId: Types.ObjectId;
    before: InboundMessageRecord;
    limit: number;
  }): Promise<HistoryMessageRecord[]>;
}

const mongooseRepository: BusinessContextRepository = {
  findBusiness: (businessId) =>
    Business.findOne({ _id: businessId })
      // Free-form communicationPreferences has no dedicated validation or update API, so it is deliberately excluded.
      .select({ _id: 1, name: 1, industry: 1, description: 1, contactDetails: 1 })
      .lean<BusinessRecord>()
      .exec(),
  findConversation: (businessId, conversationId) =>
    Conversation.findOne({ _id: conversationId, businessId })
      .select({ _id: 1, businessId: 1, customerId: 1 })
      .lean<ConversationRecord>()
      .exec(),
  findCustomer: (businessId, customerId) =>
    Customer.findOne({ _id: customerId, businessId })
      .select({ _id: 1, businessId: 1, profileName: 1 })
      .lean<CustomerRecord>()
      .exec(),
  findInboundMessage: ({ businessId, conversationId, customerId, inboundMessageId }) =>
    Message.findOne({
      _id: inboundMessageId,
      businessId,
      conversationId,
      customerId,
      direction: "inbound",
      messageType: "text",
    })
      .select({
        _id: 1,
        businessId: 1,
        conversationId: 1,
        customerId: 1,
        direction: 1,
        messageType: 1,
        text: 1,
        createdAt: 1,
      })
      .lean<InboundMessageRecord>()
      .exec(),
  listActiveCatalogItems: (businessId, limit) =>
    CatalogItem.find({ businessId, isActive: true })
      .select({
        _id: 1,
        businessId: 1,
        kind: 1,
        name: 1,
        description: 1,
        priceInPaise: 1,
        currency: 1,
        availability: 1,
        isActive: 1,
      })
      .sort({ kind: 1, _id: 1 })
      .limit(limit)
      .lean<CatalogRecord[]>()
      .exec(),
  listActiveFaqs: (businessId, limit) =>
    Faq.find({ businessId, isActive: true })
      .select({ _id: 1, businessId: 1, question: 1, answer: 1, isActive: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: 1 })
      .limit(limit)
      .lean<FaqRecord[]>()
      .exec(),
  listRecentMessages: ({ businessId, conversationId, customerId, before, limit }) =>
    Message.find({
      businessId,
      conversationId,
      customerId,
      messageType: "text",
      _id: { $ne: before._id },
      $or: [
        { createdAt: { $lt: before.createdAt } },
        { createdAt: before.createdAt, _id: { $lt: before._id } },
      ],
      $and: [
        {
          $or: [
            { direction: "inbound" },
            { direction: "outbound", status: { $in: ALLOWED_OUTBOUND_HISTORY_STATUSES } },
          ],
        },
      ],
    })
      .select({
        _id: 1,
        businessId: 1,
        conversationId: 1,
        customerId: 1,
        direction: 1,
        messageType: 1,
        status: 1,
        text: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean<HistoryMessageRecord[]>()
      .exec(),
};

function toObjectId(value: ContextObjectId): Types.ObjectId | null {
  if (!Types.ObjectId.isValid(value)) return null;
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
}

function idString(value: unknown): string | null {
  if (typeof value === "string" && Types.ObjectId.isValid(value)) return value.toLowerCase();
  if (value instanceof Types.ObjectId) return value.toString();
  return null;
}

function sameId(left: unknown, right: Types.ObjectId): boolean {
  return idString(left) === right.toString();
}

function boundedText(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).length <= maxCharacters ? trimmed : undefined;
}

function exceedsTextLimit(value: unknown, maxCharacters: number): boolean {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value.trim()).length > maxCharacters;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeContactDetails(value: unknown): BusinessAiContext["business"]["contactDetails"] {
  if (!isPlainRecord(value)) return undefined;
  const contactDetails = {
    phone: boundedText(value.phone, 40),
    email: boundedText(value.email, 254),
    website: boundedText(value.website, 250),
    address: boundedText(value.address, 250),
  };
  return Object.values(contactDetails).some(Boolean) ? contactDetails : undefined;
}

function validateLimits(limits: BusinessContextLimits): boolean {
  return (
    Number.isSafeInteger(limits.recentMessages) &&
    limits.recentMessages >= 1 && limits.recentMessages <= DEFAULT_BUSINESS_CONTEXT_LIMITS.recentMessages &&
    Number.isSafeInteger(limits.catalogItems) &&
    limits.catalogItems >= 1 && limits.catalogItems <= DEFAULT_BUSINESS_CONTEXT_LIMITS.catalogItems &&
    Number.isSafeInteger(limits.faqs) &&
    limits.faqs >= 1 && limits.faqs <= DEFAULT_BUSINESS_CONTEXT_LIMITS.faqs &&
    Number.isSafeInteger(limits.maxSerializedBytes) &&
    limits.maxSerializedBytes >= 1_024 &&
    limits.maxSerializedBytes <= DEFAULT_BUSINESS_CONTEXT_LIMITS.maxSerializedBytes
  );
}

function serializedSize(context: BusinessAiContext): number {
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}

function isBeforeMessage(message: HistoryMessageRecord, trigger: InboundMessageRecord): boolean {
  if (!(message.createdAt instanceof Date) || !(trigger.createdAt instanceof Date)) return false;
  const timeDifference = message.createdAt.getTime() - trigger.createdAt.getTime();
  return timeDifference < 0 || (timeDifference === 0 && (idString(message._id) ?? "") < (idString(trigger._id) ?? ""));
}

function catalogContext(records: CatalogRecord[], businessId: Types.ObjectId) {
  let incomplete = false;
  const items = records
    .filter((record) => sameId(record.businessId, businessId) && record.isActive === true)
    .flatMap((record) => {
      if (record.kind !== "product" && record.kind !== "service") { incomplete = true; return []; }
      const kind: "product" | "service" = record.kind;
      const name = boundedText(record.name, 120);
      if (!name) { incomplete = true; return []; }

      const rawPrice = record.priceInPaise;
      const priceInPaise = typeof rawPrice === "number" &&
        Number.isSafeInteger(rawPrice) && rawPrice >= 0 && record.currency === "INR"
        ? rawPrice
        : undefined;
      if (rawPrice !== undefined && priceInPaise === undefined) incomplete = true;
      if (exceedsTextLimit(record.description, 400) || exceedsTextLimit(record.availability, 150)) {
        incomplete = true;
      }

      return [{
        kind,
        name,
        ...(boundedText(record.description, 400) ? { description: boundedText(record.description, 400) } : {}),
        ...(priceInPaise !== undefined ? { priceInPaise, currency: "INR" as const } : {}),
        ...(boundedText(record.availability, 150)
          ? { availabilityNote: boundedText(record.availability, 150) }
          : {}),
      }];
    })
    .sort((left, right) => compareText(left.kind, right.kind) || compareText(left.name, right.name));
  return { items, incomplete };
}

function faqContext(records: FaqRecord[], businessId: Types.ObjectId) {
  let incomplete = false;
  const items = records
    .filter((record) => sameId(record.businessId, businessId) && record.isActive === true)
    .flatMap((record) => {
      const question = boundedText(record.question, 300);
      const answer = boundedText(record.answer, 600);
      if (!question || !answer) { incomplete = true; return []; }
      return question && answer ? [{ question, answer }] : [];
    })
    .sort((left, right) => compareText(left.question, right.question) || compareText(left.answer, right.answer));
  return { items, incomplete };
}

function historyContext(
  records: HistoryMessageRecord[],
  businessId: Types.ObjectId,
  conversationId: Types.ObjectId,
  customerId: Types.ObjectId,
  trigger: InboundMessageRecord,
): { items: BusinessAiContext["recentMessages"]; incomplete: boolean } {
  let incomplete = false;
  const scopedMessages = records
    .filter((record) =>
      sameId(record.businessId, businessId) &&
      sameId(record.conversationId, conversationId) &&
      sameId(record.customerId, customerId) &&
      record.messageType === "text" &&
      isBeforeMessage(record, trigger) &&
      (record.direction === "inbound" ||
        (record.direction === "outbound" && ALLOWED_OUTBOUND_HISTORY_STATUSES.includes(record.status as never))),
    );
  const items = scopedMessages.flatMap((record) => {
      const text = boundedText(record.text, 600);
      if (!text || !(record.createdAt instanceof Date)) { incomplete = true; return []; }
      if (record.direction !== "inbound" && record.direction !== "outbound") return [];
      const direction: "inbound" | "outbound" = record.direction;
      return [{ direction, text, createdAt: record.createdAt.toISOString() }];
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (items.length < scopedMessages.length) incomplete = true;
  return { items, incomplete };
}

export function createBusinessContextService(
  repository: BusinessContextRepository = mongooseRepository,
  configuredLimits: Partial<BusinessContextLimits> = {},
) {
  const limits: BusinessContextLimits = {
    ...DEFAULT_BUSINESS_CONTEXT_LIMITS,
    ...configuredLimits,
  };

  async function retrieve(input: {
    businessId: ContextObjectId;
    conversationId: ContextObjectId;
    inboundMessageId: ContextObjectId;
  }): Promise<BusinessContextResult> {
    if (!validateLimits(limits)) return { status: "unavailable", reason: "context_size_exceeded" };

    const businessId = toObjectId(input.businessId);
    const conversationId = toObjectId(input.conversationId);
    const inboundMessageId = toObjectId(input.inboundMessageId);
    if (!businessId || !conversationId || !inboundMessageId) {
      return { status: "unavailable", reason: "invalid_reference" };
    }

    try {
      const [business, conversation] = await Promise.all([
        repository.findBusiness(businessId),
        repository.findConversation(businessId, conversationId),
      ]);
      if (!business || !sameId(business._id, businessId)) {
        return { status: "unavailable", reason: "business_not_found" };
      }
      if (
        !conversation ||
        !sameId(conversation._id, conversationId) ||
        !sameId(conversation.businessId, businessId)
      ) {
        return { status: "unavailable", reason: "conversation_not_found" };
      }

      const customerId = toObjectId(conversation.customerId);
      if (!customerId) return { status: "unavailable", reason: "conversation_not_found" };
      const [customer, trigger] = await Promise.all([
        repository.findCustomer(businessId, customerId),
        repository.findInboundMessage({ businessId, conversationId, customerId, inboundMessageId }),
      ]);
      if (!customer || !sameId(customer._id, customerId) || !sameId(customer.businessId, businessId)) {
        return { status: "unavailable", reason: "conversation_not_found" };
      }
      if (
        !trigger ||
        !sameId(trigger._id, inboundMessageId) ||
        !sameId(trigger.businessId, businessId) ||
        !sameId(trigger.conversationId, conversationId) ||
        !sameId(trigger.customerId, customerId) ||
        trigger.direction !== "inbound" ||
        trigger.messageType !== "text" ||
        !(trigger.createdAt instanceof Date)
      ) {
        return { status: "unavailable", reason: "trigger_message_not_found" };
      }

      const businessName = boundedText(business.name, 150);
      if (!businessName) return { status: "unavailable", reason: "business_profile_incomplete" };

      const latestText = boundedText(trigger.text, 4_096);
      if (!latestText) return { status: "unavailable", reason: "trigger_message_not_found" };
      if (Buffer.byteLength(latestText, "utf8") > MAX_TRIGGER_MESSAGE_BYTES) {
        return { status: "unavailable", reason: "trigger_message_too_large" };
      }

      const [catalogRecords, faqRecords, historyRecords] = await Promise.all([
        repository.listActiveCatalogItems(businessId, limits.catalogItems),
        repository.listActiveFaqs(businessId, limits.faqs),
        repository.listRecentMessages({
          businessId,
          conversationId,
          customerId,
          before: trigger,
          limit: limits.recentMessages,
        }),
      ]);

      const normalizedCatalog = catalogContext(catalogRecords.slice(0, limits.catalogItems), businessId);
      const normalizedFaqs = faqContext(faqRecords.slice(0, limits.faqs), businessId);
      const normalizedHistory = historyContext(historyRecords, businessId, conversationId, customerId, trigger);
      const catalogItems = normalizedCatalog.items;
      const faqs = normalizedFaqs.items;
      const recentMessages = normalizedHistory.items.slice(-limits.recentMessages);
      const description = boundedText(business.description, 1_000);
      const industry = boundedText(business.industry, 100);
      const contactDetails = safeContactDetails(business.contactDetails);
      const contactDetailsIncomplete = isPlainRecord(business.contactDetails) &&
        (exceedsTextLimit(business.contactDetails.phone, 40) ||
          exceedsTextLimit(business.contactDetails.email, 254) ||
          exceedsTextLimit(business.contactDetails.website, 250) ||
          exceedsTextLimit(business.contactDetails.address, 250));

      const context: BusinessAiContext = {
        business: {
          name: businessName,
          ...(industry ? { industry } : {}),
          ...(description ? { description } : {}),
          ...(contactDetails ? { contactDetails } : {}),
        },
        ...(boundedText(customer.profileName, 100)
          ? { customer: { displayName: boundedText(customer.profileName, 100)! } }
          : {}),
        catalogItems: [],
        faqs: [],
        recentMessages: [],
        latestCustomerMessage: { text: latestText, createdAt: trigger.createdAt.toISOString() },
        coverage: {
          businessProfileMayBeIncomplete:
            exceedsTextLimit(business.description, 1_000) ||
            exceedsTextLimit(business.industry, 100) || contactDetailsIncomplete,
          catalogMayBeIncomplete: catalogRecords.length >= limits.catalogItems || normalizedCatalog.incomplete,
          faqsMayBeIncomplete: faqRecords.length >= limits.faqs || normalizedFaqs.incomplete,
          historyMayBeIncomplete: historyRecords.length >= limits.recentMessages || normalizedHistory.incomplete,
        },
      };

      const selectionBudget = limits.maxSerializedBytes - CONTEXT_SIZE_RESERVE_BYTES;
      if (serializedSize(context) > selectionBudget) {
        return { status: "unavailable", reason: "context_size_exceeded" };
      }

      for (const item of catalogItems) {
        const candidate = [...context.catalogItems, item];
        if (serializedSize({ ...context, catalogItems: candidate }) <= selectionBudget) {
          context.catalogItems = candidate;
        } else {
          context.coverage.catalogMayBeIncomplete = true;
        }
      }

      for (const faq of faqs) {
        const candidate = [...context.faqs, faq];
        if (serializedSize({ ...context, faqs: candidate }) <= selectionBudget) {
          context.faqs = candidate;
        } else {
          context.coverage.faqsMayBeIncomplete = true;
        }
      }

      for (const message of recentMessages.slice().reverse()) {
        const candidate = [...context.recentMessages, message];
        if (serializedSize({ ...context, recentMessages: candidate }) <= selectionBudget) {
          context.recentMessages = candidate;
        } else {
          context.coverage.historyMayBeIncomplete = true;
        }
      }
      context.recentMessages.reverse();

      const serializedBytes = serializedSize(context);
      if (serializedBytes > limits.maxSerializedBytes) {
        return { status: "unavailable", reason: "context_size_exceeded" };
      }

      const hasApprovedBusinessKnowledge = Boolean(
        context.business.description || context.catalogItems.length || context.faqs.length,
      );
      if (!hasApprovedBusinessKnowledge) {
        return { status: "unavailable", reason: "insufficient_business_knowledge" };
      }

      return { status: "ready", context, serializedBytes };
    } catch {
      return { status: "unavailable", reason: "context_unavailable" };
    }
  }

  return { retrieve, limits };
}

export const businessContextService = createBusinessContextService();
