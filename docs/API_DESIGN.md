# API Design

## Status and conventions

This document describes the backend routes currently implemented. Future WhatsApp, Gemini, inbox, and conversation APIs are intentionally omitted until they exist. The API base path is `/api/v1`; requests and responses use JSON.

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
