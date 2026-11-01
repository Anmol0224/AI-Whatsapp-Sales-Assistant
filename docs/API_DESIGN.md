# API Design

## Status and conventions

This document describes the backend routes currently implemented. The API base path is `/api/v1`; application requests and responses use JSON. WhatsApp webhook callbacks are the exception: verification returns plain text, and POST callbacks are authenticated by Meta's raw-body signature rather than JWT. Gemini responses and delivery-triggered real-time frontend refresh are not implemented.

Protected endpoints require `Authorization: Bearer <JWT>`. The backend derives the business scope from verified JWT claims and does not authorize using a client-supplied business ID. Successful resource responses use `{ "success": true, ... }`. Error responses use `{ "success": false, "message": "...", "errors": [...] }` when field details are available. Errors do not include stack traces or internal credentials.

The backend applies a rate limit of 100 API requests per IP per 15 minutes. JSON request bodies are limited to 100 KB.

## Health

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Return API health status. |

Response (`200`):

```json
{
  "success": true,
  "message": "Backend is running successfully",
  "service": "WhatsApp Sales Assistant API"
}
```

## Authentication

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | Public | Create an owner account and its business workspace. |
| `POST` | `/api/v1/auth/login` | Public | Verify credentials and issue an access JWT. |
| `GET` | `/api/v1/auth/me` | JWT | Return the authenticated owner and safe business summary. |

Register request:

```json
{
  "name": "Asha Patel",
  "email": "asha@example.com",
  "password": "example-only-password",
  "businessName": "Northside Bakery"
}
```

Registration response (`201`) contains safe owner and business summaries and **does not return a JWT**:

```json
{
  "user": { "id": "user-id", "name": "Asha Patel", "email": "asha@example.com" },
  "business": { "id": "business-id", "name": "Northside Bakery" }
}
```

Login request: `{ "email": "asha@example.com", "password": "example-only-password" }`.

Login response (`200`) includes a JWT, its lifetime in seconds, and safe account information:

```json
{
  "success": true,
  "token": "placeholder-jwt",
  "expiresIn": 3600,
  "user": { "id": "user-id", "name": "Asha Patel", "email": "asha@example.com", "role": "owner" },
  "business": { "id": "business-id", "name": "Northside Bakery" }
}
```

The access token lifetime defaults to one hour and is configurable on the backend. Passwords are hashed with bcrypt. Unknown email and incorrect password use the same `401` message. Registration validates and normalizes email and creates the owner and business in a MongoDB transaction. No refresh-token or server-side token-revocation endpoint is implemented; the frontend clears its session token on logout, and an issued JWT remains usable until it expires.

`GET /api/v1/auth/me` returns `{ "success": true, "user": { "id", "name", "email", "role" }, "business": { "id", "name" } }`.

## Business profile

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/business` | JWT | Read the authenticated business's safe profile fields. |
| `PATCH` | `/api/v1/business` | JWT | Partially update allowed profile fields. |

The profile response includes `id`, `name`, optional `description`, `industry`, `contactDetails` (`phone`, `email`, `website`, and `address`), and optional `timezone`. WhatsApp credentials and AI settings are not returned by these endpoints.

PATCH accepts any non-empty subset of `name`, `description`, `industry`, `timezone`, and nested `contactDetails` fields `phone`, `email`, `website`, and `address`. Unknown or protected fields are rejected. Nested contact updates preserve contact fields not included in the request. Empty strings are rejected for required/non-empty profile values; no explicit clear/unset operation is implemented.

Both endpoints derive business and owner IDs from the JWT and verify the business/owner relationship. Missing or out-of-scope businesses return `404`.

### WhatsApp number configuration

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/business/whatsapp` | JWT | Read safe WhatsApp number settings for the authenticated business. |
| `PATCH` | `/api/v1/business/whatsapp` | JWT | Configure the workspace's one WhatsApp Business number. |

Both endpoints use the authenticated owner's JWT scope and verify the business using both business ID and owner user ID. They never accept a client-supplied business ID. The response contains only `phoneNumberId`, optional `displayNumber`, and `connectionStatus`; it never returns `credentialRef`, access tokens, app secrets, verification tokens, or other credentials.

PATCH request:

```json
{
  "phoneNumberId": "123456789012345",
  "displayNumber": "+919876543210"
}
```

`phoneNumberId` is required, trimmed, and must contain 1–32 digits. `displayNumber` is optional and, when supplied, must be an international phone number with 7–15 digits and an optional leading `+`, up to 16 characters total. Unknown and protected fields are rejected. The backend updates the nested fields individually, preserves other WhatsApp settings, and sets `connectionStatus` to `configured_not_verified`.

Both endpoints return this safe structure (`displayNumber` and `phoneNumberId` may be omitted when not set):

```json
{
  "success": true,
  "whatsapp": {
    "phoneNumberId": "123456789012345",
    "displayNumber": "+919876543210",
    "connectionStatus": "configured_not_verified"
  }
}
```

The status is `not_configured` when no Phone Number ID is saved and `configured_not_verified` when one is saved. Saving a number does not verify Meta connectivity. There is no Meta verification flow or disconnect/clear operation in this step. Invalid data returns `400`; a missing or out-of-scope business returns `404`.

## Products and services (catalog items)

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/catalog-items` | JWT | List scoped products/services with filters and pagination. |
| `POST` | `/api/v1/catalog-items` | JWT | Create a product or service. |
| `GET` | `/api/v1/catalog-items/:id` | JWT | Read one scoped item. |
| `PATCH` | `/api/v1/catalog-items/:id` | JWT | Partially update an item. |
| `DELETE` | `/api/v1/catalog-items/:id` | JWT | Soft-delete an item by deactivating it. |

List query parameters:

| Parameter | Accepted values | Default |
|---|---|---|
| `kind` | `product`, `service` | No kind filter |
| `isActive` | `true`, `false` | `true` |
| `page` | Positive safe integer | `1` |
| `limit` | Positive integer, maximum `100` | `20` |

Items are sorted newest first. Invalid or unsupported query parameters return `400`. Pagination is returned with the item list:

```json
{
  "success": true,
  "items": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

Create request:

```json
{
  "kind": "product",
  "name": "Chocolate Cake",
  "description": "500 g cake",
  "priceInPaise": 45000,
  "currency": "INR",
  "availability": "Ask us for today's availability"
}
```

`kind` and `name` are required. `priceInPaise` is optional and, when supplied, must be a non-negative safe integer; floating-point prices are rejected. Currency is INR only and defaults to INR when omitted. `businessId` and `isActive` are backend-controlled: the business ID comes from the JWT, and new items are active. The response (`201`) contains `{ "success": true, "item": { "id", "kind", "name", "description", "priceInPaise", "currency", "availability", "isActive", "createdAt", "updatedAt" } }`.

PATCH accepts a non-empty subset of `kind`, `name`, `description`, `priceInPaise`, `currency`, and `availability`. Unknown fields, including `businessId` and `isActive`, are rejected. Only supplied fields are changed. A price can be updated to a non-negative safe integer; a null/unset operation for removing a price is not implemented.

GET, PATCH, and DELETE validate the item ID and scope the database operation to that ID and the JWT business ID. Invalid IDs return `400`; absent and out-of-scope items return the same `404` response. DELETE sets `isActive` to `false` and never removes the database record. List results return active items by default; `isActive=false` can be used to list inactive items.

## FAQs

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/faqs` | JWT | List scoped FAQs, active by default. |
| `POST` | `/api/v1/faqs` | JWT | Create an FAQ. |
| `GET` | `/api/v1/faqs/:id` | JWT | Read one scoped FAQ. |
| `PATCH` | `/api/v1/faqs/:id` | JWT | Partially update a FAQ. |
| `DELETE` | `/api/v1/faqs/:id` | JWT | Soft-delete an FAQ by deactivating it. |

The list accepts optional `isActive=true` or `isActive=false`; omitted means `true`. FAQs are sorted newest first. There is no FAQ pagination parameter currently.

Create request:

```json
{
  "question": "What time do you close?",
  "answer": "We close at 8 PM every day."
}
```

Both fields are required trimmed non-empty strings. The backend derives `businessId` from the JWT and sets new FAQs active. Clients cannot set `businessId` or `isActive`. PATCH accepts a non-empty subset of `question` and `answer`; supplied values must remain non-empty, and unknown/protected fields are rejected. FAQ responses contain safe FAQ fields and do not expose internal business references.

All item operations are scoped to the authenticated business. Invalid IDs return `400`; absent and out-of-scope FAQs return the same `404` response. DELETE sets `isActive` to `false` and never removes the database record.

## WhatsApp webhooks

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/webhooks/whatsapp` | Public; Meta verify token | Verify the callback URL with Meta. |
| `POST` | `/api/v1/webhooks/whatsapp` | Public; Meta HMAC signature | Receive incoming text messages and outgoing-message status events. |

### Webhook verification

Meta sends the query parameters `hub.mode`, `hub.verify_token`, and `hub.challenge`. Verification succeeds only when `hub.mode` is `subscribe` and the supplied token matches the backend's configured `WHATSAPP_VERIFY_TOKEN`.

Success (`200`) returns `hub.challenge` as plain text. Invalid or incomplete verification returns `403`:

```json
{ "success": false, "message": "Webhook verification failed." }
```

If the verify token is not configured, the endpoint returns `503` with `"WhatsApp webhook verification is not configured."`.

### Incoming webhook callback

The POST callback verifies `X-Hub-Signature-256` as an HMAC-SHA256 signature over the original raw request bytes using the backend `META_APP_SECRET`. The webhook route is mounted before JSON parsing so signature validation uses those bytes. Missing or invalid signatures return `401`; missing signature configuration returns `503`. A non-buffer request body or malformed JSON returns `400`.

The implemented ingestion supports incoming **text** messages containing the sender WhatsApp ID, provider message ID, text body, and optional provider timestamp and contact profile name. It also processes `sent`, `delivered`, `read`, and `failed` status entries from `value.statuses`. Media, unsupported event types, malformed individual entries, and status events without a resolvable business/message are safely ignored when another valid event exists. For each supported message or status, the backend resolves the business from `metadata.phone_number_id` matched to a uniquely stored `whatsapp.phoneNumberId`; an unknown or ambiguous number mapping is acknowledged without an unscoped write.

For a resolved business, the backend uses a MongoDB transaction to find or create the business-scoped customer and conversation, reopen a closed conversation, persist the inbound message, and update the conversation's last-message summary. The business and provider message ID enforce duplicate handling: an already-persisted delivery is not inserted again. Status events update only an outbound message matching both the resolved business and provider message ID. Unknown IDs and inbound messages are not changed. Status transitions advance `sent` → `delivered` → `read`; older events cannot regress state, duplicate/non-advancing events do not write, `failed` is terminal, and failure can replace `sent` but not `delivered`/`read`. At equal timestamps, forward success progression is accepted; conflicting terminal outcomes preserve the already stored outcome. The provider status timestamp and bounded failure code/title are stored separately from the message timestamp; raw provider error objects are not persisted. Webhook callbacks do not return stored message data.

Successfully persisted incoming messages or status updates, confirmed duplicates/stale updates, unknown number/message mappings, and ignored unsupported events are acknowledged with `200`:

```json
{ "success": true, "message": "Webhook event processed." }
```

Ignored events or events with no resolvable business use `"Webhook event ignored."` instead. Malformed supported payloads with no other valid event return `400` with `"Malformed supported webhook payload."`; malformed individual entries do not prevent valid sibling events from being processed. A persistence or other ingestion failure returns retryable `503`:

```json
{ "success": false, "message": "Webhook processing is temporarily unavailable." }
```

### Conversations and messages

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/conversations` | JWT | List conversations for the authenticated business. |
| `GET` | `/api/v1/conversations/:conversationId/messages` | JWT | Read paginated messages for one owned conversation. |
| `GET` | `/api/v1/conversations/:conversationId/response-mode` | JWT | Read the response mode of one owned conversation without changing it. |
| `POST` | `/api/v1/conversations/:conversationId/messages` | JWT | Send a text message to the customer in an existing conversation. |
| `PATCH` | `/api/v1/conversations/:conversationId/response-mode` | JWT | Switch the owned conversation between human and AI response modes. |

### AI draft retrieval

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/ai-drafts` | JWT | List review-safe AI reply job summaries for the authenticated business. |
| `GET` | `/api/v1/ai-drafts/:draftId` | JWT | Retrieve one review-safe draft for the authenticated business. |
| `GET` | `/api/v1/conversations/:conversationId/ai-drafts` | JWT | List drafts for one conversation owned by the authenticated business. |
| `POST` | `/api/v1/ai-drafts/:draftId/approve` | JWT | Approve the generated or owner-edited draft for later controlled sending. |
| `POST` | `/api/v1/ai-drafts/:draftId/reject` | JWT | Reject a draft awaiting owner review. |

All three endpoints derive `businessId` from the JWT. The list endpoints accept `page` (default `1`), `limit` (default `20`, maximum `100`), and an optional `status`. If omitted, status defaults to `draft_ready`. Supported status values are `queued`, `processing`, `draft_ready`, `approved`, `rejected`, `sending`, `sent`, `send_failed`, `send_uncertain`, `failed`, and `cancelled`. Invalid IDs or query values return `400`; unknown query parameters are rejected. Pagination is sorted by `createdAt` descending, then `_id` descending, with `totalPages: 0` for an empty result.

List response (`200`):

```json
{
  "success": true,
  "drafts": [
    {
      "id": "draft-id",
      "conversationId": "conversation-id",
      "sourceMessage": {
        "id": "inbound-message-id",
        "text": "Do you have this in blue?",
        "timestamp": "2026-11-01T09:59:00.000Z",
        "createdAt": "2026-11-01T10:00:00.000Z"
      },
      "status": "draft_ready",
      "generatedDraft": "Thanks for your enquiry. The item is available.",
      "createdAt": "2026-11-01T10:00:00.000Z",
      "updatedAt": "2026-11-01T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

`sourceMessage` is the exact persisted inbound message referenced by the draft's `inboundMessageId`. It contains only the message ID, text, optional provider timestamp, and creation time. The lookup is scoped by the authenticated business, inbound direction, and the draft's conversation. If the source message is missing or cannot be matched safely, the field is `null`; the API does not substitute a timestamp-based message. `GET /api/v1/ai-drafts/:draftId` returns `{ "success": true, "draft": { ... } }` with the same safe draft fields. Optional review fields include `approvedText`, `approvalEdited`, `approvedAt`, `rejectedAt`, and `rejectionReason`. Neither list nor detail responses expose MongoDB documents, attempt counts, worker leases, send attempt IDs, provider IDs, provider error details, or credentials. The conversation endpoint first verifies that the conversation belongs to the authenticated business and returns `404` with `"Conversation not found."` otherwise. A draft ID that is missing or belongs to another business returns the same `404` response: `{"success":false,"message":"AI draft not found."}`.

These endpoints provide authenticated owner review and response-mode controls. All derive business and user identity from the JWT; client-supplied identity fields are rejected. No route in this section sends a WhatsApp message or calls Gemini.

### AI draft approval and rejection

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/ai-drafts/:draftId/approve` | JWT | Approve an unchanged generated draft or an owner-edited version. |
| `POST` | `/api/v1/ai-drafts/:draftId/reject` | JWT | Reject a draft awaiting owner review. |

Both endpoints validate the ObjectId path parameter and reject unknown body fields. Approval accepts `{}` to approve the generated text or `{ "approvedText": "..." }` to approve edited text. `approvedText` is trimmed, required to be non-empty when provided, and limited to 4,096 characters. Rejection accepts an optional `{ "reason": "..." }`, trimmed and limited to 500 characters.

Approval is a transactional, one-time transition. It requires the job to remain `draft_ready`, its conversation to remain in AI mode, and the source inbound message to remain the latest committed inbound message for that business and conversation. “Latest” is determined by persisted `createdAt` descending, then `_id` descending. The persisted inbound-message transaction increments the same conversation `aiControlVersion`; the draft records its version, and approval compares that fence before recording the owner, time, approved text, edit flag, and approved control version. Human takeover and switching response mode also advance the fence. A stale draft returns `409` and must be regenerated. Successful approval returns `200` with `{ "success": true, "message": "AI draft approved successfully.", "draft": { "id", "status": "approved", "approvedText" } }`.

Rejection only transitions a business-scoped `draft_ready` job to `rejected`, recording the owner, time, and optional reason. A repeated or otherwise ineligible transition returns `409`; a missing or other-business draft returns the same `404` response. Success returns `200` with `{ "success": true, "message": "AI draft rejected successfully.", "draft": { "id", "status": "rejected" } }`.

Invalid IDs or bodies return `400`; missing authentication returns `401`; missing/other-business drafts return `404`; stale, already-transitioned, or otherwise conflicting states return `409`. Approval and rejection do not send a message, reserve a send, or call a provider.

### Conversation response mode

`GET /api/v1/conversations/:conversationId/response-mode` requires JWT authentication and reads only the mode for the conversation scoped to the business in the JWT. It returns `404` with `"Conversation not found."` for a missing or inaccessible conversation, and `400` for an invalid conversation ID. Success (`200`) returns:

```json
{
  "success": true,
  "conversation": {
    "id": "conversation-id",
    "responseMode": "human"
  }
}
```

This GET operation does not modify the conversation or its control version. The PATCH endpoint below remains the separate mode-changing operation.

`PATCH /api/v1/conversations/:conversationId/response-mode` requires JWT authentication and accepts only `{ "responseMode": "human" }` or `{ "responseMode": "ai" }`. The conversation is scoped to the business in the JWT. Unknown body fields, invalid IDs, or unsupported modes return `400`; missing authentication returns `401`; a conversation outside the owner's scope returns `404`.

Switching to `human` uses the existing atomic takeover operation and increments `aiControlVersion`. Switching to `ai` from human mode also increments the fence, so drafts approved or generated under an earlier control version cannot be used as current approvals. An active AI send reservation returns `409` with code `send_in_progress`; other state conflicts return `409`. An unchanged mode is acknowledged as `200` without changing the mode. Successful responses contain the conversation ID and resulting `responseMode`. This endpoint does not generate drafts, enqueue jobs, or send messages.

### Conversation inbox and message history

Both GET endpoints require a JWT. They derive `businessId` from the verified token; clients cannot select another business. Both accept optional `page` and `limit` query parameters, defaulting to `1` and `20`. They must be positive integers, and `limit` cannot exceed `100`. Unknown query parameters and invalid pagination values return `400` with field errors. The list endpoint uses the message `"Invalid conversation filters."`; history uses `"Invalid message history filters."`.

`GET /api/v1/conversations` lists only the authenticated business's conversations, sorted by latest activity descending. Activity is `lastMessageAt`, falling back to the conversation's `updatedAt` when no message time is available; ties use conversation ID descending. The customer details are limited to `profileName` and `phoneNumber`. The response is:

```json
{
  "success": true,
  "conversations": [
    {
      "id": "conversation-id",
      "customer": { "profileName": "Sam", "phoneNumber": "919876543210" },
      "status": "open",
      "lastMessagePreview": "Do you have this in blue?",
      "lastActivityAt": "2026-11-01T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

An empty result returns `"conversations": []` and `totalPages: 0`.

`GET /api/v1/conversations/:conversationId/messages` first verifies that the conversation belongs to the authenticated business. It returns `404` with `"Conversation not found."` when missing or out of scope. Messages are queried using both the JWT business ID and conversation ID. Each page is selected newest first using the existing `{ businessId, conversationId, createdAt }` history index, then returned oldest to newest within that page. The message response contains only safe inbox fields:

```json
{
  "success": true,
  "messages": [
    {
      "id": "message-id",
      "direction": "inbound",
      "messageType": "text",
      "text": "Do you have this in blue?",
      "status": "received",
      "timestamp": "2026-11-01T09:59:00.000Z",
      "createdAt": "2026-11-01T10:00:00.000Z"
    },
    {
      "id": "outbound-message-id",
      "direction": "outbound",
      "messageType": "text",
      "text": "We are currently out of stock.",
      "status": "failed",
      "providerErrorCode": "131",
      "providerErrorTitle": "Message undeliverable",
      "createdAt": "2026-11-01T10:01:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 2,
    "totalPages": 1
  }
}
```

The supported message status values are `sent`, `delivered`, `read`, and `failed` for outgoing messages, and `received` for incoming messages. For failed messages, `providerErrorCode` (maximum 64 characters) and `providerErrorTitle` (maximum 200 characters) are included only when Meta supplied those details. Both fields are optional. Raw provider error objects and internal database details are never returned. The provider `timestamp` is omitted when unavailable. An empty history returns `"messages": []` and `totalPages: 0`. Invalid conversation IDs return `400` with `"Invalid conversation ID."`.

The request body accepts only a trimmed, non-empty `text` string up to the Message model's 4,096-character limit. Unknown fields are rejected. Business and user scope comes from the JWT; the client must not submit `businessId`, customer IDs, provider IDs, direction, or status.

```json
{ "text": "Hello, how can we help?" }
```

Before sending, the backend validates the conversation ID, retrieves the conversation within the JWT business, retrieves its customer within the same business, and retrieves the business for the authenticated owner. Missing or out-of-scope conversation, customer, or business returns `404`. A missing WhatsApp configuration returns `503`. Only after these checks does the backend call the Meta Cloud API using the business's stored phone-number ID. It does not automatically retry provider POST requests.

On successful provider acceptance and local persistence, the backend stores an outbound text message with status `sent`, the returned provider message ID, and the JWT-derived business/conversation/customer references. It updates `lastMessageAt` and `lastMessagePreview` on the conversation. Success (`201`) returns:

```json
{
  "success": true,
  "message": "WhatsApp message sent successfully.",
  "data": {
    "message": {
      "id": "message-id",
      "conversationId": "conversation-id",
      "customerId": "customer-id",
      "direction": "outbound",
      "messageType": "text",
      "text": "Hello, how can we help?",
      "providerMessageId": "wamid.example",
      "status": "sent",
      "createdAt": "2026-11-01T10:00:00.000Z",
      "updatedAt": "2026-11-01T10:00:00.000Z"
    }
  }
}
```

`timestamp` is included in the serialized message only when present. A duplicate provider ID matching an already-recorded outbound message in that conversation returns `200` with `"Message was already recorded."` and the same safe `data.message` shape.

Relevant error responses are:

| Status | Behavior |
|---|---|
| `400` | Invalid conversation ID or invalid body; body validation uses `"Invalid message data."` and may include field-level `errors`. |
| `401` | Missing or invalid JWT; `"Authentication required."` |
| `404` | Conversation, its business-scoped customer, or authenticated business not found. |
| `502` | Provider rejection, or an uncertain provider outcome such as a provider `5xx`, timeout, network failure, or invalid success response. For uncertain outcomes the message advises checking the conversation before retrying. |
| `503` | WhatsApp configuration or stored send input is unavailable/invalid, or the provider may have accepted the message but local persistence/summary update did not complete. The latter response says: `"WhatsApp may have accepted this message, but local persistence did not complete. Check the conversation before retrying."` Configuration/input errors use `"WhatsApp message sending is not configured correctly."` |
| `500` | Unexpected pre-send request processing failure; `"Unable to process the message request."` |

If Meta accepts a message but local persistence fails, the backend does not resend it. It returns the warning above so the owner can check the conversation before taking further action. The inbox can display the current stored status after refreshing message history; it does not currently poll or refresh in real time. Automatic replies and delivery-triggered frontend refresh are not implemented.

## Errors and status codes

The implemented error convention is:

```json
{
  "success": false,
  "message": "Invalid catalog item data.",
  "errors": [{ "field": "priceInPaise", "message": "Invalid input" }]
}
```

`errors` is included when field-level validation details are available. Implemented status behavior includes `400` for invalid input/IDs or malformed JSON, `401` for missing/invalid authentication, `404` for missing/out-of-scope resources or unknown routes, `409` for duplicate registration email, `413` for oversized JSON, `429` for rate limits, and a generic `500` for unexpected failures. Responses do not reveal stack traces or internal credentials.
