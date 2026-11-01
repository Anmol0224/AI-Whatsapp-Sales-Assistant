# AI Draft Worker (Phase 6.5)

## Current behavior

The backend has an optional, MongoDB-backed polling worker for persisted `AiReplyJob` records. It is disabled by default. It does not enqueue jobs from WhatsApp webhooks, send WhatsApp messages, create outbound message records, or expose a draft approval API.

When enabled, the worker claims one due job at a time, checks that the conversation belongs to the job's business and remains in `ai` response mode, retrieves bounded business context, builds the controlled prompt, calls the configured Gemini adapter, validates the output, and stores it in the job's `generatedDraft` field with status `draft_ready`. That status means the draft is awaiting owner review; it does not authorize sending.

Enablement requires both `AI_DRAFT_WORKER_ENABLED=true` and a configured backend-only `GEMINI_API_KEY`. If the worker flag is false or credentials are absent, the ordinary API continues to start and the worker does not run. `AI_DRAFT_WORKER_POLL_INTERVAL_MS` defaults to 5000 ms and accepts 250–60000 ms.

## Retry and lease policy

- At most three generation attempts are claimed for a job.
- Gemini timeouts, rate limits, provider errors, and transient database failures are retryable.
- Retry delays are exponential: 1 second after attempt one, then 2 seconds after attempt two, capped at 30 seconds.
- Missing credentials, authentication/permission failures, missing business facts or invalid references, invalid prompts, and invalid/empty/oversized model output are terminal for that job and are not retried. Transient database/context retrieval failures are retried.
- Processing leases last 60 seconds. Expired leases are requeued while attempts remain; expired jobs that exhausted all three attempts become failed.
- The global claim is atomic. Retry, cancellation, failure, and draft completion are fenced by business, status, attempt count, and a live lease. A stale attempt cannot overwrite a newer attempt's result.

## Human takeover and provider limitation

The worker checks response mode before context retrieval and again before starting Gemini. Draft persistence then runs in a MongoDB transaction that conditionally increments `aiControlVersion` on the business-scoped conversation while it is still in `ai` mode, followed by the fenced job transition. Human takeover conditionally changes that same conversation to `human` and increments the same version. These writes serialize: if draft persistence wins, the draft remains for review; if takeover wins, the transaction cannot save a new draft and the current job attempt is cancelled. Transaction callbacks contain only database operations, so MongoDB may retry them without repeating Gemini generation.

The Gemini adapter currently does not expose request cancellation. A provider request already in flight at takeover may continue until it completes or times out, but the result is not persisted when takeover wins the conversation fence. This corrective change uses the existing Mongoose `session.withTransaction()` convention and has mocked transaction tests; live Atlas transaction behavior/topology has not been verified here.

## Activation boundary

The existing repository can create or retrieve one job per persisted inbound message, but incoming webhooks do not call it. Until a later approved step adds a guarded enqueue path, this worker processes only jobs already persisted through that repository or prepared for isolated testing. Any future enqueue path must require explicit AI eligibility and an AI-mode conversation. Owner approval and a separate approved sending action remain required before a draft can be sent.
