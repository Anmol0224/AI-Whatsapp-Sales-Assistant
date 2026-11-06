import { Types } from "mongoose";
import { performance } from "node:perf_hooks";
import { env } from "../config/env.js";
import type { AiReplyEscalationReasonCode } from "../models/ai-reply-escalation.model.js";
import type { AiReplyJobErrorCode, AiReplyEscalationReason } from "../models/ai-reply-job.model.js";
import { logAiPipelineTiming } from "./ai-pipeline-telemetry.js";
import {
  categorizeGeminiFailure,
  AI_DRAFT_RETRY_BASE_DELAY_MS,
  AI_DRAFT_RETRY_MAX_DELAY_MS,
  type AiDraftContextService,
  type AiDraftGenerator,
  type AiDraftPromptBuilder,
  type AiDraftWorkerOutcome,
  type ClaimedAiReplyJob,
} from "./ai-draft-processor.service.js";
import { AI_REPLY_JOB_MAX_ATTEMPTS } from "./ai-reply-job.repository.js";
import type { BusinessContextResult } from "./business-context.service.js";
import type { BusinessPromptBuildResult } from "./business-prompt-builder.service.js";
import {
  automaticReplySafetyService,
  type AutomaticReplySafetyResult,
} from "./automatic-reply-safety.service.js";
import {
  finishAutomaticAiReplyJob,
  markAiReplyJobFailed,
  persistAutomaticAiReply,
  retryAiReplyJob,
} from "./ai-reply-job.repository.js";
import { sendAutomaticAiReply } from "./ai-automatic-reply-send.service.js";

export interface AiAutomaticReplyProcessor {
  process(job: ClaimedAiReplyJob): Promise<AiDraftWorkerOutcome>;
}

export interface AiAutomaticReplyProcessorDependencies {
  contextService: AiDraftContextService;
  promptBuilder: AiDraftPromptBuilder;
  generator: AiDraftGenerator;
  checkEligibility: typeof automaticReplySafetyService.checkEligibility;
  validate: typeof automaticReplySafetyService.validate;
  persistEscalation: typeof automaticReplySafetyService.persistEscalation;
  persist: typeof persistAutomaticAiReply;
  finish: typeof finishAutomaticAiReplyJob;
  retry: typeof retryAiReplyJob;
  fail: typeof markAiReplyJobFailed;
  send(input: Parameters<typeof sendAutomaticAiReply>[0]): ReturnType<typeof sendAutomaticAiReply>;
  isAutomaticSendEnabled(): boolean;
  now(): Date;
  log: typeof logAiPipelineTiming;
}

const defaultDependencies: Omit<AiAutomaticReplyProcessorDependencies, "contextService" | "promptBuilder" | "generator"> = {
  checkEligibility: automaticReplySafetyService.checkEligibility,
  validate: automaticReplySafetyService.validate,
  persistEscalation: automaticReplySafetyService.persistEscalation,
  persist: persistAutomaticAiReply,
  finish: finishAutomaticAiReplyJob,
  retry: retryAiReplyJob,
  fail: markAiReplyJobFailed,
  send: sendAutomaticAiReply,
  isAutomaticSendEnabled: () => env.AI_AUTOMATIC_SEND_ENABLED,
  now: () => new Date(),
  log: logAiPipelineTiming,
};

function toObjectId(value: Types.ObjectId | string | undefined): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? new Types.ObjectId(value) : null;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(AI_DRAFT_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)), AI_DRAFT_RETRY_MAX_DELAY_MS);
}

function transientDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (/Mongo(Network|ServerSelection|NetworkTimeout|Timeout)|MongooseServerSelection/i.test(name)) return true;
  const code = "code" in error ? error.code : undefined;
  if (code === 112 || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  if ("hasErrorLabel" in error && typeof error.hasErrorLabel === "function") {
    try {
      return error.hasErrorLabel("TransientTransactionError") || error.hasErrorLabel("UnknownTransactionCommitResult");
    } catch { return false; }
  }
  return false;
}

function escalationReason(reason: AiReplyEscalationReasonCode): AiReplyEscalationReason {
  if (reason === "automatic_replies_disabled") return "automatic_replies_disabled";
  if (reason === "catalog_item_ambiguous") return "ambiguous_answer";
  if (reason === "business_evidence_unavailable" || reason === "evidence_incomplete" || reason === "source_message_unavailable") {
    return "insufficient_context";
  }
  if (reason === "provider_generation_failed") return "provider_generation_failed";
  if (reason === "catalog_intent_unsupported" ||
    reason === "catalog_item_missing" || reason === "catalog_price_missing" || reason === "faq_not_exact") {
    return "unsupported_query";
  }
  return "safety_check_failed";
}

function safetyDecision(result: AutomaticReplySafetyResult): "unsupported" | "uncertain" {
  return result.decision === "unsupported_information" || result.decision === "needs_owner_review" ||
    result.decision === "missing_business_information"
    ? "unsupported"
    : "uncertain";
}

function diagnosticForGenerationFailure(
  expectedPolicyVersion: string,
  expectedControlVersion: number,
): AutomaticReplySafetyResult {
  return {
    decision: "needs_owner_review",
    reasonCode: "provider_generation_failed",
    evidence: [],
    expectedPolicyVersion,
    expectedControlVersion,
  };
}

function safeLog(dependencies: AiAutomaticReplyProcessorDependencies, fields: Parameters<typeof logAiPipelineTiming>[0]): void {
  try { dependencies.log(fields); } catch { /* telemetry never changes the workflow */ }
}

export function createAiAutomaticReplyProcessor(
  options: Pick<AiAutomaticReplyProcessorDependencies, "contextService" | "promptBuilder" | "generator"> &
    Partial<Omit<AiAutomaticReplyProcessorDependencies, "contextService" | "promptBuilder" | "generator">>,
): AiAutomaticReplyProcessor {
  const dependencies: AiAutomaticReplyProcessorDependencies = { ...defaultDependencies, ...options };

  async function retryOrFail(
    ids: { businessId: Types.ObjectId; jobId: Types.ObjectId; attemptCount: number; leaseExpiresAt: Date },
    errorCode: AiReplyJobErrorCode,
    retryable: boolean,
  ): Promise<AiDraftWorkerOutcome> {
    const timestamp = dependencies.now();
    if (retryable && ids.attemptCount < AI_REPLY_JOB_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(timestamp.getTime() + retryDelayMs(ids.attemptCount));
      const retried = await dependencies.retry(ids.businessId, ids.jobId, ids.attemptCount, nextAttemptAt, errorCode, timestamp);
      return retried ? { kind: "retry_scheduled", nextAttemptAt } : { kind: "stale" };
    }
    const failed = await dependencies.fail(ids.businessId, ids.jobId, ids.attemptCount, errorCode, timestamp);
    return failed ? { kind: "failed", errorCode } : { kind: "stale" };
  }

  async function finishEscalation(
    ids: { businessId: Types.ObjectId; jobId: Types.ObjectId; conversationId: Types.ObjectId; inboundMessageId: Types.ObjectId; attemptCount: number; leaseExpiresAt: Date },
    validation: AutomaticReplySafetyResult,
  ): Promise<AiDraftWorkerOutcome> {
    const escalation = await dependencies.persistEscalation({
      businessId: ids.businessId,
      conversationId: ids.conversationId,
      inboundMessageId: ids.inboundMessageId,
    }, validation);
    if (escalation === "not_persisted") {
      return retryOrFail(ids, "database_unavailable", true);
    }
    const finished = await dependencies.finish({
      businessId: ids.businessId,
      jobId: ids.jobId,
      attemptCount: ids.attemptCount,
      leaseExpiresAt: ids.leaseExpiresAt,
      status: "cancelled",
      now: dependencies.now(),
      automaticSafetyDecision: safetyDecision(validation),
      escalationReason: escalationReason(validation.reasonCode),
      ...(validation.policyVersion ? { automaticPolicyVersion: validation.policyVersion } : {}),
      ...(validation.controlVersion === undefined ? {} : { workflowControlVersion: validation.controlVersion }),
    });
    return finished ? { kind: "escalated" } : { kind: "deferred" };
  }

  async function process(job: ClaimedAiReplyJob): Promise<AiDraftWorkerOutcome> {
    const businessId = toObjectId(job.businessId);
    const jobId = toObjectId(job._id);
    const conversationId = toObjectId(job.conversationId);
    const inboundMessageId = toObjectId(job.inboundMessageId);
    const attemptCount = job.attemptCount;
    const leaseExpiresAt = job.leaseExpiresAt;
    const policyVersion = job.automaticPolicyVersion;
    const controlVersion = job.workflowControlVersion;
    if (!businessId || !jobId || !conversationId || !inboundMessageId ||
      !Number.isSafeInteger(attemptCount) || attemptCount < 1 || !(leaseExpiresAt instanceof Date) ||
      !policyVersion || !Number.isSafeInteger(controlVersion) || controlVersion! < 0) {
      return { kind: "deferred" };
    }
    const ids = { businessId, jobId, conversationId, inboundMessageId, attemptCount, leaseExpiresAt };
    const logContext = { jobId: jobId.toString(), attemptNumber: attemptCount };

    const gateStarted = performance.now();
    const eligibility = await dependencies.checkEligibility({
      businessId, conversationId, inboundMessageId,
      expectedPolicyVersion: policyVersion,
      expectedControlVersion: controlVersion!,
    });
    if (!eligibility.eligible) {
      safeLog(dependencies, {
        event: "ai_pipeline.automatic_reply_validation", stage: "safety_validation",
        durationMs: performance.now() - gateStarted, outcome: eligibility.validation.decision, ...logContext,
      });
      return finishEscalation(ids, eligibility.validation);
    }

    // A persisted automatic_ready snapshot is resumed after a worker crash without another Gemini call.
    const resumable = job.status === "automatic_ready" &&
      job.automaticSafetyDecision === "eligible" && typeof job.automaticReplyTextSnapshot === "string";
    if (resumable) return dispatchSend(ids);

    let contextResult: BusinessContextResult;
    const contextStartedAt = performance.now();
    try {
      contextResult = await dependencies.contextService.retrieve({ businessId, conversationId, inboundMessageId });
    } catch (error) {
      safeLog(dependencies, {
        event: "ai_pipeline.context_retrieval", stage: "business_context",
        durationMs: performance.now() - contextStartedAt,
        outcome: transientDatabaseError(error) ? "database_unavailable" : "internal_error", ...logContext,
      });
      return retryOrFail(ids, transientDatabaseError(error) ? "database_unavailable" : "internal_error", transientDatabaseError(error));
    }
    safeLog(dependencies, {
      event: "ai_pipeline.context_retrieval", stage: "business_context",
      durationMs: performance.now() - contextStartedAt,
      outcome: contextResult.status === "ready" ? "ready" : "unavailable", ...logContext,
    });
    if (contextResult.status !== "ready") {
      if (contextResult.reason === "context_unavailable") return retryOrFail(ids, "database_unavailable", true);
      return finishEscalation(ids, {
        decision: "missing_business_information",
        reasonCode: "business_evidence_unavailable",
        evidence: [],
        expectedPolicyVersion: policyVersion,
        expectedControlVersion: controlVersion,
      });
    }

    let prompt: BusinessPromptBuildResult;
    try { prompt = dependencies.promptBuilder(contextResult); }
    catch {
      return finishEscalation(ids, {
        decision: "missing_business_information", reasonCode: "evidence_incomplete", evidence: [],
        expectedPolicyVersion: policyVersion, expectedControlVersion: controlVersion,
      });
    }
    if (prompt.status !== "ready") {
      return finishEscalation(ids, {
        decision: "missing_business_information",
        reasonCode: "evidence_incomplete",
        evidence: [],
        expectedPolicyVersion: policyVersion,
        expectedControlVersion: controlVersion,
      });
    }

    let generatedText: unknown;
    const generationStartedAt = performance.now();
    try {
      generatedText = (await dependencies.generator.generateText(prompt.request)).text;
    } catch (error) {
      const failure = categorizeGeminiFailure(error);
      safeLog(dependencies, {
        event: "ai_pipeline.gemini_request", stage: "gemini_generation",
        durationMs: performance.now() - generationStartedAt, outcome: failure.errorCode,
        providerCategory: failure.providerCategory, providerHttpStatus: failure.providerHttpStatus,
        providerNetworkCode: failure.providerNetworkCode, retryable: failure.retryable, ...logContext,
      });
      if (failure.retryable && attemptCount < AI_REPLY_JOB_MAX_ATTEMPTS) {
        return retryOrFail(ids, failure.errorCode, true);
      }
      const validation = diagnosticForGenerationFailure(policyVersion, controlVersion!);
      const escalation = await dependencies.persistEscalation({ businessId, conversationId, inboundMessageId }, validation);
      if (escalation === "not_persisted" && attemptCount < AI_REPLY_JOB_MAX_ATTEMPTS) {
        return retryOrFail(ids, "database_unavailable", true);
      }
      const failed = await dependencies.finish({
        businessId, jobId, attemptCount, leaseExpiresAt, status: "failed", now: dependencies.now(),
        errorCode: failure.errorCode,
        automaticSafetyDecision: "uncertain",
        escalationReason: "provider_generation_failed",
        automaticPolicyVersion: policyVersion,
        workflowControlVersion: controlVersion,
      });
      return failed ? { kind: "failed", errorCode: failure.errorCode } : { kind: "deferred" };
    }
    safeLog(dependencies, {
      event: "ai_pipeline.gemini_request", stage: "gemini_generation",
      durationMs: performance.now() - generationStartedAt, outcome: "success", ...logContext,
    });

    const validationStartedAt = performance.now();
    const validation = await dependencies.validate({
      businessId, conversationId, inboundMessageId,
      expectedPolicyVersion: policyVersion,
      expectedControlVersion: controlVersion!,
      generatedResponse: generatedText,
    });
    if (validation.decision !== "safe_to_auto_reply" || !validation.safeReplyText) {
      return finishEscalation(ids, validation);
    }
    safeLog(dependencies, {
      event: "ai_pipeline.automatic_reply_validation", stage: "safety_validation",
      durationMs: performance.now() - validationStartedAt, outcome: "safe_to_auto_reply", ...logContext,
    });

    const persistenceStartedAt = performance.now();
    const persisted = await dependencies.persist({
      businessId, conversationId, jobId, inboundMessageId, attemptCount,
      expectedPolicyVersion: policyVersion,
      expectedControlVersion: controlVersion!,
      safeReplyText: validation.safeReplyText,
      evidence: validation.evidence,
      globalGateEnabled: dependencies.isAutomaticSendEnabled() === true,
      now: dependencies.now(),
    });
    safeLog(dependencies, {
      event: "ai_pipeline.automatic_reply_persistence", stage: "automatic_reply_persistence",
      durationMs: performance.now() - persistenceStartedAt,
      outcome: persisted.kind === "ready" ? "ready" : "stale", ...logContext,
    });
    if (persisted.kind !== "ready") {
      const refreshed = await dependencies.checkEligibility({
        businessId, conversationId, inboundMessageId,
        expectedPolicyVersion: policyVersion,
        expectedControlVersion: controlVersion!,
      });
      const fallbackReason = persisted.kind === "mode_changed" ? "conversation_mode_mismatch"
        : persisted.kind === "policy_changed" ? "stale_policy_version" : "stale_control_version";
      return finishEscalation(ids, refreshed.eligible ? {
        decision: "policy_conflict", reasonCode: fallbackReason, evidence: validation.evidence,
        policyVersion: validation.policyVersion, expectedPolicyVersion: policyVersion,
        controlVersion: validation.controlVersion, expectedControlVersion: controlVersion,
      } : refreshed.validation);
    }
    return dispatchSend({ ...ids, leaseExpiresAt });
  }

  async function dispatchSend(ids: {
    businessId: Types.ObjectId; jobId: Types.ObjectId; conversationId: Types.ObjectId;
    inboundMessageId: Types.ObjectId; attemptCount: number; leaseExpiresAt: Date;
  }): Promise<AiDraftWorkerOutcome> {
    const result = await dependencies.send({
      businessId: ids.businessId,
      jobId: ids.jobId,
      workerLease: { attemptCount: ids.attemptCount, leaseExpiresAt: ids.leaseExpiresAt },
    });
    if (result.kind === "sent" || result.kind === "already_sent") return { kind: "sent" };
    if (result.kind === "send_failed") return { kind: "send_failed" };
    if (result.kind === "send_uncertain") return { kind: "send_uncertain" };
    if (result.kind === "escalated") {
      if (result.escalation === "not_persisted") return { kind: "deferred" };
      const validation: AutomaticReplySafetyResult = {
        decision: "policy_conflict",
        reasonCode: result.reasonCode,
        evidence: [],
      };
      const finished = await dependencies.finish({
        businessId: ids.businessId, jobId: ids.jobId, attemptCount: ids.attemptCount,
        leaseExpiresAt: ids.leaseExpiresAt, status: "cancelled", now: dependencies.now(),
        automaticSafetyDecision: safetyDecision(validation),
        escalationReason: escalationReason(validation.reasonCode),
      });
      return finished ? { kind: "escalated" } : { kind: "deferred" };
    }
    if (result.kind === "not_configured") {
      const failed = await dependencies.finish({
        businessId: ids.businessId, jobId: ids.jobId, attemptCount: ids.attemptCount,
        leaseExpiresAt: ids.leaseExpiresAt, status: "failed", now: dependencies.now(),
        errorCode: "internal_error", automaticSafetyDecision: "uncertain",
      });
      return failed ? { kind: "failed", errorCode: "internal_error" } : { kind: "deferred" };
    }
    if (result.kind === "in_progress") return { kind: "deferred" };
    return { kind: "stale" };
  }

  return { process };
}
