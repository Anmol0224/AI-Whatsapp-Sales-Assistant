import { Types } from "mongoose";
import type { AiReplyEscalationReasonCode } from "../models/ai-reply-escalation.model.js";
import { env } from "../config/env.js";
import { completeAiReplySend, recordAiReplySendOutcome, reserveAiAutomaticReplyForSending } from "./ai-reply-job.repository.js";
import { automaticReplySafetyService } from "./automatic-reply-safety.service.js";
import { logAiPipelineTiming } from "./ai-pipeline-telemetry.js";
import {
  sendWhatsAppTextMessage,
  WhatsAppCloudApiError,
  type SendWhatsAppTextMessageResult,
} from "./whatsapp-cloud-api.service.js";

export type AutomaticReplySendResult =
  | { kind: "sent"; jobId: string; providerMessageId: string }
  | { kind: "already_sent"; jobId: string }
  | { kind: "escalated"; jobId: string; reasonCode: AiReplyEscalationReasonCode; escalation: "created" | "already_exists" | "not_persisted" }
  | { kind: "send_failed"; jobId: string; providerStatusCode?: number }
  | { kind: "send_uncertain"; jobId: string; reason: "provider_timeout" | "provider_network_error" | "provider_unavailable" | "invalid_provider_response" | "persistence_unavailable" | "internal_error"; providerStatusCode?: number }
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "in_progress" }
  | { kind: "ineligible" }
  | { kind: "conflict" };

export interface AutomaticReplySendDependencies {
  reserve: typeof reserveAiAutomaticReplyForSending;
  complete: typeof completeAiReplySend;
  recordOutcome: typeof recordAiReplySendOutcome;
  sendText: typeof sendWhatsAppTextMessage;
  isProviderConfigured(): boolean;
  isAutomaticSendEnabled(): boolean;
  persistEscalation(input: {
    businessId: Types.ObjectId;
    conversationId: Types.ObjectId;
    inboundMessageId: Types.ObjectId;
  }, validation: Parameters<typeof automaticReplySafetyService.persistEscalation>[1]): Promise<"created" | "already_exists" | "not_persisted">;
  log: typeof logAiPipelineTiming;
}

const mongooseDependencies: AutomaticReplySendDependencies = {
  reserve: reserveAiAutomaticReplyForSending,
  complete: completeAiReplySend,
  recordOutcome: recordAiReplySendOutcome,
  sendText: sendWhatsAppTextMessage,
  isProviderConfigured: () => Boolean(env.WHATSAPP_ACCESS_TOKEN && env.META_GRAPH_API_VERSION),
  isAutomaticSendEnabled: () => env.AI_AUTOMATIC_SEND_ENABLED,
  persistEscalation: (input, validation) => automaticReplySafetyService.persistEscalation(input, validation),
  log: logAiPipelineTiming,
};

function safeStatusCode(status?: number): number | undefined {
  return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
}

function log(dependencies: AutomaticReplySendDependencies, event: Parameters<typeof logAiPipelineTiming>[0]): void {
  try {
    dependencies.log(event);
  } catch {
    // Telemetry must not change reservation or provider outcomes.
  }
}

function classifyProviderFailure(error: unknown): {
  outcome: "rejected" | "uncertain";
  code: "provider_timeout" | "provider_network_error" | "provider_unavailable" | "invalid_provider_response" | "internal_error";
  status?: number;
} {
  if (!(error instanceof WhatsAppCloudApiError)) {
    return { outcome: "uncertain", code: "internal_error" };
  }
  const status = safeStatusCode(error.providerStatusCode);
  if (error.category === "provider_http_error" && status !== undefined && status >= 400 && status < 500) {
    return { outcome: "rejected", code: "provider_unavailable", status };
  }
  if (error.category === "provider_http_error" && status !== undefined && status >= 500) {
    return { outcome: "uncertain", code: "provider_unavailable", status };
  }
  if (error.category === "provider_timeout") return { outcome: "uncertain", code: "provider_timeout" };
  if (error.category === "provider_network_error") return { outcome: "uncertain", code: "provider_network_error" };
  if (error.category === "invalid_provider_response") return { outcome: "uncertain", code: "invalid_provider_response" };
  return { outcome: "rejected", code: "provider_unavailable" };
}

function safeProviderCategory(error: unknown): Parameters<typeof logAiPipelineTiming>[0]["providerCategory"] {
  if (!(error instanceof WhatsAppCloudApiError)) return "provider_error";
  if (error.category === "provider_timeout") return "timeout";
  if (error.category === "provider_network_error") return "network_error";
  if (error.category === "invalid_provider_response") return "invalid_response";
  if (error.category === "provider_http_error") {
    if (error.providerStatusCode === 429) return "rate_limited";
    if (error.providerStatusCode === 401) return "authentication_failed";
    if (error.providerStatusCode === 403) return "permission_denied";
    if (error.providerStatusCode !== undefined && error.providerStatusCode >= 500 && error.providerStatusCode <= 599) {
      return "provider_5xx";
    }
    return "provider_error";
  }
  if (error.category === "missing_access_token" || error.category === "missing_graph_api_version" ||
    error.category === "missing_phone_number_id") return "missing_credentials";
  if (error.category === "invalid_recipient" || error.category === "invalid_message_text") return "invalid_request";
  return "provider_error";
}

async function recordOutcomeSafely(
  dependencies: AutomaticReplySendDependencies,
  input: Parameters<AutomaticReplySendDependencies["recordOutcome"]>[0],
): Promise<boolean> {
  try {
    return (await dependencies.recordOutcome(input)).kind === "recorded";
  } catch {
    return false;
  }
}

export function createAutomaticReplySendService(dependencies: AutomaticReplySendDependencies = mongooseDependencies) {
  /**
   * The committed send reservation is the authorization boundary. A later
   * business opt-out cannot recall a WhatsApp request already dispatched; the
   * existing Conversation send marker blocks Human takeover while it is active.
   */
  return async function sendAutomaticReply(input: {
    businessId: Types.ObjectId;
    jobId: Types.ObjectId;
    now?: Date;
    leaseDurationMs?: number;
    workerLease?: { attemptCount: number; leaseExpiresAt: Date };
  }): Promise<AutomaticReplySendResult> {
    if (!dependencies.isProviderConfigured()) {
      log(dependencies, {
        event: "ai_pipeline.automatic_reply_send",
        stage: "automatic_send",
        outcome: "not_configured",
      });
      return { kind: "not_configured" };
    }

    const reservation = await dependencies.reserve({
      businessId: input.businessId,
      jobId: input.jobId,
      ...(input.now ? { now: input.now } : {}),
      ...(input.leaseDurationMs ? { leaseDurationMs: input.leaseDurationMs } : {}),
      ...(input.workerLease ? { workerLease: input.workerLease } : {}),
      isAutomaticSendEnabled: dependencies.isAutomaticSendEnabled,
    });
    const jobId = input.jobId.toString();
    const reservationOutcome = reservation.kind === "reserved"
      ? "reserved"
      : reservation.kind === "already_sent"
        ? "already_sent"
        : reservation.kind === "in_progress"
          ? "in_progress"
          : reservation.kind === "safety_rejected"
            ? "safety_rejected"
            : reservation.kind === "not_configured"
              ? "not_configured"
              : "ineligible";
    log(dependencies, {
      event: "ai_pipeline.automatic_reply_reservation",
      stage: "send_reservation",
      outcome: reservationOutcome,
      jobId,
    });

    if (reservation.kind === "not_found") return { kind: "not_found" };
    if (reservation.kind === "already_sent") return { kind: "already_sent", jobId };
    if (reservation.kind === "in_progress") return { kind: "in_progress" };
    if (reservation.kind === "ineligible") return { kind: "ineligible" };
    if (reservation.kind === "not_configured") return { kind: "not_configured" };
    if (reservation.kind === "conflict") return { kind: "conflict" };
    if (reservation.kind === "safety_rejected") {
      const escalation = await dependencies.persistEscalation({
        businessId: input.businessId,
        conversationId: reservation.conversationId,
        inboundMessageId: reservation.inboundMessageId,
      }, reservation.validation);
      return {
        kind: "escalated",
        jobId,
        reasonCode: reservation.validation.reasonCode,
        escalation,
      };
    }

    let providerResult: SendWhatsAppTextMessageResult;
    log(dependencies, {
      event: "ai_pipeline.automatic_reply_send",
      stage: "automatic_send",
      outcome: "attempted",
      jobId,
    });
    try {
      providerResult = await dependencies.sendText(
        {
          whatsapp: {
            phoneNumberId: reservation.phoneNumberId,
            connectionStatus: reservation.connectionStatus,
          },
        },
        reservation.recipientPhoneNumber,
        reservation.automaticReplyText,
      );
    } catch (error) {
      const failure = classifyProviderFailure(error);
      const recorded = await recordOutcomeSafely(dependencies, {
        businessId: input.businessId,
        jobId: input.jobId,
        sendAttemptId: reservation.sendAttemptId,
        outcome: failure.outcome,
        errorCode: failure.code,
        ...(failure.status !== undefined ? { providerStatusCode: failure.status } : {}),
      });
      const result: AutomaticReplySendResult = failure.outcome === "rejected" && recorded
        ? { kind: "send_failed", jobId, ...(failure.status !== undefined ? { providerStatusCode: failure.status } : {}) }
        : {
            kind: "send_uncertain",
            jobId,
            reason: recorded ? failure.code : "persistence_unavailable",
            ...(failure.status !== undefined ? { providerStatusCode: failure.status } : {}),
          };
      log(dependencies, {
        event: "ai_pipeline.automatic_reply_send",
        stage: "automatic_send",
        outcome: result.kind === "send_failed" ? "send_failed" : "send_uncertain",
        jobId,
        providerCategory: safeProviderCategory(error),
        ...(failure.status !== undefined ? { providerHttpStatus: failure.status } : {}),
      });
      return result;
    }

    try {
      const completion = await dependencies.complete({
        businessId: input.businessId,
        jobId: input.jobId,
        sendAttemptId: reservation.sendAttemptId,
        providerMessageId: providerResult.providerMessageId,
        ...(input.now ? { now: input.now } : {}),
      });
      if (completion.kind === "already_sent") return { kind: "already_sent", jobId };
      if (completion.kind === "sent") {
        log(dependencies, {
          event: "ai_pipeline.automatic_reply_send",
          stage: "automatic_send",
          outcome: "sent",
          jobId,
        });
        return { kind: "sent", jobId, providerMessageId: providerResult.providerMessageId };
      }
    } catch {
      // Provider acceptance is known; completion failure must never cause a second send.
    }

    await recordOutcomeSafely(dependencies, {
      businessId: input.businessId,
      jobId: input.jobId,
      sendAttemptId: reservation.sendAttemptId,
      outcome: "uncertain",
      errorCode: "persistence_unavailable",
      providerMessageId: providerResult.providerMessageId,
    });
    log(dependencies, {
      event: "ai_pipeline.automatic_reply_send",
      stage: "automatic_send",
      outcome: "send_uncertain",
      jobId,
    });
    return { kind: "send_uncertain", jobId, reason: "persistence_unavailable" };
  };
}

export const sendAutomaticAiReply = createAutomaticReplySendService();
