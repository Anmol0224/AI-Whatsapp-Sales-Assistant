# Development Tasks

## How to read status

Implementation checkmarks mean source functionality is present. They do not by themselves mean the feature was browser-tested or verified against a live provider. Test results here are project-reported unless explicitly marked otherwise; this documentation update did not run tests or connect to services.

## Verification evidence

| Category | Recorded evidence |
|---|---|
| Backend mock/unit tests | Latest project-reported regular suite: 130/130 passed. Gemini adapter tests: 40/40 passed (included in the regular suite report). |
| MongoDB Atlas transactions | Project reports 16/16 integration tests passing against the isolated whatsapp_sales_assistant_test database. This does not prove production database/index state. |
| Typecheck/build | Backend typecheck/build and frontend typecheck/build have been reported passing in recent work. Not rerun for this documentation task. |
| Live WhatsApp | Project previously reported real inbound and outbound WhatsApp messages. Separate Meta Verify and Save failures were reported; do not claim full live setup is verified. |
| Live Gemini | Latest controlled real generation returned HTTP 504 provider_5xx; the job was retry-scheduled and no draft persisted. No successful real Gemini draft is demonstrated. |
| Browser acceptance | No recorded full browser acceptance for the AI Drafts flow. No frontend automated test script/suite was found. |
| Production worker configuration | Source default is false. Render's current environment setting was not independently inspected; verify privately and keep it disabled. |

## Implemented in source

### Foundation and business workspace

- [x] React/Vite/TypeScript frontend and Express/TypeScript backend foundation.
- [x] Validated backend environment configuration, security middleware, health endpoint, and frontend/backend API client.
- [x] MongoDB/Mongoose connection and User/Business models.
- [x] Registration, login, bcrypt password hashing, JWT middleware, and frontend session handling.
- [x] Business profile and one-number WhatsApp configuration APIs/UI.
- [x] Catalog Item and FAQ models, scoped CRUD APIs, and management pages.

### WhatsApp inbox and messaging

- [x] Customer, Conversation, and Message models with business-scoped indexes.
- [x] Meta webhook GET verification and POST raw-body signature verification.
- [x] Supported incoming text ingestion, customer/conversation reuse, provider-message idempotency, and delivery/read/failure status updates.
- [x] Business-scoped conversation listing and paginated message history APIs.
- [x] Frontend Inbox, older-history loading, manual text composer, status/failure display, and manual refresh.
- [x] Owner-triggered manual WhatsApp text send API; this is separate from AI draft sending.
- [x] Backend automated tests, including focused webhook, status, and business-isolation behavior.

### Draft-first AI workflow

- [x] Official Google GenAI SDK adapter with optional backend-only credentials, model configuration, bounded request/output, safe error categories, and allowlisted diagnostics.
- [x] Business-scoped context retrieval from profile, active catalog/FAQs, exact source inbound message, customer display name, and bounded recent history.
- [x] Controlled prompt builder that frames retrieved and customer text as untrusted data and instructs the model not to invent unsupported facts.
- [x] Durable AI reply job model/repository, leases, attempt fencing, bounded retry/backoff, and worker lifecycle.
- [x] Atomic inbound message + conversation aiControlVersion fence + eligible AI job transaction, gated by AI_DRAFT_WORKER_ENABLED and AI response mode.
- [x] Transactional draft persistence coordinated with Human takeover and response-mode transitions.
- [x] Business-scoped AI draft list/detail/conversation retrieval APIs, exact source message serialization, approve/edit and reject APIs.
- [x] Authenticated response-mode read/update APIs.
- [x] Frontend AI Drafts review page with list/filter/pagination, exact source inbound message, editing, approval/rejection, and response-mode controls.
- [x] Backend unit/mocked and isolated Atlas transaction tests as reflected in the verification table.

## Pending — required third-semester MVP work

### 1. Real Gemini draft proof

- [ ] Resolve the reported 504 provider response in a controlled non-production test.
- [ ] Run the one-job harness only against the isolated test database with synthetic fixtures after reviewing its safety.
- [ ] Demonstrate one successful real generation and persisted draft, with zero outbound messages and no WhatsApp call.
- [ ] Keep the production worker disabled; do not infer the Render setting from the source default.

### 2. Application-level approved-draft sending

- [ ] Add an authenticated explicit send operation for an already approved and still-current AI draft.
- [ ] Wire the service/API to existing repository send reservation/completion/outcome/recovery functions and the WhatsApp Cloud API adapter.
- [ ] Preserve business scoping, AI-mode/control-version fence, approval state, single active send, and one-time reservation.
- [ ] Persist provider acceptance and outbound Message provenance safely.
- [ ] Distinguish definitive rejection from uncertain provider outcomes and never automatically retry an ambiguous send.
- [ ] Ensure approval alone never calls WhatsApp.

### 3. Owner-facing send confirmation

- [ ] Add a clearly separate owner-confirmed Send action for eligible approved drafts after the backend flow exists.
- [ ] Show loading, success, definitive failure, and uncertain states.
- [ ] On uncertainty, require owner inspection before any further action; no automatic resend.
- [ ] Keep automatic AI replies disabled and preserve the existing manual Inbox send behavior.

### 4. Verification and acceptance

- [ ] Add provider-mocked tests for the approved-draft sending route/service and failure boundaries.
- [ ] Add isolated Atlas transaction/concurrency tests for concurrent sends, takeover races, rollback, message provenance, and ambiguous outcomes.
- [ ] Add focused browser acceptance coverage or record a repeatable manual browser checklist for the AI Drafts workflow and explicit send flow.
- [ ] Verify the complete non-production sequence: inbound → persisted eligible job → successful Gemini draft → owner review/approval → explicit send → message/status history.
- [ ] Keep real WhatsApp/Gemini tests manual and controlled; never claim live success based only on mocks or build results.

### 5. Release, privacy, and documentation

- [ ] Privately verify production environment configuration and keep AI_DRAFT_WORKER_ENABLED false in production.
- [ ] Resolve/record Meta Verify and Save status and current provider setup.
- [ ] Approve customer phone/message retention, deletion, backup, and erasure policies.
- [ ] Reconcile final deployment, rollback, and project report claims to captured evidence.

## Open decisions / maintenance

- [ ] Define whether deactivated catalog items/FAQs need an owner reactivation workflow.
- [ ] Decide whether business-level AI settings and communication preferences will be used in this semester; currently the model has fields but no owner API/UI or effective prompt behavior for those settings.
- [ ] Define secure operational handling and rotation for provider credentials.
- [ ] Decide customer conversation closure/reuse and data deletion behavior.

## Deferred to fourth semester

- [ ] Automated follow-ups and scheduled reminders.
- [ ] Lead scoring and sales predictions.
- [ ] Bulk campaigns.
- [ ] Payments.
- [ ] Voice AI.
- [ ] Multi-agent features.
