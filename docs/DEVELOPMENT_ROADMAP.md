# Development Roadmap

## Status and schedule

This is the planned sequence and estimate, reconciled with source and recorded verification. Implementation work for Phases 1–6 is present in the repository; acceptance evidence varies by phase. Gemini/AI behavior and human takeover (Phases 7–8) and deployment/final acceptance (Phase 9) remain pending. Code presence, mock checks, browser testing, and live provider verification are tracked separately below. External accounts and production configuration are not assumed complete. The original 13–16 week estimate is a planning estimate, not a completed schedule.

### Progress and verification summary

| Area | Implementation status | Verification evidence |
|---|---|---|
| Project foundation, auth, profile, catalog, FAQ | Implemented. | Recent typechecks/builds passed; Phase 4 API/UI manual verification was reported by the project team. |
| Conversation/message models and APIs; inbox/composer/history refresh | Implemented. | Recent frontend/backend typechecks and builds passed. Phase 5 browser testing is not recorded as verified. |
| Webhook verification, incoming text ingestion, outgoing text service/API, delivery/read/failure statuses | Implemented in source. | Isolated/mock ingestion and status-transition checks passed; no live Meta callback or WhatsApp send/receive is verified. |
| WhatsApp number configuration and safe failure-detail display | Implemented in source. | Step 5.9.2/5.9.4 typechecks/builds passed; isolated schema/serialization checks passed. No live number verification exists. |
| Gemini response generation and human takeover/resume | Not implemented. | Not tested. |
| Atlas/Meta/WhatsApp production end-to-end flow | Pending live verification. | Not verified by recent implementation checks. |

The repository does not currently provide a repeatable project-wide automated test suite. “Mock-tested” above refers only to the isolated checks stated; it does not mean all APIs or external integrations have been tested.

## Phases

### Phase 1 — Architecture and planning (about 1 week)

- **Status:** Planning documents are present and have been reconciled with current implementation status; outstanding AI and live-integration decisions remain open.

- **Objective:** Agree Version 1.0 scope, data contracts, safety behavior, and unresolved decisions.
- **Dependencies:** Project requirements and team review.
- **Work items:** Review the six docs; decide open questions that block implementation; identify external accounts and test data plan.
- **Acceptance criteria:** Cross-document review passes; owner-approved decisions are recorded; no feature is described as implemented without evidence.
- **Deliverables:** Reviewed architecture, schemas, API design, roadmap, and task list.

### Phase 2 — Project foundations (about 1 week)

- **Status:** Implemented: React/Vite/TypeScript frontend, Express/TypeScript backend, validated backend environment configuration, security middleware, health API, and frontend/backend API client communication.

- **Objective:** Establish a small maintainable frontend/backend development setup.
- **Dependencies:** Phase 1; selected runtime/tool versions.
- **Work items:** Frontend and backend setup, configuration strategy, safe secret handling, basic error handling, linting and formatting.
- **Acceptance criteria:** Both local development processes start; configuration validation fails clearly when required values are missing; no credentials are committed.
- **Deliverables:** Project skeleton, documented local setup, baseline lint/format commands.

### Phase 3 — Database and authentication (about 2 weeks)

- **Status:** Implemented: MongoDB/Mongoose connection, User and Business models, registration/login/JWT, and authenticated frontend flows. Customer, Conversation, and Message models were added with the messaging work. A repeatable automated auth/isolation suite remains pending.

- **Objective:** Persist core data and protect owner access.
- **Dependencies:** Phase 2; MongoDB development connection; approved token design.
- **Work items:** MongoDB Atlas connection, Mongoose models/indexes for seven collections, registration/login, bcrypt, JWT middleware, validation, rate limiting, tenant isolation.
- **Acceptance criteria:** Owner can register/login; unique email/workspace constraints work; unauthorized and cross-business requests are rejected; secrets/hashes are not returned.
- **Deliverables:** Data layer, authentication APIs/UI, automated tests for auth and isolation.

### Phase 4 — Business configuration (about 1–2 weeks)

- **Status:** Implemented: business profile, catalog and FAQ APIs/pages, including catalog pagination. Phase 4 API/UI manual testing is reported by the project team. Automated regression tests, AI settings, and communication preferences remain pending.

- **Objective:** Let the owner maintain business facts for the future AI response flow.
- **Dependencies:** Phase 3.
- **Work items:** Business profile, products/services, FAQs, AI settings and communication preferences; integer paise handling for INR.
- **Acceptance criteria:** Owner can create/read/update scoped records; invalid money and cross-business references are rejected. When AI retrieval is implemented, inactive facts must be excluded from its context.
- **Deliverables:** Business configuration APIs and screens, validation tests.

### Phase 5 — Inbox and messaging UI (about 2 weeks)

- **Status:** Implemented: conversation list/history APIs, pagination, frontend inbox, older-history loading, owner text composer, status labels, failed-message title display, and manual history refresh. Typechecks/builds passed in recent steps; browser verification is not recorded as complete.

- **Objective:** Provide an owner-facing customer inbox/history and manual message interface.
- **Dependencies:** Phase 3; basic UI patterns from Phase 2.
- **Work items:** Conversation list/details, message history and pagination, status/error display, and owner-triggered text sending.
- **Acceptance criteria:** Implemented in source; browser and live end-to-end acceptance remain to be recorded.
- **Deliverables:** Inbox/dashboard screens, conversation APIs, manual composer.

### Phase 6 — WhatsApp integration (about 2–3 weeks)

- **Status:** Integration code is implemented: optional backend Meta configuration, safe business Phone Number ID settings, GET challenge and POST signature verification, incoming text ingestion, outgoing text send, and status processing. Meta/WhatsApp live setup and verification remain pending.

- **Objective:** Receive and send messages using an authorized Meta test setup.
- **Dependencies:** Phase 5; Meta app/number, credentials, public HTTPS URL; current Meta requirements reviewed.
- **Work items:** Secure configuration, GET challenge, raw-body POST signature validation, payload normalization, customer/conversation creation, duplicate handling, outbound text sends, delivery-status events.
- **Acceptance criteria:** Mock/isolated status checks are reported as passed. Live webhook verification, controlled inbound/outbound test messages, provider status reflection, and failure behavior remain pending.
- **Deliverables:** WhatsApp adapter and a future authorized live test record. Do not mark external integration complete until verified.

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

The following is the continuing test plan. Recent frontend/backend typechecks and production builds passed. Isolated mocked status-ingestion and number-configuration checks are reported as passed. Phase 4 manual testing is reported by the project team; Phase 5 browser verification and all live provider checks remain unverified. A repeatable automated test suite is not yet present in the repository.

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
