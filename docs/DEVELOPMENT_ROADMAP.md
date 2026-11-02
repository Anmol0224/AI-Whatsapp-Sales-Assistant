# Development Roadmap

## Progress and evidence

This roadmap reflects source inspection and recorded project test reports. It does not treat code presence as proof of live integration. Verification results below were supplied by the project team and were not rerun during this documentation update.

| Work area | Implementation status | Verification evidence |
|---|---|---|
| Project foundation and authentication | Implemented: React/Vite/TypeScript, Express/TypeScript, MongoDB/Mongoose, auth and protected frontend flows. | Recent builds/typechecks reported passing; backend test suite exists. |
| Business profile, catalog, and FAQ | Implemented in backend and frontend, including business-scoped APIs and catalog pagination. | Phase 4 manual API/UI testing was reported by the project team; automated frontend/browser evidence is not in the repository. |
| WhatsApp webhook and inbox | Implemented: callback verification/signatures, inbound text ingestion/status events, conversation/history APIs, manual outgoing text endpoint, inbox/composer. | Project previously reported live inbound and outbound WhatsApp messages. A separate Meta Verify and Save issue was reported; full end-to-end acceptance is not established. |
| AI job queue and takeover fence | Implemented: transactional webhook enqueue under the global gate and AI mode, job claims/leases, conversation control fence, stale-draft checks. | Project-reported isolated Atlas transaction suite: 16/16 passed. Regular backend suite: 130/130 reported. |
| Gemini adapter, context, prompt, and draft processor | Implemented in source; worker creates owner-review drafts only. | Mock/unit tests reported passing (Gemini subset 40/40); controlled real Gemini generation last returned HTTP 504 and saved no draft. |
| Draft review UI and APIs | Implemented in source: list/detail, source inbound message, edit/approve/reject, response-mode read/update. | Backend test/build evidence is reported. AI Drafts browser acceptance is not evidenced. |
| Approved AI draft sending | Not implemented at application/API/UI level. Internal repository send reservation/completion/outcome/recovery functions exist. | Repository-level transaction behavior has Atlas integration coverage, but no application provider send flow exists to accept as end-to-end tested. |
| Production worker state | Source default is disabled. | Render environment configuration was not independently inspected; do not claim the deployed flag value is verified. |

The latest controlled real Gemini test reported a 504 provider_5xx response, one generation attempt, retry scheduling, and no persisted draft. No successful real Gemini generation has been demonstrated.

## Implemented areas

The project foundation, authentication, business management, WhatsApp messaging/inbox, and Phase 6 draft-first AI components are present in source. The Phase 6 source includes the adapter, context/prompt services, worker, transactional webhook enqueue, review APIs/UI, and response-mode controls. Presence in source is not the same as successful live provider operation.

No Step 6.11 is specified in the inspected roadmap. The remaining work below is organized by dependency and deliverable; it does not assign a historical step number.

## Remaining work in dependency order

### 1. Complete controlled Gemini generation proof

**Required for a functioning AI-draft MVP demo.**

- Resolve or investigate the reported HTTP 504 in an isolated test setup.
- Run the existing one-job harness only after reviewing its current safety and isolation safeguards.
- Use synthetic business/customer/message data and the isolated test database.
- Confirm one successful real draft is persisted, is within bounds, leaves the conversation in AI mode, and creates no outbound message.
- Keep worker activation restricted to a controlled non-production environment. The production worker setting has not been verified and must remain disabled per project policy.

**Acceptance evidence:** a sanitized test result that identifies the isolated database, one processed job, persisted draft, and zero outbound/WhatsApp calls; never include secrets, prompts, or private messages.

### 2. Implement explicit sending for an approved AI draft

**Required for an end-to-end third-semester owner-reviewed messaging flow.**

- Add an authenticated owner-triggered application service/API for an already approved, still-current draft.
- Integrate existing repository reservation/completion/outcome/recovery functions with the WhatsApp Cloud API adapter.
- Revalidate business ownership, AI mode/control version, approval status, and send reservation atomically before the provider call.
- Call Meta outside MongoDB transaction callbacks.
- Persist accepted provider message provenance and conversation summary safely.
- Make definitive rejection and uncertain outcome distinct. Never automatically retry an ambiguous send.
- Do not treat approval or switching AI mode as consent to send.

**Acceptance evidence:** provider-mocked route/service tests, isolated Atlas concurrency/rollback tests, and no duplicated outbound message under concurrent owner requests.

### 3. Add the owner send-confirmation UI

**Depends on Step 2 above.**

- Show an explicit Send approved draft action only for eligible approved drafts.
- Require a clear owner confirmation.
- Show in-progress, definitive failure, success, and uncertain states.
- On uncertain outcome, instruct the owner to check the conversation before taking action; do not offer automatic resend.
- Preserve the existing manual Inbox send flow and keep AI drafts separate from automatic replies.

### 4. Verify race, API, and failure behavior

**Required reliability work.**

- Expand tests for AI-draft send versus Human takeover, repeated/concurrent sends, provider timeout after possible acceptance, persistence failure after provider acceptance, and lease recovery.
- Keep real MongoDB transaction tests isolated to the exact test database and unique fixtures.
- Add regression tests for current ingestion, approval/rejection, stale draft fencing, webhook idempotency, and business isolation.
- Mock Gemini and WhatsApp in ordinary tests. Do not use production credentials or send real messages in automated tests.

Some existing Atlas tests already cover repository send reservations/completion and takeover races; those do not replace tests of the missing application-level route/service.

### 5. Perform browser and controlled staging acceptance

**Depends on implementation and tests above.**

- Browser-test login/session restoration, business settings, inbox/history pagination, manual send, AI Drafts list/detail/edit/approve/reject, response-mode switching, and the explicit approved-draft send UI.
- Use non-production business data and authorized provider test resources.
- Verify WhatsApp webhook subscription/verification and controlled inbound/status/outbound messages.
- Verify one successful Gemini draft before testing the complete draft-to-send path.
- Record expected/actual results, environment class (test/staging), and sanitized evidence.
- Keep automatic replies disabled; production worker configuration requires separate deployment review and remains disabled.

### 6. Final security, privacy, and release review

- Confirm production environment values privately without exposing them in logs or reports.
- Review rate limits, webhook signature behavior, role/business scoping, safe diagnostics, retention/deletion, backup, and incident/rollback steps.
- Reconcile docs and final demo/report claims to the evidence collected.
- Do not claim production AI worker state based on source defaults.

## Testing inventory

- **Backend unit/mocked:** project-reported 130/130 tests passing, including 40/40 Gemini adapter tests. Not rerun during this documentation update.
- **MongoDB Atlas integration:** project-reported 16/16 transaction/concurrency tests passing against the isolated whatsapp_sales_assistant_test database. Not production verification and not rerun here.
- **Frontend automated tests:** no frontend test script or test suite was found in the package/repository inspection.
- **Frontend browser acceptance:** not evidenced for the complete AI Drafts flow.
- **Live WhatsApp:** bidirectional live messaging was reported by the project team; Meta Verify and Save has also been reported as unresolved. No full AI-draft send flow exists.
- **Live Gemini:** last controlled attempt returned HTTP 504; no successful draft is verified.

## Deferred to fourth semester

Automated follow-ups and scheduled reminders, lead scoring, sales predictions, bulk campaigns, payment integration, voice AI, and multi-agent features remain out of scope.
