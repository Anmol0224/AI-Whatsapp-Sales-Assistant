# Development Tasks

## Completed documentation and foundation work

- [x] Inspect repository structure, `.gitignore`, Git history, and status.
- [x] Review and finalize the six Phase 1 planning documents.
- [x] Record planned architecture, database/API design, roadmap, open questions, and implementation checklist.
- [x] Establish the React/Vite/TypeScript frontend and Node.js/Express/TypeScript backend foundations, including environment validation, security middleware, and health API.
- [x] Configure MongoDB/Mongoose connection and implement User and Business models, registration, login, JWT authentication, and frontend auth/session handling.
- [x] Implement CatalogItem and FAQ models with business-scoped APIs.
- [x] Implement authenticated Business Profile, catalog, and FAQ management APIs and frontend pages; catalog listing includes pagination.

Completed items above reflect code present in the repository. Manual verification of Phase 4 APIs/UI is reported by the project team. Automated tests and external WhatsApp/Gemini integrations are not implied by these checkmarks.

## Pending — Decisions and planning follow-up

- [ ] Review/approve the six documents and Version 1.0 boundaries.
- [ ] Confirm the production JWT lifetime policy and whether refresh tokens or server-side revocation are needed; the current frontend stores access tokens in sessionStorage and the backend defaults to a one-hour lifetime.
- [ ] Decide Meta credential provisioning/storage for the demo.
- [ ] Select Gemini model, context/token limits, and automatic versus owner-approved reply behavior.
- [ ] Decide whether any fallback clarification may be automatically sent after Gemini failure.
- [ ] Approve message/phone retention, deletion, backup, and production erasure policies.
- [ ] Confirm customer conversation closure/reuse policy and handling for malformed Meta events.
- [ ] Confirm accounts, regions, and test-data approach for MongoDB Atlas, Meta, Gemini, Vercel, and Render.

## Pending — Implementation tasks

### Foundations, database, and authentication

- [ ] Implement Mongoose models for customers, conversations, and messages, with reviewed indexes and parent/child ownership validation.
- [ ] Confirm production secret provisioning and deployment configuration; do not commit credentials.
- [ ] Add cross-business authorization tests.

### Remaining business configuration and owner UI

- [ ] Implement AI settings and communication preference APIs/screens after their behavior is approved.
- [ ] Decide whether deactivated catalog items and FAQs need an owner-facing reactivation workflow; current APIs support soft deactivation but not reactivation.
- [ ] Implement customer list, conversation inbox, and paginated message history.
- [ ] Show owner-visible message processing and error states.
- [ ] Add customer data deletion flow after retention/deletion policy is approved.

### WhatsApp and message processing

- [ ] Implement GET webhook challenge verification and raw-body POST signature verification.
- [ ] Normalize inbound messages and delivery-status events; handle malformed/unsupported events safely.
- [ ] Create/retrieve customers and reuse/create conversations according to agreed lifecycle rules.
- [ ] Enforce provider-message idempotency and test duplicate webhook deliveries.
- [ ] Implement owner outbound messages and delivery-status synchronization.
- [ ] Persist processing status, retry count, timestamps, and sanitized error details.
- [ ] Implement bounded AI retry and owner-initiated manual retry.
- [ ] Recover stale pending work best-effort; represent ambiguous sends as unknown and do not blindly resend.
- [ ] Test owner-visible processing and owner-visible failure states.

### Gemini, takeover, verification, and deployment

- [ ] Implement bounded business-context retrieval with the latest relevant messages (target 10–15, subject to token limits).
- [ ] Implement controlled system prompt and Gemini adapter with server-only credentials.
- [ ] Add AI grounding tests and unknown-information handling tests.
- [ ] Test invented price, stock, discount, and policy prevention; add prompt-injection tests.
- [ ] Validate Gemini response and make provider failures visible without claiming send success.
- [ ] Implement atomic MongoDB coordination for takeover request, dispatch claim, mode update, and resume.
- [ ] Add human takeover race tests for generation and in-flight send.
- [ ] Add unit/API/webhook/integration/end-to-end tests using mocks and authorized non-production accounts.
- [ ] Deploy to Vercel/Render with Atlas only after account/secret configuration; verify complete flow and document demo evidence.

## Deferred to semester four — not current implementation tasks

- [ ] Automated follow-ups and scheduled reminders.
- [ ] Advanced customer behavior analysis.
- [ ] Lead scoring and sales prediction.
- [ ] Bulk marketing campaigns.
- [ ] Payment integration.
- [ ] Voice AI.
- [ ] Multi-agent AI systems.
