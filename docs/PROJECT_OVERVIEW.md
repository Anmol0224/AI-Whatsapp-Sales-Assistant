# AI-Powered WhatsApp Sales Assistant — Project Overview

## Introduction

The AI-Powered WhatsApp Sales Assistant is a web application for small business owners. The current implementation supports account access, business information management, and a manual WhatsApp inbox for one business workspace with a stored number configuration. Owners can review incoming messages and send text replies through Meta's WhatsApp Cloud API when the external account and credentials are configured.

Google Gemini responses, AI context retrieval, and AI/human takeover controls remain planned. WhatsApp configuration and messaging code do not mean that a Meta account, public webhook, credentials, or live delivery has been configured or tested.

## Business problem and value proposition

Small business owners may receive repeated questions about products, services, prices, availability, and policies. Answering manually can take time, and the right details may not be easy to retrieve during a conversation. This project aims to help owners respond more promptly and consistently by grounding responses in information the owner maintains, while preserving the owner's ability to take over.

The intended value is improved customer engagement and more opportunities to convert existing enquiries into customers. It does not guarantee sales growth or replace the owner's judgment.

## Target users

- **Primary user:** One business owner per workspace, who registers, configures business information, reviews conversations, and can send manual replies. Automated AI/human takeover controls remain planned.
- **Customer:** A person enquiring through the business's WhatsApp number. Customers do not log into this application.
- **Future extension:** Operator accounts may be considered later, but are not part of the current one-owner-per-workspace MVP.

## Planned AI response behavior

If AI responses are implemented, the backend would collect the latest customer message, business name and description, relevant active products/services and FAQs, communication preferences, and a bounded window of roughly 10–15 recent conversation messages (subject to model context limits). Gemini is an existing large language model; this project does not train its own model. A future prompt would require the model to use only supplied facts, ask for clarification when needed, and offer human assistance when it cannot answer safely.

If implemented, conversation context could help resolve references such as “the larger one” or “is that still available?” without treating every new message as an isolated question. Only bounded context needed for a reply should be sent to the provider.

The system must not invent prices, stock availability, discounts, or policies. If information is missing or Gemini is unavailable, the failure should be visible to the owner and the system must not claim an AI reply was delivered. Whether a fallback clarification is automatically sent or the owner must respond is an open decision.

## Third-semester deliverables — Version 1.0

Implemented in source:

- Owner registration/login using JWT and bcrypt; one owner and one business workspace.
- Business profile, product/service, and FAQ management.
- Configuration of one Phone Number ID and display number per business. The API reports `configured_not_verified` until a verification flow exists.
- Meta webhook challenge verification and raw-body signature verification.
- Incoming text-message persistence with customer/conversation reuse and provider-message deduplication.
- Manual owner-initiated outgoing text messages, conversation listing, paginated history, and a frontend inbox/composer.
- Delivery/read/failure status processing and safe optional failure-detail display after history refresh.

Not implemented or not verified live:

- Gemini responses, business-context retrieval, AI settings, and human takeover/resume controls.
- Live Meta webhook verification, real WhatsApp receiving/delivery, and deployed end-to-end testing.
- Automated AI retry/recovery and a repeatable project-wide automated test suite.

The code implementation is present, but external accounts, credentials, deployment, and live integration are not implied.

## Fourth-semester future scope — Version 2.0, deferred

- Automated follow-ups and scheduled reminders.
- Advanced customer behavior analysis.
- Lead scoring and sales prediction.
- Bulk marketing campaigns.
- Payment integration.
- Voice AI.
- Multi-agent AI systems.

These features are excluded from the current semester's implementation. The architecture should leave room for later extension without adding queues, microservices, vector databases, or other unnecessary infrastructure now.

## Current repository status

The repository contains frontend and backend application code, Mongoose models, authentication and business APIs, WhatsApp webhook and manual text-send code, and the inbox UI. Recent implementation steps report passing typechecks and production builds, plus isolated mocked checks for status processing and WhatsApp number configuration. Browser verification of the inbox/number settings and live Atlas/Meta/WhatsApp end-to-end verification remain unconfirmed or pending; no repeatable automated test suite is configured.
