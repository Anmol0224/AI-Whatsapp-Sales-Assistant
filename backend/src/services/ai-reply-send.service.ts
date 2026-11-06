import { Types } from "mongoose";
import { env } from "../config/env.js";
import { AiReplyJob, type AiReplyJobFields } from "../models/ai-reply-job.model.js";
import { Business, type BusinessFields } from "../models/business.model.js";
import { Conversation, type ConversationFields } from "../models/conversation.model.js";
import { Customer, type CustomerFields } from "../models/customer.model.js";
import {
  completeAiReplySend,
  recordAiReplySendOutcome,
  reserveAiReplyDraftForSending,
} from "./ai-reply-job.repository.js";
import {
  sendWhatsAppTextMessage,
  WhatsAppCloudApiError,
  type SendWhatsAppTextMessageResult,
} from "./whatsapp-cloud-api.service.js";

type SendJobRecord = Pick<AiReplyJobFields,
  "conversationId" | "status" | "approvedText" | "approvedControlVersion" | "outboundMessageId"
>;
type SendConversationRecord = Pick<ConversationFields,
  "customerId" | "responseMode" | "aiControlVersion" | "activeAiSendJobId"
>;
type SendCustomerRecord = Pick<CustomerFields, "phoneNumber">;
type SendBusinessRecord = Pick<BusinessFields, "ownerUserId" | "whatsapp">;
type SendBusinessInput = Pick<BusinessFields, "whatsapp">;

export type AiReplySendConflict =
  | "not_approved"
  | "already_sending"
  | "mode_changed"
  | "stale_approval"
  | "conflict";

export type AiReplySendErrorCode =
  | "provider_rejected"
  | "provider_timeout"
  | "provider_network_error"
  | "provider_unavailable"
  | "invalid_provider_response"
  | "persistence_unavailable"
  | "internal_error";

export type AiReplySendResult =
  | { kind: "sent"; draftId: string; message: { id: string; text: string; status: "sent"; createdAt: string } }
  | { kind: "already_sent"; draftId: string }
  | { kind: "send_failed"; draftId: string; errorCode: "provider_rejected" | "provider_unavailable"; providerStatusCode?: number }
  | { kind: "outcome_uncertain"; draftId: string; errorCode: AiReplySendErrorCode; providerStatusCode?: number }
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "conflict"; reason: AiReplySendConflict };

export interface AiReplySendDependencies {
  findJob(businessId: Types.ObjectId, draftId: Types.ObjectId): Promise<SendJobRecord | null>;
  findConversation(conversationId: Types.ObjectId, businessId: Types.ObjectId): Promise<SendConversationRecord | null>;
  findCustomer(customerId: Types.ObjectId, businessId: Types.ObjectId): Promise<SendCustomerRecord | null>;
  findBusiness(businessId: Types.ObjectId, ownerUserId: Types.ObjectId): Promise<SendBusinessRecord | null>;
  reserve: typeof reserveAiReplyDraftForSending;
  complete: typeof completeAiReplySend;
  recordOutcome: typeof recordAiReplySendOutcome;
  sendText: typeof sendWhatsAppTextMessage;
  isProviderConfigured(): boolean;
}

const mongooseDependencies: AiReplySendDependencies = {
  findJob: (businessId, draftId) => AiReplyJob.findOne({ _id: draftId, businessId })
    .select({ conversationId: 1, status: 1, approvedText: 1, approvedControlVersion: 1, outboundMessageId: 1 })
    .lean<SendJobRecord>()
    .exec(),
  findConversation: (conversationId, businessId) => Conversation.findOne({ _id: conversationId, businessId })
    .select({ customerId: 1, responseMode: 1, aiControlVersion: 1, activeAiSendJobId: 1 })
    .lean<SendConversationRecord>()
    .exec(),
  findCustomer: (customerId, businessId) => Customer.findOne({ _id: customerId, businessId })
    .select({ phoneNumber: 1 })
    .lean<SendCustomerRecord>()
    .exec(),
  findBusiness: (businessId, ownerUserId) => Business.findOne({ _id: businessId, ownerUserId })
    .select({ ownerUserId: 1, "whatsapp.phoneNumberId": 1, "whatsapp.connectionStatus": 1 })
    .lean<SendBusinessRecord>()
    .exec(),
  reserve: reserveAiReplyDraftForSending,
  complete: completeAiReplySend,
  recordOutcome: recordAiReplySendOutcome,
  sendText: sendWhatsAppTextMessage,
  isProviderConfigured: () => Boolean(env.WHATSAPP_ACCESS_TOKEN && env.META_GRAPH_API_VERSION),
};

function mapConflict(status: string): AiReplySendConflict {
  if (status === "sending") return "already_sending";
  if (status === "human") return "mode_changed";
  if (status === "approved") return "stale_approval";
  if (status !== "approved") return "not_approved";
  return "conflict";
}

function providerFailure(error: unknown): {
  outcome: "rejected" | "uncertain";
  errorCode: Exclude<AiReplySendErrorCode, "persistence_unavailable">;
  providerStatusCode?: number;
} {
  if (!(error instanceof WhatsAppCloudApiError)) {
    return { outcome: "uncertain", errorCode: "internal_error" };
  }

  const status = error.providerStatusCode;
  if (error.category === "provider_http_error" && status !== undefined && status >= 400 && status < 500) {
    return { outcome: "rejected", errorCode: "provider_rejected", providerStatusCode: status };
  }
  if (error.category === "provider_http_error" && status !== undefined && status >= 500 && status <= 599) {
    return { outcome: "uncertain", errorCode: "provider_unavailable", providerStatusCode: status };
  }
  if (error.category === "provider_timeout") return { outcome: "uncertain", errorCode: "provider_timeout" };
  if (error.category === "provider_network_error") return { outcome: "uncertain", errorCode: "provider_network_error" };
  if (error.category === "invalid_provider_response") return { outcome: "uncertain", errorCode: "invalid_provider_response" };
  if (
    error.category === "missing_access_token" ||
    error.category === "missing_graph_api_version" ||
    error.category === "missing_phone_number_id" ||
    error.category === "invalid_recipient" ||
    error.category === "invalid_message_text"
  ) {
    return { outcome: "rejected", errorCode: "provider_unavailable" };
  }
  return { outcome: "uncertain", errorCode: "internal_error" };
}

function safeStatusCode(status?: number): number | undefined {
  return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
}

async function recordOutcomeSafely(
  dependencies: AiReplySendDependencies,
  input: Parameters<AiReplySendDependencies["recordOutcome"]>[0],
): Promise<boolean> {
  try {
    return (await dependencies.recordOutcome(input)).kind === "recorded";
  } catch {
    return false;
  }
}

export function createAiReplySendService(dependencies: AiReplySendDependencies = mongooseDependencies) {
  return async function sendApprovedAiReply(input: {
    businessId: Types.ObjectId;
    draftId: Types.ObjectId;
    ownerUserId: Types.ObjectId;
  }): Promise<AiReplySendResult> {
    let job = await dependencies.findJob(input.businessId, input.draftId);
    if (!job) return { kind: "not_found" };
    if (job.status === "sent") return { kind: "already_sent", draftId: input.draftId.toString() };
    if (job.status !== "approved" || !job.approvedText || job.approvedControlVersion === undefined) {
      return { kind: "conflict", reason: mapConflict(job.status) };
    }

    const conversation = await dependencies.findConversation(job.conversationId, input.businessId);
    if (!conversation) return { kind: "not_found" };
    if (conversation.responseMode !== "ai" && conversation.responseMode !== "ai_draft") {
      return { kind: "conflict", reason: "mode_changed" };
    }
    if (conversation.aiControlVersion !== job.approvedControlVersion) {
      return { kind: "conflict", reason: "stale_approval" };
    }
    if (conversation.activeAiSendJobId) return { kind: "conflict", reason: "already_sending" };

    const [customer, business] = await Promise.all([
      dependencies.findCustomer(conversation.customerId, input.businessId),
      dependencies.findBusiness(input.businessId, input.ownerUserId),
    ]);
    if (!customer || !business) return { kind: "not_found" };

    const phoneNumberId = business.whatsapp?.phoneNumberId;
    if (
      !dependencies.isProviderConfigured() ||
      typeof phoneNumberId !== "string" ||
      !/^\d{1,32}$/.test(phoneNumberId.trim())
    ) {
      return { kind: "not_configured" };
    }

    const reservation = await dependencies.reserve({ businessId: input.businessId, jobId: input.draftId });
    if (reservation.kind === "not_found") return { kind: "not_found" };
    if (reservation.kind === "mode_changed") return { kind: "conflict", reason: "mode_changed" };
    if (reservation.kind === "conflict") {
      job = await dependencies.findJob(input.businessId, input.draftId);
      if (job?.status === "sent") return { kind: "already_sent", draftId: input.draftId.toString() };
      return { kind: "conflict", reason: mapConflict(job?.status ?? "") };
    }

    let providerResult: SendWhatsAppTextMessageResult;
    try {
      const sendBusiness: SendBusinessInput = {
        whatsapp: {
          phoneNumberId: phoneNumberId.trim(),
          connectionStatus: business.whatsapp.connectionStatus,
        },
      };
      providerResult = await dependencies.sendText(
        sendBusiness,
        customer.phoneNumber,
        reservation.approvedText,
      );
    } catch (error) {
      const failure = providerFailure(error);
      const recorded = await recordOutcomeSafely(dependencies, {
        businessId: input.businessId,
        jobId: input.draftId,
        sendAttemptId: reservation.sendAttemptId,
        outcome: failure.outcome,
        errorCode: failure.errorCode,
        ...(safeStatusCode(failure.providerStatusCode) !== undefined
          ? { providerStatusCode: safeStatusCode(failure.providerStatusCode) }
          : {}),
      });
      if (!recorded) {
        return { kind: "outcome_uncertain", draftId: input.draftId.toString(), errorCode: "persistence_unavailable" };
      }
      return failure.outcome === "rejected"
        ? {
            kind: "send_failed",
            draftId: input.draftId.toString(),
            errorCode: failure.errorCode === "provider_rejected" ? "provider_rejected" : "provider_unavailable",
            ...(safeStatusCode(failure.providerStatusCode) !== undefined
              ? { providerStatusCode: safeStatusCode(failure.providerStatusCode) }
              : {}),
          }
        : {
            kind: "outcome_uncertain",
            draftId: input.draftId.toString(),
            errorCode: failure.errorCode,
            ...(safeStatusCode(failure.providerStatusCode) !== undefined
              ? { providerStatusCode: safeStatusCode(failure.providerStatusCode) }
              : {}),
          };
    }

    try {
      const completion = await dependencies.complete({
        businessId: input.businessId,
        jobId: input.draftId,
        sendAttemptId: reservation.sendAttemptId,
        providerMessageId: providerResult.providerMessageId,
      });
      if (completion.kind === "already_sent") {
        return { kind: "already_sent", draftId: input.draftId.toString() };
      }
      if (completion.kind === "sent") {
        return {
          kind: "sent",
          draftId: input.draftId.toString(),
          message: {
            id: completion.message._id.toString(),
            text: completion.message.text,
            status: "sent",
            createdAt: completion.message.createdAt.toISOString(),
          },
        };
      }
    } catch {
      // Provider acceptance is already known. Never call WhatsApp again if local persistence fails.
    }

    await recordOutcomeSafely(dependencies, {
      businessId: input.businessId,
      jobId: input.draftId,
      sendAttemptId: reservation.sendAttemptId,
      outcome: "uncertain",
      errorCode: "persistence_unavailable",
      providerMessageId: providerResult.providerMessageId,
    });
    return {
      kind: "outcome_uncertain",
      draftId: input.draftId.toString(),
      errorCode: "persistence_unavailable",
    };
  };
}

export const sendApprovedAiReply = createAiReplySendService();
