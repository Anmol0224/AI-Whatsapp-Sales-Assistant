# AI-Powered WhatsApp Sales Assistant — Project Overview

## Introduction

The AI-Powered WhatsApp Sales Assistant is a planned web application for small business owners. It will help an owner manage business information and respond to customer enquiries arriving at one connected WhatsApp Business number. The backend will use the owner's profile, active products and services, FAQs, and recent conversation messages as context for Google Gemini, then send an appropriate reply through Meta's WhatsApp Cloud API when the conversation is in AI mode.

This repository is at the planning stage. These documents describe proposed functionality; they do not mean any application, database, API, AI model, or external integration has been implemented or configured.

## Business problem and value proposition

Small business owners may receive repeated questions about products, services, prices, availability, and policies. Answering manually can take time, and the right details may not be easy to retrieve during a conversation. This project aims to help owners respond more promptly and consistently by grounding responses in information the owner maintains, while preserving the owner's ability to take over.

The intended value is improved customer engagement and more opportunities to convert existing enquiries into customers. It does not guarantee sales growth or replace the owner's judgment.

## Target users

- **Primary user:** One business owner per workspace, who registers, configures business information, reviews conversations, and takes over when needed.
- **Customer:** A person enquiring through the business's WhatsApp number. Customers do not log into this application.
- **Future extension:** Operator accounts may be considered later, but are not part of the current one-owner-per-workspace MVP.

## How personalized responses work

For an eligible inbound message, the backend will collect the latest customer message, business name and description, relevant active products/services and FAQs, communication preferences, and a bounded window of roughly 10–15 recent conversation messages (subject to model context limits). Gemini is an existing large language model used with this context; the project does not train its own model. The prompt will require the model to use only supplied facts, ask for clarification when needed, and offer human assistance when it cannot answer safely.

Conversation context helps resolve references such as “the larger one” or “is that still available?” without treating every new message as an isolated question. Only bounded context needed for the reply should be sent to the provider.

The system must not invent prices, stock availability, discounts, or policies. If information is missing or Gemini is unavailable, the failure should be visible to the owner and the system must not claim an AI reply was delivered. Whether a fallback clarification is automatically sent or the owner must respond is an open decision.

## Third-semester deliverables — Version 1.0

- Owner registration and login using JWT and bcrypt.
- One owner and one business workspace per owner.
- Business profile configuration, AI settings, and communication preferences.
- Product/service and FAQ management.
- One connected WhatsApp Business number per workspace.
- Meta webhook verification and incoming WhatsApp message processing.
- Automatic customer record creation/retrieval.
- Conversation and message persistence in MongoDB.
- Gemini responses grounded in business-specific information and recent messages.
- Owner dashboard, customer list, chat inbox, and paginated message history.
- Human takeover and resume-AI controls.
- Error handling, bounded retry/recovery behavior, and owner-visible processing/delivery states.

Every item is planned. External accounts, credentials, and integrations are not assumed to exist.

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

At inspection, the repository contains the initial Git setup, `.gitignore`, and planning documents only. No application feature, API, database, provider integration, deployment, or automated test has been completed.
