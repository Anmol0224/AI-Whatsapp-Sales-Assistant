# AI-Powered WhatsApp Sales Assistant — Project Overview

## Introduction

The AI-Powered WhatsApp Sales Assistant is a web application for a small business owner to manage business information, receive WhatsApp enquiries, review conversations, and send owner-initiated text replies. Phase 6 adds a draft-first AI workflow: eligible inbound messages can be queued, Gemini can propose a reply, and the owner can inspect, edit, approve, or reject it.

Approval records owner intent only. **Approving a draft does not send it through WhatsApp.** The application-level operation that would send an approved AI draft is not implemented. Automatic AI replies are disabled and outside the third-semester scope.

## Problem statement

Small businesses receive repeated questions about products, services, prices, availability, and policies. Finding the right owner-maintained information while responding manually takes time. The system combines a business profile, active catalog and FAQs with bounded conversation context to propose a response for owner review. The owner remains responsible for deciding what is sent.

The project does not guarantee sales growth, factual correctness, or message delivery. A generated draft is a suggestion, not a verified business statement or a sent message.

## Objectives

- Provide owner registration/login and a business-scoped workspace.
- Maintain a business profile, products/services, and FAQs.
- Receive supported WhatsApp text messages and retain conversation history.
- Let the owner manually send WhatsApp text messages and inspect provider statuses.
- Build a durable, business-scoped queue for eligible inbound AI draft work.
- Retrieve bounded business and conversation context and request a draft from Gemini on the backend.
- Require owner review, editing where needed, and explicit approval or rejection.
- Keep AI-generated sending separate from draft approval and prevent automatic replies.

## Target users

- **Business owner:** The sole owner account in the MVP workspace. The owner manages business information, inbox conversations, response mode, and AI drafts.
- **Customer:** A person messaging the business on WhatsApp. Customers do not sign in to the application.
- Additional staff/operator accounts and multi-workspace administration are not in the current MVP.

## Third-semester scope and current implementation

Implemented in source:

- React + Vite + TypeScript frontend and Express + TypeScript backend.
- JWT authentication with bcrypt password hashes.
- Business profile, one WhatsApp Phone Number ID configuration, catalog, and FAQ management.
- Meta webhook verification/signature handling, supported inbound text ingestion, message/status persistence, conversation APIs, and owner-initiated manual WhatsApp text sending.
- Business-scoped AI reply jobs, webhook-to-job enqueueing when the global gate is enabled and the conversation is in AI mode, Gemini adapter, bounded business context, controlled prompt builder, worker, and owner-facing AI Drafts page.
- Draft retrieval, approval/editing, rejection, and Human/AI response-mode controls.

The configured worker gate defaults to false in backend source. It gates both inbound AI-job enqueueing and worker processing. Production Render configuration was not independently inspected; source defaults do not prove a deployment setting. AI automatic replies are not part of this MVP.

## Verification status

| Evidence class | Current evidence and limits |
|---|---|
| **Implemented and mock/unit-tested** | Backend tests cover Gemini adapter behavior, prompt/context, worker/processor, draft routes and transitions, ingestion fencing, and response-mode operations. Latest project-reported results are 130/130 regular backend tests, including a 40/40 Gemini adapter subset; they were not rerun as part of the documentation update. |
| **MongoDB Atlas integration-tested** | The project reports 16/16 AI draft transaction/concurrency integration tests passing against the isolated whatsapp_sales_assistant_test database. This is not production database verification. |
| **Reported as live-tested** | The project previously reported real WhatsApp messages working in both directions on the deployed backend. This is a project report, not an independently repeated test. Separate Meta Verify and Save attempts were reported as failing despite a direct challenge test returning 200, so webhook setup is not considered fully verified. |
| **Not successfully verified with real Gemini** | The latest controlled real Gemini generation returned HTTP 504 (provider_5xx); the job was retry-scheduled and no draft was persisted. No successful real Gemini draft has been demonstrated. |
| **Not verified here** | Frontend browser acceptance of the complete AI Drafts flow and a full staged inbound → Gemini draft → owner approval → explicit AI send → status flow are not evidenced. The explicit AI-draft sending path is not implemented. |

Build/typecheck success and mock tests do not establish provider connectivity. The backend exposes a test script; the frontend package does not define an automated test script or include a frontend test suite.

## Remaining third-semester work

In dependency order: obtain one successful controlled Gemini draft using synthetic data and an isolated test database; implement an authenticated, explicit owner-triggered send operation for an approved draft using the existing repository reservation/completion foundations; add the corresponding confirmation and uncertain-outcome UI; add and run focused API, provider-mocked, Atlas concurrency, and browser acceptance tests; then document a controlled non-production end-to-end result. Do not enable automatic sending. Keep the production worker configuration disabled unless an explicitly approved deployment decision changes that requirement.

## Fourth-semester future scope — deferred

- Automated follow-ups and scheduled reminders.
- Lead scoring and sales predictions.
- Bulk campaigns.
- Payment integration.
- Voice AI.
- Multi-agent features.

These features remain deferred; no infrastructure for them is required in the third-semester MVP.
