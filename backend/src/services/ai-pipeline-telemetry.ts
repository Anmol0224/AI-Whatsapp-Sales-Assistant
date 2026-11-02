export type AiPipelineTimingEventName =
  | "ai_pipeline.webhook_request"
  | "ai_pipeline.webhook_ingestion"
  | "ai_pipeline.inbound_transaction"
  | "ai_pipeline.job_created"
  | "ai_pipeline.queue_cycle"
  | "ai_pipeline.context_retrieval"
  | "ai_pipeline.gemini_request"
  | "ai_pipeline.draft_persistence"
  | "ai_pipeline.job_processing";

export type AiPipelineTimingStage =
  | "http_processing"
  | "ingestion"
  | "inbound_transaction"
  | "job_creation"
  | "queue_recovery_and_claim"
  | "business_context"
  | "gemini_generation"
  | "draft_persistence"
  | "job_processing";

export type AiPipelineTimingOutcome =
  | "success"
  | "accepted"
  | "ignored"
  | "malformed"
  | "inserted"
  | "duplicate"
  | "unmapped"
  | "queued"
  | "exists"
  | "claimed"
  | "idle"
  | "ready"
  | "unavailable"
  | "saved"
  | "mode_changed"
  | "draft_ready"
  | "retry_scheduled"
  | "cancelled"
  | "failed"
  | "stale"
  | "deferred"
  | "error"
  | "recovery_error"
  | "claim_error"
  | "database_unavailable"
  | "provider_timeout"
  | "provider_unavailable"
  | "invalid_output"
  | "internal_error"
  | "context_unavailable"
  | "validation_rejected"
  | "retryable_failure";

export type AiPipelineProviderCategory =
  | "rate_limited"
  | "authentication_failed"
  | "permission_denied"
  | "timeout"
  | "network_error"
  | "provider_5xx"
  | "provider_error"
  | "missing_credentials"
  | "invalid_request"
  | "input_too_large"
  | "empty_response"
  | "invalid_response"
  | "output_too_large";

export interface AiPipelineTimingFields {
  event: AiPipelineTimingEventName;
  stage: AiPipelineTimingStage;
  outcome: AiPipelineTimingOutcome;
  durationMs?: number;
  jobId?: string;
  attemptNumber?: number;
  jobCreatedAt?: Date;
  queueWaitMs?: number;
  recoveryDurationMs?: number;
  claimDurationMs?: number;
  httpStatus?: number;
  providerCategory?: AiPipelineProviderCategory;
  providerHttpStatus?: number;
  providerNetworkCode?: string;
  retryable?: boolean;
}

const eventNames = new Set<AiPipelineTimingEventName>([
  "ai_pipeline.webhook_request",
  "ai_pipeline.webhook_ingestion",
  "ai_pipeline.inbound_transaction",
  "ai_pipeline.job_created",
  "ai_pipeline.queue_cycle",
  "ai_pipeline.context_retrieval",
  "ai_pipeline.gemini_request",
  "ai_pipeline.draft_persistence",
  "ai_pipeline.job_processing",
]);

const stages = new Set<AiPipelineTimingStage>([
  "http_processing",
  "ingestion",
  "inbound_transaction",
  "job_creation",
  "queue_recovery_and_claim",
  "business_context",
  "gemini_generation",
  "draft_persistence",
  "job_processing",
]);

const outcomes = new Set<AiPipelineTimingOutcome>([
  "success",
  "accepted",
  "ignored",
  "malformed",
  "inserted",
  "duplicate",
  "unmapped",
  "queued",
  "exists",
  "claimed",
  "idle",
  "ready",
  "unavailable",
  "saved",
  "mode_changed",
  "draft_ready",
  "retry_scheduled",
  "cancelled",
  "failed",
  "stale",
  "deferred",
  "error",
  "recovery_error",
  "claim_error",
  "database_unavailable",
  "provider_timeout",
  "provider_unavailable",
  "invalid_output",
  "internal_error",
  "context_unavailable",
  "validation_rejected",
  "retryable_failure",
]);

const providerCategories = new Set<AiPipelineProviderCategory>([
  "rate_limited",
  "authentication_failed",
  "permission_denied",
  "timeout",
  "network_error",
  "provider_5xx",
  "provider_error",
  "missing_credentials",
  "invalid_request",
  "input_too_large",
  "empty_response",
  "invalid_response",
  "output_too_large",
]);

const providerHttpStatuses = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);
const providerNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function safeMilliseconds(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Emits only allowlisted timing metadata; caller-provided extra fields are never serialized. */
export function logAiPipelineTiming(fields: AiPipelineTimingFields): void {
  if (!eventNames.has(fields.event) || !stages.has(fields.stage) || !outcomes.has(fields.outcome)) return;

  const event: Record<string, string | number | boolean> = {
    event: fields.event,
    stage: fields.stage,
    outcome: fields.outcome,
  };
  const durationMs = safeMilliseconds(fields.durationMs);
  const queueWaitMs = safeMilliseconds(fields.queueWaitMs);
  const recoveryDurationMs = safeMilliseconds(fields.recoveryDurationMs);
  const claimDurationMs = safeMilliseconds(fields.claimDurationMs);

  if (durationMs !== undefined) event.durationMs = durationMs;
  if (queueWaitMs !== undefined) event.queueWaitMs = queueWaitMs;
  if (recoveryDurationMs !== undefined) event.recoveryDurationMs = recoveryDurationMs;
  if (claimDurationMs !== undefined) event.claimDurationMs = claimDurationMs;
  if (typeof fields.jobId === "string" && /^[a-f\d]{24}$/i.test(fields.jobId)) {
    event.jobId = fields.jobId;
  }
  if (Number.isSafeInteger(fields.attemptNumber) && fields.attemptNumber! >= 1 && fields.attemptNumber! <= 3) {
    event.attemptNumber = fields.attemptNumber!;
  }
  if (fields.jobCreatedAt instanceof Date && Number.isFinite(fields.jobCreatedAt.getTime())) {
    event.jobCreatedAt = fields.jobCreatedAt.toISOString();
  }
  if (Number.isInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599) {
    event.httpStatus = fields.httpStatus!;
  }
  if (providerCategories.has(fields.providerCategory as AiPipelineProviderCategory)) {
    event.providerCategory = fields.providerCategory!;
  }
  if (Number.isInteger(fields.providerHttpStatus) && providerHttpStatuses.has(fields.providerHttpStatus!)) {
    event.providerHttpStatus = fields.providerHttpStatus!;
  }
  if (typeof fields.providerNetworkCode === "string" && providerNetworkCodes.has(fields.providerNetworkCode)) {
    event.providerNetworkCode = fields.providerNetworkCode;
  }
  if (typeof fields.retryable === "boolean") event.retryable = fields.retryable;

  try {
    console.info(JSON.stringify(event));
  } catch {
    // Telemetry must never affect webhook, transaction, or worker behavior.
  }
}
