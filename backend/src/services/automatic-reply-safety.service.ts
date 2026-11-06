import { Types, type ClientSession } from "mongoose";
import { env } from "../config/env.js";
import { AiReplyEscalation, type AiReplyEscalationCategory, type AiReplyEscalationReasonCode } from "../models/ai-reply-escalation.model.js";
import { Business } from "../models/business.model.js";
import { CatalogItem } from "../models/catalog-item.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Faq } from "../models/faq.model.js";
import { Message } from "../models/message.model.js";
import { logAiPipelineTiming } from "./ai-pipeline-telemetry.js";

export const AUTOMATIC_REPLY_VALIDATION_LIMITS = Object.freeze({
  inboundBytes: 6_000,
  generatedResponseBytes: 8_192,
  generatedResponseCharacters: 4_096,
  faqs: 20,
  catalogItems: 30,
  catalogListingItems: 10,
  evidenceReferences: 50,
});

export type AutomaticReplySafetyDecision =
  | "safe_to_auto_reply"
  | "needs_owner_review"
  | "unsupported_information"
  | "ambiguous_request"
  | "missing_business_information"
  | "policy_conflict"
  | "invalid_or_empty_response";

export type AutomaticReplySafetyReasonCode = AiReplyEscalationReasonCode;

export interface AutomaticReplyEvidenceReference {
  kind: "faq" | "catalog_item";
  recordId: string;
}

export interface AutomaticReplySafetyResult {
  decision: AutomaticReplySafetyDecision;
  reasonCode: AutomaticReplySafetyReasonCode;
  evidence: AutomaticReplyEvidenceReference[];
  policyVersion?: string;
  expectedPolicyVersion?: string;
  controlVersion?: number;
  expectedControlVersion?: number;
  /** Present only when the server found an exact, deterministic reply. */
  safeReplyText?: string;
}

export interface AutomaticReplyPolicyRecord {
  automaticRepliesEnabled?: unknown;
  automaticRepliesPolicyVersion?: unknown;
}

export interface AutomaticReplyConversationRecord {
  _id: Types.ObjectId | string;
  businessId: Types.ObjectId | string;
  responseMode?: unknown;
  aiControlVersion?: unknown;
}

export interface AutomaticReplyInboundRecord {
  _id: Types.ObjectId | string;
  businessId: Types.ObjectId | string;
  conversationId: Types.ObjectId | string;
  direction?: unknown;
  messageType?: unknown;
  text?: unknown;
}

export interface AutomaticReplyFaqRecord {
  _id: Types.ObjectId | string;
  businessId: Types.ObjectId | string;
  question?: unknown;
  answer?: unknown;
  isActive?: unknown;
}

export interface AutomaticReplyCatalogRecord {
  _id: Types.ObjectId | string;
  businessId: Types.ObjectId | string;
  kind?: unknown;
  name?: unknown;
  priceInPaise?: unknown;
  currency?: unknown;
  isActive?: unknown;
}

export interface AutomaticReplyEscalationInput {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  inboundMessageId: Types.ObjectId;
  category: AiReplyEscalationCategory;
  reasonCode: AiReplyEscalationReasonCode;
  policyVersion?: string;
  expectedPolicyVersion?: string;
  controlVersion?: number;
  expectedControlVersion?: number;
  evidence: AutomaticReplyEvidenceReference[];
}

export type AutomaticReplyEscalationResult =
  | { kind: "created"; escalationId: Types.ObjectId }
  | { kind: "exists"; escalationId: Types.ObjectId }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface AutomaticReplySafetyRepository {
  findBusinessPolicy(businessId: Types.ObjectId): Promise<AutomaticReplyPolicyRecord | null>;
  findConversation(
    businessId: Types.ObjectId,
    conversationId: Types.ObjectId,
  ): Promise<AutomaticReplyConversationRecord | null>;
  findInboundMessage(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    inboundMessageId: Types.ObjectId;
  }): Promise<AutomaticReplyInboundRecord | null>;
  listActiveFaqs(businessId: Types.ObjectId, limit: number): Promise<AutomaticReplyFaqRecord[]>;
  listActiveCatalogItems(businessId: Types.ObjectId, limit: number): Promise<AutomaticReplyCatalogRecord[]>;
  recordEscalation(input: AutomaticReplyEscalationInput): Promise<AutomaticReplyEscalationResult>;
}

function objectId(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
    ? new Types.ObjectId(value)
    : null;
}

function sameId(value: unknown, expected: Types.ObjectId): boolean {
  const id = objectId(value);
  return id !== null && id.equals(expected);
}

function normalizeExactText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function boundedString(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= maxCharacters ? trimmed : null;
}

function validPolicyVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function safeGeneratedResponse(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || Array.from(text).length > AUTOMATIC_REPLY_VALIDATION_LIMITS.generatedResponseCharacters) return null;
  if (Buffer.byteLength(text, "utf8") > AUTOMATIC_REPLY_VALIDATION_LIMITS.generatedResponseBytes) return null;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return null;
  return text;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toId(value: unknown): string | null {
  const id = objectId(value);
  return id?.toString() ?? null;
}

function decision(
  category: AutomaticReplySafetyDecision,
  reasonCode: AutomaticReplySafetyReasonCode,
  context: {
    policyVersion?: string;
    expectedPolicyVersion?: string;
    controlVersion?: number;
    expectedControlVersion?: number;
    evidence?: AutomaticReplyEvidenceReference[];
  } = {},
): AutomaticReplySafetyResult {
  return {
    decision: category,
    reasonCode,
    evidence: context.evidence ?? [],
    ...(context.policyVersion ? { policyVersion: context.policyVersion } : {}),
    ...(validPolicyVersion(context.expectedPolicyVersion)
      ? { expectedPolicyVersion: context.expectedPolicyVersion }
      : {}),
    ...(context.controlVersion === undefined ? {} : { controlVersion: context.controlVersion }),
    ...(context.expectedControlVersion === undefined ? {} : { expectedControlVersion: context.expectedControlVersion }),
  };
}

function parseCatalogIntent(text: string):
  | { kind: "price"; itemName: string }
  | { kind: "listing" }
  | null {
  const priceMatch = /^(?:what is the price of|what's the price of|price of|how much is)\s+(.+?)[?.!]*$/iu.exec(text.trim());
  if (priceMatch?.[1]) {
    const itemName = priceMatch[1].trim().replace(/[?.!]+$/u, "").trim();
    return itemName ? { kind: "price", itemName } : null;
  }

  if (/^(?:what products do you offer|what services do you offer|what do you sell)\??$/iu.test(text.trim())) {
    return { kind: "listing" };
  }
  return null;
}

function formatRupees(priceInPaise: number): string {
  const rupees = Math.floor(priceInPaise / 100);
  const paise = priceInPaise % 100;
  return `${rupees}.${String(paise).padStart(2, "0")}`;
}

function sameBusinessFaqs(records: AutomaticReplyFaqRecord[], businessId: Types.ObjectId) {
  return records.filter((record) =>
    typeof record === "object" && record !== null &&
    sameId(record.businessId, businessId) && record.isActive === true,
  );
}

function sameBusinessCatalog(records: AutomaticReplyCatalogRecord[], businessId: Types.ObjectId) {
  return records.filter((record) =>
    typeof record === "object" && record !== null &&
    sameId(record.businessId, businessId) && record.isActive === true,
  );
}

export async function recordAutomaticReplyEscalation(
  input: AutomaticReplyEscalationInput,
): Promise<AutomaticReplyEscalationResult> {
  const [conversationExists, inboundMessageExists] = await Promise.all([
    Conversation.exists({ _id: input.conversationId, businessId: input.businessId }),
    Message.exists({
      _id: input.inboundMessageId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      direction: "inbound",
      messageType: "text",
    }),
  ]);
  if (!conversationExists || !inboundMessageExists) return { kind: "not_found" };

  const filter = { businessId: input.businessId, inboundMessageId: input.inboundMessageId };
  const existing = await AiReplyEscalation.findOne(filter)
    .select({ _id: 1, conversationId: 1 })
    .lean<{ _id: Types.ObjectId; conversationId: Types.ObjectId }>()
    .exec();
  if (existing) {
    return existing.conversationId.equals(input.conversationId)
      ? { kind: "exists", escalationId: existing._id }
      : { kind: "conflict" };
  }

  const evidence = input.evidence.slice(0, AUTOMATIC_REPLY_VALIDATION_LIMITS.evidenceReferences).flatMap((item) => {
    const recordId = objectId(item.recordId);
    return recordId ? [{ kind: item.kind, recordId }] : [];
  });
  try {
    const [created] = await AiReplyEscalation.create([{
      businessId: input.businessId,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
      category: input.category,
      reasonCode: input.reasonCode,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      ...(input.expectedPolicyVersion ? { expectedPolicyVersion: input.expectedPolicyVersion } : {}),
      ...(input.controlVersion === undefined ? {} : { controlVersion: input.controlVersion }),
      ...(input.expectedControlVersion === undefined ? {} : { expectedControlVersion: input.expectedControlVersion }),
      evidence,
      status: "open",
    }]);
    if (!created) return { kind: "conflict" };
    return { kind: "created", escalationId: created._id };
  } catch (error) {
    const duplicateKey = typeof error === "object" && error !== null && "code" in error && error.code === 11000;
    if (!duplicateKey) throw error;
    const duplicate = await AiReplyEscalation.findOne(filter)
      .select({ _id: 1, conversationId: 1 })
      .lean<{ _id: Types.ObjectId; conversationId: Types.ObjectId }>()
      .exec();
    if (!duplicate) throw error;
    return duplicate.conversationId.equals(input.conversationId)
      ? { kind: "exists", escalationId: duplicate._id }
      : { kind: "conflict" };
  }
}

export function createAutomaticReplySafetyRepository(session?: ClientSession): AutomaticReplySafetyRepository {
  return {
    findBusinessPolicy: (businessId) => {
      const query = Business.findOne({ _id: businessId })
        .select({
          "aiSettings.automaticRepliesEnabled": 1,
          "aiSettings.automaticRepliesPolicyVersion": 1,
        })
        .lean<{
          aiSettings?: {
            automaticRepliesEnabled?: unknown;
            automaticRepliesPolicyVersion?: unknown;
          } | null;
        }>();
      if (session) query.session(session);
      return query.exec().then((business) => {
        if (!business) return null;
        return {
          automaticRepliesEnabled: business.aiSettings?.automaticRepliesEnabled,
          automaticRepliesPolicyVersion: business.aiSettings?.automaticRepliesPolicyVersion,
        };
      });
    },
    findConversation: (businessId, conversationId) => {
      const query = Conversation.findOne({ _id: conversationId, businessId })
      .select({ _id: 1, businessId: 1, responseMode: 1, aiControlVersion: 1 })
        .lean<AutomaticReplyConversationRecord>();
      if (session) query.session(session);
      return query.exec();
    },
    findInboundMessage: ({ businessId, conversationId, inboundMessageId }) => {
      const query = Message.findOne({
      _id: inboundMessageId,
      businessId,
      conversationId,
      direction: "inbound",
      messageType: "text",
    })
      .select({ _id: 1, businessId: 1, conversationId: 1, direction: 1, messageType: 1, text: 1 })
        .lean<AutomaticReplyInboundRecord>();
      if (session) query.session(session);
      return query.exec();
    },
    listActiveFaqs: (businessId, limit) => {
      const query = Faq.find({ businessId, isActive: true })
      .select({ _id: 1, businessId: 1, question: 1, answer: 1, isActive: 1 })
      .sort({ _id: 1 })
      .limit(limit)
        .lean<AutomaticReplyFaqRecord[]>();
      if (session) query.session(session);
      return query.exec();
    },
    listActiveCatalogItems: (businessId, limit) => {
      const query = CatalogItem.find({ businessId, isActive: true })
      .select({ _id: 1, businessId: 1, kind: 1, name: 1, priceInPaise: 1, currency: 1, isActive: 1 })
      .sort({ _id: 1 })
      .limit(limit)
        .lean<AutomaticReplyCatalogRecord[]>();
      if (session) query.session(session);
      return query.exec();
    },
    recordEscalation: recordAutomaticReplyEscalation,
  };
}

const mongooseRepository = createAutomaticReplySafetyRepository();

export interface AutomaticReplySafetyDependencies {
  repository: AutomaticReplySafetyRepository;
  isAutomaticSendEnabled(): boolean;
  /** MongoDB sessions do not support parallel operations inside a transaction. */
  transactional: boolean;
  now(): Date;
  log(fields: Parameters<typeof logAiPipelineTiming>[0]): void;
}

function logDecision(
  dependencies: AutomaticReplySafetyDependencies,
  result: AutomaticReplySafetyResult,
  startedAt: number,
): void {
  try {
    dependencies.log({
      event: "ai_pipeline.automatic_reply_validation",
      stage: "safety_validation",
      outcome: result.decision,
      durationMs: performance.now() - startedAt,
      faqEvidenceCount: result.evidence.filter((item) => item.kind === "faq").length,
      catalogEvidenceCount: result.evidence.filter((item) => item.kind === "catalog_item").length,
    });
  } catch {
    // Diagnostics must not alter a validation decision.
  }
}

function logEscalationOutcome(
  dependencies: AutomaticReplySafetyDependencies,
  outcome: "created" | "already_exists" | "error" | "database_unavailable",
  evidence: AutomaticReplyEvidenceReference[] = [],
): void {
  try {
    dependencies.log({
      event: "ai_pipeline.automatic_reply_escalation",
      stage: "escalation_persistence",
      outcome,
      faqEvidenceCount: evidence.filter((item) => item.kind === "faq").length,
      catalogEvidenceCount: evidence.filter((item) => item.kind === "catalog_item").length,
    });
  } catch {
    // Escalation diagnostics must not change persistence outcomes.
  }
}

export function createAutomaticReplySafetyService(
  overrides: Partial<AutomaticReplySafetyDependencies> = {},
) {
  const dependencies: AutomaticReplySafetyDependencies = {
    repository: overrides.repository ?? mongooseRepository,
    isAutomaticSendEnabled: overrides.isAutomaticSendEnabled ?? (() => env.AI_AUTOMATIC_SEND_ENABLED),
    transactional: overrides.transactional ?? false,
    now: overrides.now ?? (() => new Date()),
    log: overrides.log ?? logAiPipelineTiming,
  };

  /** Cheap fail-closed gate check used before context retrieval or Gemini generation. */
  async function checkEligibility(input: {
    businessId: Types.ObjectId | string;
    conversationId: Types.ObjectId | string;
    inboundMessageId: Types.ObjectId | string;
    expectedPolicyVersion?: string;
    expectedControlVersion: number;
  }): Promise<{ eligible: boolean; validation: AutomaticReplySafetyResult }> {
    const startedAt = performance.now();
    const businessId = objectId(input.businessId);
    const conversationId = objectId(input.conversationId);
    const inboundMessageId = objectId(input.inboundMessageId);
    const expectedControlVersion = input.expectedControlVersion;
    const finish = (result: AutomaticReplySafetyResult, eligible = false) => {
      logDecision(dependencies, result, startedAt);
      return { eligible, validation: result };
    };
    if (!businessId || !conversationId || !inboundMessageId || !validVersion(expectedControlVersion)) {
      return finish(decision("policy_conflict", "source_message_unavailable"));
    }

    let policy: AutomaticReplyPolicyRecord | null;
    let conversation: AutomaticReplyConversationRecord | null;
    let inbound: AutomaticReplyInboundRecord | null;
    try {
      if (dependencies.transactional) {
        policy = await dependencies.repository.findBusinessPolicy(businessId);
        conversation = await dependencies.repository.findConversation(businessId, conversationId);
        inbound = await dependencies.repository.findInboundMessage({ businessId, conversationId, inboundMessageId });
      } else {
        [policy, conversation, inbound] = await Promise.all([
          dependencies.repository.findBusinessPolicy(businessId),
          dependencies.repository.findConversation(businessId, conversationId),
          dependencies.repository.findInboundMessage({ businessId, conversationId, inboundMessageId }),
        ]);
      }
    } catch {
      return finish(decision("missing_business_information", "business_evidence_unavailable", {
        expectedPolicyVersion: input.expectedPolicyVersion,
        expectedControlVersion,
      }));
    }

    const actualPolicyVersion = validPolicyVersion(policy?.automaticRepliesPolicyVersion)
      ? policy.automaticRepliesPolicyVersion
      : undefined;
    const actualControlVersion = validVersion(conversation?.aiControlVersion)
      ? conversation.aiControlVersion
      : undefined;
    const context = {
      ...(actualPolicyVersion ? { policyVersion: actualPolicyVersion } : {}),
      ...(input.expectedPolicyVersion ? { expectedPolicyVersion: input.expectedPolicyVersion } : {}),
      ...(actualControlVersion === undefined ? {} : { controlVersion: actualControlVersion }),
      expectedControlVersion,
    };
    if (!policy || !conversation || !inbound ||
      !sameId(conversation._id, conversationId) || !sameId(conversation.businessId, businessId) ||
      !sameId(inbound._id, inboundMessageId) || !sameId(inbound.businessId, businessId) ||
      !sameId(inbound.conversationId, conversationId) || inbound.direction !== "inbound" ||
      inbound.messageType !== "text" || typeof inbound.text !== "string") {
      return finish(decision("policy_conflict", "source_message_unavailable", context));
    }
    let globalGateEnabled = false;
    try { globalGateEnabled = dependencies.isAutomaticSendEnabled() === true; } catch { /* fail closed */ }
    if (!globalGateEnabled || policy.automaticRepliesEnabled !== true) {
      return finish(decision("policy_conflict", "automatic_replies_disabled", context));
    }
    if (conversation.responseMode !== "ai_automatic") {
      return finish(decision("policy_conflict", "conversation_mode_mismatch", context));
    }
    if (actualControlVersion === undefined || actualControlVersion !== expectedControlVersion) {
      return finish(decision("policy_conflict", "stale_control_version", context));
    }
    if (!actualPolicyVersion || !validPolicyVersion(input.expectedPolicyVersion) ||
      actualPolicyVersion !== input.expectedPolicyVersion) {
      return finish(decision("policy_conflict", "stale_policy_version", context));
    }
    return finish(decision("safe_to_auto_reply", "validation_failed", context), true);
  }

  async function validate(input: {
    businessId: Types.ObjectId | string;
    conversationId: Types.ObjectId | string;
    inboundMessageId: Types.ObjectId | string;
    expectedPolicyVersion?: string;
    expectedControlVersion: number;
    generatedResponse: unknown;
  }): Promise<AutomaticReplySafetyResult> {
    const startedAt = performance.now();
    const businessId = objectId(input.businessId);
    const conversationId = objectId(input.conversationId);
    const inboundMessageId = objectId(input.inboundMessageId);
    const expectedControlVersion = input.expectedControlVersion;

    const finish = (result: AutomaticReplySafetyResult) => {
      logDecision(dependencies, result, startedAt);
      return result;
    };

    if (!businessId || !conversationId || !inboundMessageId || !validVersion(expectedControlVersion)) {
      return finish(decision("policy_conflict", "source_message_unavailable"));
    }

    let policy: AutomaticReplyPolicyRecord | null;
    let conversation: AutomaticReplyConversationRecord | null;
    let inbound: AutomaticReplyInboundRecord | null;
    try {
      if (dependencies.transactional) {
        policy = await dependencies.repository.findBusinessPolicy(businessId);
        conversation = await dependencies.repository.findConversation(businessId, conversationId);
        inbound = await dependencies.repository.findInboundMessage({ businessId, conversationId, inboundMessageId });
      } else {
        [policy, conversation, inbound] = await Promise.all([
          dependencies.repository.findBusinessPolicy(businessId),
          dependencies.repository.findConversation(businessId, conversationId),
          dependencies.repository.findInboundMessage({ businessId, conversationId, inboundMessageId }),
        ]);
      }
    } catch {
      return finish(decision("missing_business_information", "business_evidence_unavailable", {
        expectedPolicyVersion: input.expectedPolicyVersion,
        expectedControlVersion,
      }));
    }

    const actualPolicyVersion = validPolicyVersion(policy?.automaticRepliesPolicyVersion)
      ? policy.automaticRepliesPolicyVersion
      : undefined;
    const actualControlVersion = validVersion(conversation?.aiControlVersion)
      ? conversation.aiControlVersion
      : undefined;
    const validationContext = {
      ...(actualPolicyVersion ? { policyVersion: actualPolicyVersion } : {}),
      ...(input.expectedPolicyVersion ? { expectedPolicyVersion: input.expectedPolicyVersion } : {}),
      ...(actualControlVersion === undefined ? {} : { controlVersion: actualControlVersion }),
      expectedControlVersion,
    };

    if (!policy || !conversation || !inbound ||
      !sameId(conversation._id, conversationId) || !sameId(conversation.businessId, businessId) ||
      !sameId(inbound._id, inboundMessageId) || !sameId(inbound.businessId, businessId) ||
      !sameId(inbound.conversationId, conversationId) || inbound.direction !== "inbound" ||
      inbound.messageType !== "text" || typeof inbound.text !== "string") {
      return finish(decision("policy_conflict", "source_message_unavailable", validationContext));
    }

    let globalGateEnabled = false;
    try {
      globalGateEnabled = dependencies.isAutomaticSendEnabled() === true;
    } catch {
      return finish(decision("policy_conflict", "automatic_replies_disabled", validationContext));
    }
    if (!globalGateEnabled || policy.automaticRepliesEnabled !== true) {
      return finish(decision("policy_conflict", "automatic_replies_disabled", validationContext));
    }
    if (conversation.responseMode !== "ai_automatic") {
      return finish(decision("policy_conflict", "conversation_mode_mismatch", validationContext));
    }
    if (actualControlVersion === undefined || actualControlVersion !== expectedControlVersion) {
      return finish(decision("policy_conflict", "stale_control_version", validationContext));
    }
    if (!actualPolicyVersion || !validPolicyVersion(input.expectedPolicyVersion) ||
      actualPolicyVersion !== input.expectedPolicyVersion) {
      return finish(decision("policy_conflict", "stale_policy_version", validationContext));
    }

    const inboundText = boundedString(inbound.text, 4_096);
    if (!inboundText || Buffer.byteLength(inboundText, "utf8") > AUTOMATIC_REPLY_VALIDATION_LIMITS.inboundBytes) {
      return finish(decision("missing_business_information", "source_message_unavailable", validationContext));
    }

    const generatedResponse = safeGeneratedResponse(input.generatedResponse);
    if (!generatedResponse) {
      return finish(decision("invalid_or_empty_response", "generated_response_invalid", validationContext));
    }

    let rawFaqs: AutomaticReplyFaqRecord[];
    let rawCatalog: AutomaticReplyCatalogRecord[];
    try {
      if (dependencies.transactional) {
        rawFaqs = await dependencies.repository.listActiveFaqs(businessId, AUTOMATIC_REPLY_VALIDATION_LIMITS.faqs + 1);
        rawCatalog = await dependencies.repository.listActiveCatalogItems(businessId, AUTOMATIC_REPLY_VALIDATION_LIMITS.catalogItems + 1);
      } else {
        [rawFaqs, rawCatalog] = await Promise.all([
          dependencies.repository.listActiveFaqs(businessId, AUTOMATIC_REPLY_VALIDATION_LIMITS.faqs + 1),
          dependencies.repository.listActiveCatalogItems(businessId, AUTOMATIC_REPLY_VALIDATION_LIMITS.catalogItems + 1),
        ]);
      }
    } catch {
      return finish(decision("missing_business_information", "business_evidence_unavailable", validationContext));
    }

    if (!Array.isArray(rawFaqs) || !Array.isArray(rawCatalog)) {
      return finish(decision("missing_business_information", "business_evidence_unavailable", validationContext));
    }

    const faqs = sameBusinessFaqs(rawFaqs, businessId);
    const catalog = sameBusinessCatalog(rawCatalog, businessId);
    const faqEvidenceComplete = rawFaqs.length <= AUTOMATIC_REPLY_VALIDATION_LIMITS.faqs;
    const catalogEvidenceComplete = rawCatalog.length <= AUTOMATIC_REPLY_VALIDATION_LIMITS.catalogItems;
    const exactQuestion = normalizeExactText(inboundText);
    const faqMatches = faqs.filter((faq) =>
      boundedString(faq.question, 300) !== null &&
      normalizeExactText(boundedString(faq.question, 300)!) === exactQuestion,
    );

    if (faqMatches.length > 0) {
      const matchedEvidence = faqMatches.flatMap((faq) => {
        const id = toId(faq._id);
        return id ? [{ kind: "faq" as const, recordId: id }] : [];
      });
      const answers = faqMatches.map((faq) => boundedString(faq.answer, 600));
      const distinctAnswers = new Set(answers.filter((answer): answer is string => answer !== null));
      if (distinctAnswers.size > 1) {
        return finish(decision("policy_conflict", "faq_answers_conflict", { ...validationContext, evidence: matchedEvidence }));
      }
      if (!faqEvidenceComplete || answers.length !== faqMatches.length || distinctAnswers.size !== 1) {
        return finish(decision("missing_business_information", "evidence_incomplete", { ...validationContext, evidence: matchedEvidence }));
      }
      const answer = answers[0]!;
      if (generatedResponse !== answer) {
        return finish(decision("unsupported_information", "generated_response_mismatch", { ...validationContext, evidence: matchedEvidence }));
      }
      return finish({
        ...decision("safe_to_auto_reply", "faq_exact_answer", { ...validationContext, evidence: matchedEvidence }),
        safeReplyText: answer,
      });
    }

    const intent = parseCatalogIntent(inboundText);
    if (!intent) {
      return finish(decision("needs_owner_review", "catalog_intent_unsupported", validationContext));
    }
    if (!catalogEvidenceComplete) {
      return finish(decision("missing_business_information", "evidence_incomplete", validationContext));
    }

    const validCatalog = catalog.flatMap((item) => {
      const id = toId(item._id);
      const name = boundedString(item.name, 120);
      if (!id || !name || (item.kind !== "product" && item.kind !== "service")) return [];
      return [{ id, name, normalizedName: normalizeExactText(name), item }];
    });

    let safeReplyText: string;
    let evidence: AutomaticReplyEvidenceReference[];
    if (intent.kind === "price") {
      const matched = validCatalog.filter((item) => item.normalizedName === normalizeExactText(intent.itemName));
      if (matched.length === 0) {
        return finish(decision("missing_business_information", "catalog_item_missing", validationContext));
      }
      if (matched.length !== 1) {
        return finish(decision("ambiguous_request", "catalog_item_ambiguous", {
          ...validationContext,
          evidence: matched.slice(0, AUTOMATIC_REPLY_VALIDATION_LIMITS.evidenceReferences)
            .map((item) => ({ kind: "catalog_item" as const, recordId: item.id })),
        }));
      }
      const item = matched[0]!.item;
      if (typeof item.priceInPaise !== "number" || !Number.isSafeInteger(item.priceInPaise) ||
        item.priceInPaise < 0 || item.currency !== "INR") {
        return finish(decision("missing_business_information", "catalog_price_missing", {
          ...validationContext,
          evidence: [{ kind: "catalog_item", recordId: matched[0]!.id }],
        }));
      }
      safeReplyText = `The listed price for ${matched[0]!.name} is ₹${formatRupees(item.priceInPaise)}.`;
      evidence = [{ kind: "catalog_item", recordId: matched[0]!.id }];
    } else {
      if (validCatalog.length === 0) {
        return finish(decision("missing_business_information", "catalog_item_missing", validationContext));
      }
      if (validCatalog.length > AUTOMATIC_REPLY_VALIDATION_LIMITS.catalogListingItems) {
        return finish(decision("missing_business_information", "evidence_incomplete", validationContext));
      }
      const ordered = validCatalog.sort((left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) || left.id.localeCompare(right.id),
      );
      safeReplyText = `Our active catalogue includes: ${ordered.map((item) => item.name).join(", ")}.`;
      evidence = ordered.map((item) => ({ kind: "catalog_item" as const, recordId: item.id }));
    }

    if (generatedResponse !== safeReplyText) {
      return finish(decision("unsupported_information", "generated_response_mismatch", { ...validationContext, evidence }));
    }
    return finish({
      ...decision(
        "safe_to_auto_reply",
        intent.kind === "price" ? "catalog_price_response" : "catalog_listing_response",
        { ...validationContext, evidence },
      ),
      safeReplyText,
    });
  }

  async function persistEscalation(input: {
    businessId: Types.ObjectId | string;
    conversationId: Types.ObjectId | string;
    inboundMessageId: Types.ObjectId | string;
  }, validation: AutomaticReplySafetyResult): Promise<"created" | "already_exists" | "not_persisted"> {
    if (validation.decision === "safe_to_auto_reply") return "not_persisted";

    const businessId = objectId(input.businessId);
    const conversationId = objectId(input.conversationId);
    const inboundMessageId = objectId(input.inboundMessageId);
    if (!businessId || !conversationId || !inboundMessageId) {
      logEscalationOutcome(dependencies, "error", validation.evidence);
      return "not_persisted";
    }

    try {
      const stored = await dependencies.repository.recordEscalation({
        businessId,
        conversationId,
        inboundMessageId,
        category: validation.decision,
        reasonCode: validation.reasonCode,
        ...(validation.policyVersion ? { policyVersion: validation.policyVersion } : {}),
        ...(validation.expectedPolicyVersion ? { expectedPolicyVersion: validation.expectedPolicyVersion } : {}),
        ...(validation.controlVersion === undefined ? {} : { controlVersion: validation.controlVersion }),
        ...(validation.expectedControlVersion === undefined
          ? {}
          : { expectedControlVersion: validation.expectedControlVersion }),
        evidence: validation.evidence,
      });
      const escalation = stored.kind === "created"
        ? "created"
        : stored.kind === "exists"
          ? "already_exists"
          : "not_persisted";
      logEscalationOutcome(
        dependencies,
        stored.kind === "created" ? "created" : stored.kind === "exists" ? "already_exists" : "error",
        validation.evidence,
      );
      return escalation;
    } catch {
      logEscalationOutcome(dependencies, "database_unavailable", validation.evidence);
      return "not_persisted";
    }
  }

  async function validateAndEscalate(input: Parameters<typeof validate>[0]): Promise<{
    validation: AutomaticReplySafetyResult;
    escalation: "not_required" | "created" | "already_exists" | "not_persisted";
  }> {
    const validation = await validate(input);
    if (validation.decision === "safe_to_auto_reply") {
      return { validation, escalation: "not_required" };
    }

    return { validation, escalation: await persistEscalation(input, validation) };
  }

  return { checkEligibility, validate, validateAndEscalate, persistEscalation };
}

export const automaticReplySafetyService = createAutomaticReplySafetyService();
