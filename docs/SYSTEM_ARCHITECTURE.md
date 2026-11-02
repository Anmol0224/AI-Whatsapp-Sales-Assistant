# System Architecture

## Current status

The React/Vite/TypeScript frontend communicates with an Express/TypeScript API. MongoDB/Mongoose stores owner, business, catalog, FAQ, customer, conversation, message, and AI reply job data. Meta webhook ingestion and manual WhatsApp messaging are implemented. A draft-only Gemini pipeline and owner review controls are also implemented in source. Neither draft approval nor AI mode sends a WhatsApp message.

### Verification evidence

- Backend unit/mocked tests: latest project-reported result 130/130 passed, including 40/40 Gemini adapter tests. Not rerun in this documentation task.
- Isolated MongoDB Atlas transaction suite: project-reported result 16/16 passed against whatsapp_sales_assistant_test; this does not establish production Atlas behavior.
- WhatsApp: real inbound and outbound messaging was reported by the project team. Meta Verify and Save failures were also reported, and the end-to-end flow was not independently re-tested here.
- Gemini: the latest controlled real generation returned HTTP 504 (provider_5xx) and persisted no draft. A successful real generation is unverified.
- Browser-level acceptance of the AI Drafts experience is not evidenced here.

## High-level architecture

~~~mermaid
flowchart LR
      Owner[Business owner] -->|HTTPS, REST, JWT| Web[React + Vite frontend]
      Web --> API[Express API]
      API --> Auth[JWT authentication and business scope]
      API --> Biz[Business profile, catalog, FAQ]
      API --> Inbox[Conversation, message, manual send APIs]
      API --> Review[AI draft retrieval, approval, rejection, response mode]
      Auth --> DB[(MongoDB Atlas via Mongoose)]
      Biz --> DB
      Inbox --> DB
      Review --> DB
      Meta[Meta WhatsApp Cloud API] -->|Signed webhook| Hook[Webhook verification and ingestion]
      Hook --> DB
      Inbox -->|Owner-triggered manual text| Meta
      Hook -->|Eligible inbound text + global gate| Jobs[Durable AI reply job]
      Jobs --> Worker[Optional draft worker]
      Worker --> Context[Business context and prompt builder]
      Context --> DB
      Worker -->|Server-side generation| Gemini[Google Gemini API]
      Worker -->|draft_ready only| DB
      Review -->|Owner reviews/edits/approves| Web
      Review -. approval does not send .-> DB
~~~

The worker gate defaults to false in source and controls both job enqueueing and worker execution. Do not infer the current Render environment setting from this default; it was not independently inspected. The required production posture is to keep AI automatic replies disabled. There is no automatic reply/sending path.

## Component responsibilities

| Component | Current responsibility |
|---|---|
| Frontend | Registration/login, dashboard, profile/WhatsApp number settings, catalog and FAQ management, manual inbox/composer, and AI Drafts list/review/edit/approve/reject plus response-mode display/control. It holds no provider API keys. |
| Express API | Authentication, business-scoped REST APIs, WhatsApp webhook, manual message send, AI draft retrieval/approval/rejection, response-mode operations, validation, rate limiting, and safe errors. |
| Business knowledge services | Load business profile, active catalog/FAQs, customer display name, exact triggering inbound message, and bounded recent history for a business/conversation. Prompt builder bounds and frames approved data as untrusted reference text. |
| WhatsApp integration | Raw-body signature verification, supported text ingestion, status processing, and owner-triggered manual outgoing text. The manual send path is separate from AI draft approval. |
| AI job repository and worker | Durable, business-scoped queue; atomic claims; leases/attempt fencing; retry/failure handling; AI mode checks; transactional draft persistence. The worker generates drafts only. |
| Gemini adapter | Official @google/genai SDK adapter, backend key, configurable model, bounded request/response, safe error categories and allowlisted diagnostics. A real successful generation is not yet verified. |
| MongoDB/Mongoose | Stores application state and declared indexes. The isolated Atlas transaction suite is project-reported passing; production topology/index state is not asserted by that suite. |

## Incoming WhatsApp and enqueue flow

1. Public GET webhook handles Meta challenge verification; public POST verifies X-Hub-Signature-256 over raw request bytes before parsing.
2. Supported inbound text is mapped to a business using persisted whatsapp.phoneNumberId; the webhook payload does not choose a business ID.
3. A MongoDB transaction resolves/creates the scoped customer and conversation, persists the new inbound message, increments the conversation aiControlVersion, and conditionally creates its unique AI reply job.
4. Job creation requires both AI_DRAFT_WORKER_ENABLED=true and responseMode=ai. Duplicate provider message deliveries do not create another message/job or increment the fence again. With the global gate false, normal inbound message persistence continues without an AI job.
5. No Gemini or WhatsApp provider call occurs in this ingestion transaction. If eligible job creation fails, the transaction aborts so the new inbound message and related changes do not partially persist.

## Draft-generation flow

1. When enabled and credentials are configured, the worker recovers expired leases and atomically claims one eligible queued job.
2. It checks business/conversation ownership and AI mode, retrieves bounded relevant context, builds the guarded prompt, and calls Gemini outside MongoDB transaction callbacks.
3. It validates generated text and stores it as generatedDraft with draft_ready. Draft persistence uses a transaction and the same conversation aiControlVersion write fence as human takeover and inbound messages.
4. Retries are bounded and attempt/lease-fenced. Unknown or transient provider failures may schedule retries; terminal configuration/validation cases fail safely. No provider message is sent and no outbound Message is created by this generation flow.

The prompt directs the model to use only supplied facts, not invent prices, stock, policies, discounts, availability, or promises; treat customer and retrieved text as untrusted data; and return only a concise proposed draft. Prompt instructions reduce risk but do not guarantee correctness. Every draft requires owner review.

## Review, response mode, and sending boundary

The authenticated owner can list/retrieve drafts, edit text during approval, reject a draft, and switch a conversation between Human and AI mode. Approval/rejection are one-time business-scoped transitions. Inbound persistence, draft persistence, approval, and response-mode changes use aiControlVersion and transactional/conditional writes to fence stale drafts. Human takeover prevents a stale generated draft from being newly persisted or approved. Atlas transaction/concurrency coverage is project-reported as passing in the isolated test database.

**Approval does not send.** The repository contains internal operations for send reservation, completion, recording accepted/rejected/uncertain outcomes, and recovering expired reservations. These operations are not wired to an application-level approved-draft sending service or route. No frontend AI-draft Send action exists. Sending approved AI drafts is pending.

When that path is implemented, it must use a one-time atomic reservation, perform the provider call outside the transaction, persist the provider outcome safely, and never blindly retry an ambiguous result. Existing manual owner text sending remains a separate working feature; its reported live use does not verify the missing AI-draft send flow.

## Worker lifecycle and deployment boundary

AI_DRAFT_WORKER_ENABLED is a backend setting that defaults to false. Source checks it before starting the worker and before enqueueing jobs. Startup also requires GEMINI_API_KEY; missing credentials leave the API available and the worker stopped. If the global flag is true but the key is absent, eligible inbound messages may still enqueue while the worker does not start, so a non-production test must configure both together. Production Render configuration has not been inspected for this audit; keep the production worker gate false as required.

The project does not promise exactly-once external delivery. The application-level AI sending flow and its uncertainty UX remain unimplemented. The test suite includes mock/unit tests and an isolated Atlas transaction suite; no frontend test runner or recorded AI Drafts browser acceptance result exists.

## Business isolation and security

- Protected requests derive businessId and userId from verified JWT claims.
- Webhook business identity is resolved only through the persisted WhatsApp Phone Number ID mapping.
- Every customer/conversation/message/job query and write must include business scope and validate parent-child ownership.
- Meta and Gemini credentials stay in backend environment configuration; secrets are not stored in business/catalog/message/job records or returned to the frontend.
- Webhook signature verification uses the original raw body. Logs avoid secrets, full payloads, and customer message text.
- Customer phone numbers and messages are personal data; retention, deletion, backups, and erasure policy still need owner approval.

## Deferred semester-four features

Automated follow-ups and scheduled reminders, lead scoring, sales predictions, bulk campaigns, payments, voice AI, and multi-agent features remain deferred. No microservices, Redis, Kafka, Kubernetes, or separate queue infrastructure is required for the current scope.
