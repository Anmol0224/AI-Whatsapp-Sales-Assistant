# Development Roadmap

## Status and schedule

This is a proposed student-team sequence, not a completed schedule or implementation. A realistic initial estimate is about 13–16 weeks for a small team working alongside coursework, with integration and debugging buffers; provider setup delays may extend it. No phase should be marked complete until its acceptance criteria are demonstrated.

## Phases

### Phase 1 — Architecture and planning (about 1 week)

- **Objective:** Agree Version 1.0 scope, data contracts, safety behavior, and unresolved decisions.
- **Dependencies:** Project requirements and team review.
- **Work items:** Review the six docs; decide open questions that block implementation; identify external accounts and test data plan.
- **Acceptance criteria:** Cross-document review passes; owner-approved decisions are recorded; no feature is described as implemented without evidence.
- **Deliverables:** Reviewed architecture, schemas, API design, roadmap, and task list.

### Phase 2 — Project foundations (about 1 week)

- **Objective:** Establish a small maintainable frontend/backend development setup.
- **Dependencies:** Phase 1; selected runtime/tool versions.
- **Work items:** Frontend and backend setup, configuration strategy, safe secret handling, basic error handling, linting and formatting.
- **Acceptance criteria:** Both local development processes start; configuration validation fails clearly when required values are missing; no credentials are committed.
- **Deliverables:** Project skeleton, documented local setup, baseline lint/format commands.

### Phase 3 — Database and authentication (about 2 weeks)

- **Objective:** Persist core data and protect owner access.
- **Dependencies:** Phase 2; MongoDB development connection; approved token design.
- **Work items:** MongoDB Atlas connection, Mongoose models/indexes for seven collections, registration/login, bcrypt, JWT middleware, validation, rate limiting, tenant isolation.
- **Acceptance criteria:** Owner can register/login; unique email/workspace constraints work; unauthorized and cross-business requests are rejected; secrets/hashes are not returned.
- **Deliverables:** Data layer, authentication APIs/UI, automated tests for auth and isolation.

### Phase 4 — Business configuration (about 1–2 weeks)

- **Objective:** Let the owner maintain the facts used by AI.
- **Dependencies:** Phase 3.
- **Work items:** Business profile, products/services, FAQs, AI settings and communication preferences; integer paise handling for INR.
- **Acceptance criteria:** Owner can create/read/update scoped records; invalid money and cross-business references are rejected; inactive facts are excluded from retrieval.
- **Deliverables:** Business configuration APIs and screens, validation tests.

### Phase 5 — Inbox and messaging UI (about 2 weeks)

- **Objective:** Build the owner-facing customer/inbox/history experience before live messaging.
- **Dependencies:** Phase 3; basic UI patterns from Phase 2.
- **Work items:** Customer list, conversation list/details, message history and pagination, processing/error status display, simulated messages for frontend/backend testing.
- **Acceptance criteria:** Simulated inbound/outbound data appears in correct order; owner can inspect status; pagination and business isolation work.
- **Deliverables:** Inbox/dashboard screens, conversation APIs, test fixtures or development-only simulated events.

### Phase 6 — WhatsApp integration (about 2–3 weeks)

- **Objective:** Receive and send messages using an authorized Meta test setup.
- **Dependencies:** Phase 5; Meta app/number, credentials, public HTTPS URL; current Meta requirements reviewed.
- **Work items:** Secure configuration, GET challenge, raw-body POST signature validation, payload normalization, customer/conversation creation, duplicate handling, outbound text sends, delivery-status events.
- **Acceptance criteria:** Test webhook verification succeeds; duplicate event creates one message; test number receives a controlled inbound and outbound message; statuses are reflected; failures are visible.
- **Deliverables:** WhatsApp adapter and tested webhook/send flows. If Meta access is unavailable, document as blocked external dependency rather than completed.

### Phase 7 — Gemini integration (about 2 weeks)

- **Objective:** Generate bounded, grounded responses from business context.
- **Dependencies:** Phase 4 and 6; Gemini account/key; chosen model/limits and approved send behavior.
- **Work items:** Business-context retrieval, 10–15 message window subject to token limit, controlled prompt construction, response validation, bounded failure handling, controlled response tests.
- **Acceptance criteria:** Tests check grounding, unknown info, invented prices/stock/discounts, prompt injection, insufficient facts, and Gemini outage; API key remains server-side.
- **Deliverables:** Gemini adapter, prompt/context service, AI behavior and failure tests.

### Phase 8 — Human takeover and end-to-end hardening (about 2 weeks)

- **Objective:** Coordinate owner control and complete the full message path safely.
- **Dependencies:** Phases 3–7.
- **Work items:** AI pause/resume, database-backed dispatch/takeover coordination, stale processing recovery, manual retry, error visibility, privacy/security review, end-to-end testing.
- **Acceptance criteria:** Takeover before dispatch prevents sending; in-flight dispatch leaves takeover pending until resolved; ambiguous sends are not automatically resent; restart/retry behavior is visible and bounded; complete test-number flow works.
- **Deliverables:** Takeover/resume workflow, retry/recovery behavior, end-to-end and race tests, known-limitations record.

### Phase 9 — Deployment and documentation (about 1–2 weeks)

- **Objective:** Prepare an authorized demonstration and final project report.
- **Dependencies:** Prior acceptance criteria; Vercel, Render, MongoDB Atlas and provider account access.
- **Work items:** Deploy frontend to Vercel and backend to Render; configure production secrets privately; verify HTTPS webhook, CORS, database access, and logs; complete documentation/report/demo preparation.
- **Acceptance criteria:** Authorized non-production accounts can complete the demo; no secrets are exposed; deployment and rollback/configuration steps are documented; deferred scope is not implemented.
- **Deliverables:** Deployed demo if accounts are available, final report, test evidence, demonstration plan.

## Testing strategy

Testing is planned; no tests have been written or run in this planning repository.

- Use Postman for manual REST/auth/webhook-path exploration and appropriate automated unit/API/integration tests for repeatable checks.
- Unit-test validation, integer-paise handling, authorization, prompt assembly, webhook normalization, deduplication, state transitions, and retry eligibility.
- Integration-test MongoDB constraints and API business isolation; mock Gemini/Meta in ordinary CI tests.
- Test webhook verification/signature failures, malformed payloads, duplicate events, and status updates.
- AI behavior tests cover grounding, unknown-information handling, no invented prices/stock/discounts, prompt injection, context limits, empty/invalid output, and provider outage. Do not require exact model wording.
- Race tests cover takeover during generation and during outbound dispatch, plus restart/ambiguous outcome behavior.
- End-to-end test with authorized non-production Meta/Gemini accounts: inbound → persist → AI context/generation → send → status/history, and then takeover/resume.
- Security/privacy checks cover secret handling, bcrypt, rate limits, cross-business access, log redaction, and approved deletion behavior.

## Dependencies and guardrails

- External accounts, quotas, credentials, Meta number setup, and deployment are not assumed ready.
- Confirm current Meta policy, webhook and messaging-window rules from official material when the integration phase begins.
- Avoid Redis, Kafka, Kubernetes, microservices, vector databases, and external job queues for this semester.
- No guaranteed background processing or exactly-once external delivery is promised. Persist states, use bounded retries, make ambiguous results visible, and avoid blind resend.
- Semester-four features remain deferred.
