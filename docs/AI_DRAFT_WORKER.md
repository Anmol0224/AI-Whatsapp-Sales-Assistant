# AI Draft Worker and Queue

## Current behavior

The backend has a MongoDB-backed AI reply job collection and an optional polling worker. Inbound WhatsApp text ingestion creates a job in the same transaction as the newly persisted inbound Message and Conversation aiControlVersion update only when both conditions hold:

1. AI_DRAFT_WORKER_ENABLED is true.
2. The resolved Conversation is in AI response mode.

The unique businessId + inboundMessageId index prevents duplicate jobs. A duplicate webhook delivery is acknowledged without another Message/job or another control-version increment. With AI_DRAFT_WORKER_ENABLED false, normal inbound message persistence continues and no AI job is created.

The worker flag defaults to false in backend source and gates both enqueueing and worker startup. This source default does not establish the setting currently configured in Render. Keep the production setting disabled as required. Worker startup additionally requires GEMINI_API_KEY; if the global flag is true but that key is absent, the API stays available and the worker does not start, while eligible webhooks can still create queued jobs. Configure both only in a controlled non-production test.

## Worker lifecycle

When enabled and configured, the worker runs after the database-backed server starts. It polls using AI_DRAFT_WORKER_POLL_INTERVAL_MS, default 5000 milliseconds with an accepted range of 250–60000 milliseconds. The worker recovers eligible expired generation leases, claims due work atomically, and processes one job per iteration. Shutdown stops new polling and waits for the current cycle.

The processor validates business/conversation/message ownership and response mode, retrieves bounded context, builds the prompt, invokes the Gemini adapter outside transaction callbacks, validates output, and stores a draft. Context retrieval is business-scoped and caps context at 30 active catalog items, 20 FAQs, 12 recent messages, and 16,384 serialized bytes. The prompt builder caps the prompt at 30,000 bytes, frames customer/catalog/FAQ text as untrusted reference data, and instructs the model not to invent unsupported prices, stock, policies, availability, or promises. Business aiSettings and communicationPreferences fields are not currently applied to retrieval or prompt construction. The worker never calls WhatsApp, creates outbound Message records, or sends generated content.

## Generation limits and retry behavior

- Maximum generated text: 4096 characters.
- Maximum claimed generation attempts: three.
- Retry delay grows exponentially from a one-second base and is capped at 30 seconds.
- Generation lease duration: 60 seconds.
- Claim and terminal/retry transitions are fenced by business, status, attempt count, and lease state.
- Provider timeouts/rate limits/transient provider failures and transient persistence/context failures may retry within the attempt limit.
- Missing credentials, authentication/permission failures, invalid requests, invalid/empty/oversized output, and other non-retryable categories fail safely.
- The Gemini adapter exposes only safe error categories and strictly allowlisted optional diagnostics; it does not expose arbitrary provider messages or payloads.

The backend reads the optional GEMINI_API_KEY and GEMINI_MODEL settings. The current model default is gemini-3.8-flash, but its availability has not been established by a successful generation. The adapter currently bounds a request to 32,000 input bytes, uses a 15-second timeout and a 1,024-token output ceiling, and rejects generated text over 4,096 characters. Safe diagnostics expose only allowlisted categories/statuses/network codes.

The latest controlled real Gemini attempt reported HTTP 504 (provider_5xx). It was retry-scheduled, generated no persisted draft, and made no WhatsApp call. Mocked adapter/processor tests do not establish real Gemini availability.

## Draft persistence and Human takeover

Draft persistence runs in a MongoDB transaction. It conditionally updates the same business-scoped Conversation document only while responseMode remains ai, advances aiControlVersion, and transitions the matching live job attempt to draft_ready in that transaction. Human takeover and response-mode changes write the same Conversation fence. Inbound messages also advance this fence and invalidate older work. If takeover or a newer inbound write wins, stale draft persistence or approval fails; if draft persistence commits first, the saved draft remains available for owner review.

MongoDB transaction/concurrency coverage against the isolated whatsapp_sales_assistant_test database is project-reported as 16/16 passing. Regular backend tests are project-reported as 130/130 passing, including 40/40 Gemini adapter tests. These results were not rerun for this documentation update and do not establish production database behavior.

## Job states and owner review

The model supports queued, processing, draft_ready, approved, rejected, sending, sent, send_failed, send_uncertain, failed, and cancelled states. Generation currently moves eligible jobs through queued → processing → draft_ready, or to a safe retry/failure/cancelled state. The owner can retrieve, edit-and-approve, or reject drafts through authenticated business-scoped APIs.

Approval does not send. No application-level route or service currently sends an approved AI draft. Internal repository-level send reservation, completion, accepted/rejected/uncertain outcome recording, and expired reservation recovery exist as foundations only. They are not a connected provider send workflow, and they do not make automatic sending possible.

Any future approved-draft sender must use those reservation/fencing operations, call WhatsApp outside database transaction callbacks, persist provider outcomes safely, and treat uncertain provider acceptance as terminal for automatic processing. An uncertain send must never be blindly retried.

## Evidence and limits

- **Implemented/mock-tested:** Gemini adapter, context retrieval, prompt building, processor, worker, queue transitions, owner review routes, response-mode operations, and webhook enqueue behavior have backend tests.
- **Atlas-tested:** project-reported isolated transaction suite passed 16/16 against whatsapp_sales_assistant_test.
- **Real Gemini:** not successfully verified; latest controlled request returned 504 and no draft persisted.
- **Production worker:** source default is false; Render environment was not independently inspected.
- **Browser UI:** AI Drafts end-to-end browser acceptance is not recorded here.

Do not treat a passing mock test, Atlas test, typecheck, or build as proof that a live Gemini draft was successfully generated.
