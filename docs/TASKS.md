# Development Tasks

## Progress status and verification

Checkboxes below describe implementation status. They do not imply browser testing or live external integration.

| Verification type | Current evidence |
|---|---|
| Typecheck/build | Recent frontend and backend typechecks and production builds passed during Steps 5.8–5.9. |
| Mocked/isolated checks | Status ingestion/transitions and WhatsApp number validation/safe serialization checks are reported as passed. These do not cover every API path. |
| Browser testing | Phase 4 management API/UI manual testing is reported by the project team. Phase 5 inbox/status refresh and WhatsApp settings browser verification are not recorded as complete. |
| Live Atlas/Meta/WhatsApp | Not verified as a complete live integration. Code presence and mock checks are not live provider evidence. |

There is no repeatable project-wide automated test suite configured yet.

## Completed documentation and foundation work

- [x] Inspect repository structure, `.gitignore`, Git history, and status.
- [x] Review and finalize the six Phase 1 planning documents.
- [x] Record planned architecture, database/API design, roadmap, open questions, and implementation checklist.
- [x] Establish the React/Vite/TypeScript frontend and Node.js/Express/TypeScript backend foundations, including environment validation, security middleware, and health API.
- [x] Configure MongoDB/Mongoose connection and implement User and Business models, registration, login, JWT authentication, and frontend auth/session handling.
- [x] Implement CatalogItem and FAQ models with business-scoped APIs.
- [x] Implement authenticated Business Profile, catalog, and FAQ management APIs and frontend pages; catalog listing includes pagination.
- [x] Implement Customer, Conversation, and Message models with business-scoped indexes.
- [x] Implement paginated conversation/history APIs and the authenticated frontend inbox, older-history loading, manual text composer, status labels, and manual history refresh.
- [x] Implement optional Meta configuration, WhatsApp webhook verification/signature checks, incoming text ingestion, manual outgoing text messaging, and delivery/read/failure status processing.
- [x] Add authenticated WhatsApp Phone Number ID/display-number configuration and safe failure-detail serialization/display.

Completed items reflect code present in the repository. Meta/WhatsApp provider setup, live delivery, browser verification of Phase 5 flows, and Gemini integration are not implied by these checkmarks.

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

- [ ] Confirm production secret provisioning and deployment configuration; do not commit credentials.
- [ ] Add cross-business authorization tests.

### Remaining business configuration and owner UI

- [ ] Implement AI settings and communication preference APIs/screens after their behavior is approved.
- [ ] Decide whether deactivated catalog items and FAQs need an owner-facing reactivation workflow; current APIs support soft deactivation but not reactivation.
- [ ] Browser-test the inbox, pagination, composer, status refresh, and safe failure display.
- [ ] Add customer data deletion flow after retention/deletion policy is approved.

### WhatsApp and message processing

- [ ] Configure the authorized Meta app, WABA subscription, public HTTPS callback, backend credentials, and business Phone Number ID securely.
- [ ] Confirm the currently supported Graph API version and applicable Meta messaging policies before sending.
- [ ] Complete live webhook verification and controlled inbound text/status testing with an approved test number.
- [ ] Complete one controlled outbound send and confirm provider status/history. Do not retry ambiguous outcomes blindly.
- [ ] Add a repeatable webhook/API test suite and live-test evidence record.
- [ ] Decide whether a secure disconnect/clear-number operation is needed; current number configuration does not provide one.

### Gemini, takeover, verification, and deployment

- [ ] Implement bounded business-context retrieval with the latest relevant messages (target 10–15, subject to token limits).
- [ ] Implement controlled system prompt and Gemini adapter with server-only credentials.
- [ ] Add AI grounding tests and unknown-information handling tests.
- [ ] Test invented price, stock, discount, and policy prevention; add prompt-injection tests.
- [ ] Validate Gemini response and make provider failures visible without claiming send success.
- [ ] Implement AI settings and communication preference APIs/screens after their behavior is approved.
- [ ] Implement atomic MongoDB coordination for takeover request, dispatch claim, mode update, and resume.
- [ ] Add human takeover race tests for generation and in-flight send.
- [ ] Add repeatable unit/API/webhook/integration/end-to-end tests using mocks and authorized non-production accounts.
- [ ] Complete browser verification of login/session restoration, management screens, inbox, manual refresh, and logout.
- [ ] Verify the live Atlas transaction path and business-scoped behavior in the target environment.
- [ ] Deploy to Vercel/Render only after account/secret configuration; set production `VITE_API_BASE_URL` and `FRONTEND_ORIGIN` correctly.
- [ ] Verify live HTTPS webhook, inbound/outbound WhatsApp, status history, safe rollback, and document evidence before marking end-to-end complete.

## Deferred to semester four — not current implementation tasks

- [ ] Automated follow-ups and scheduled reminders.
- [ ] Advanced customer behavior analysis.
- [ ] Lead scoring and sales prediction.
- [ ] Bulk marketing campaigns.
- [ ] Payment integration.
- [ ] Voice AI.
- [ ] Multi-agent AI systems.
