import { z } from "zod";
import { env } from "../config/env.js";
import type { BusinessFields } from "../models/business.model.js";

const phoneNumberIdSchema = z.string().trim().regex(/^\d{1,32}$/);
const recipientSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/)
  .transform((value) => value.replace(/^\+/, ""));
const messageTextSchema = z.string().trim().min(1).max(4096);
const providerResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().trim().min(1).max(256) })).min(1),
});
const phoneMetadataResponseSchema = z.object({
  id: z.string().trim().regex(/^\d{1,32}$/),
  display_phone_number: z.string().trim().min(1).max(32).optional(),
  verified_name: z.string().trim().min(1).max(256).optional(),
  quality_rating: z.enum(["GREEN", "YELLOW", "RED", "UNKNOWN"]).optional(),
});
const providerErrorCodeSchema = z.object({
  error: z.object({ code: z.number().int() }).passthrough(),
}).passthrough();

const requestTimeoutMs = 10_000;

export type WhatsAppCloudApiErrorCategory =
  | "missing_access_token"
  | "missing_graph_api_version"
  | "missing_phone_number_id"
  | "invalid_recipient"
  | "invalid_message_text"
  | "provider_http_error"
  | "provider_timeout"
  | "provider_network_error"
  | "invalid_provider_response";

export class WhatsAppCloudApiError extends Error {
  readonly category: WhatsAppCloudApiErrorCategory;
  readonly providerStatusCode?: number;

  constructor(category: WhatsAppCloudApiErrorCategory, providerStatusCode?: number) {
    super(category);
    this.name = "WhatsAppCloudApiError";
    this.category = category;
    this.providerStatusCode = providerStatusCode;
  }
}

export type WhatsAppPhoneMetadataErrorCategory =
  | "missing_access_token"
  | "missing_graph_api_version"
  | "invalid_phone_number_id"
  | "provider_authentication_failed"
  | "missing_permissions"
  | "invalid_phone_number_id_at_provider"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_network_error"
  | "provider_unavailable"
  | "unexpected_provider_response";

export class WhatsAppPhoneMetadataError extends Error {
  readonly category: WhatsAppPhoneMetadataErrorCategory;

  constructor(category: WhatsAppPhoneMetadataErrorCategory) {
    super(category);
    this.name = "WhatsAppPhoneMetadataError";
    this.category = category;
  }
}

export interface WhatsAppPhoneMetadata {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
}

export interface WhatsAppPhoneMetadataVerifierOptions {
  accessToken?: string;
  graphApiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Injectable provider boundary for isolated tests; production uses backend env configuration. */
export function createWhatsAppPhoneMetadataVerifier(options: WhatsAppPhoneMetadataVerifierOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs;

  return async (phoneNumberId: string): Promise<WhatsAppPhoneMetadata> => {
    if (!options.accessToken) throw new WhatsAppPhoneMetadataError("missing_access_token");
    if (!options.graphApiVersion) throw new WhatsAppPhoneMetadataError("missing_graph_api_version");

    const parsedPhoneNumberId = phoneNumberIdSchema.safeParse(phoneNumberId);
    if (!parsedPhoneNumberId.success) throw new WhatsAppPhoneMetadataError("invalid_phone_number_id");

    const endpoint = new URL(
      `https://graph.facebook.com/${options.graphApiVersion}/${parsedPhoneNumberId.data}`,
    );
    endpoint.searchParams.set("fields", "id,display_phone_number,verified_name,quality_rating");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let response: Response;

    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${options.accessToken}` },
        signal: timeoutSignal,
      });
    } catch (error) {
      const errorName =
        typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
      if (timeoutSignal.aborted || errorName === "AbortError" || errorName === "TimeoutError") {
        throw new WhatsAppPhoneMetadataError("provider_timeout");
      }
      throw new WhatsAppPhoneMetadataError("provider_network_error");
    }

    if (!response.ok) {
      if (response.status === 401) throw new WhatsAppPhoneMetadataError("provider_authentication_failed");
      if (response.status === 403) throw new WhatsAppPhoneMetadataError("missing_permissions");
      if (response.status === 404) throw new WhatsAppPhoneMetadataError("invalid_phone_number_id_at_provider");
      if (response.status === 429) throw new WhatsAppPhoneMetadataError("provider_rate_limited");
      if (response.status >= 500) throw new WhatsAppPhoneMetadataError("provider_unavailable");
      if (response.status === 400) {
        let providerCode: number | undefined;
        try {
          const payload: unknown = await response.json();
          const parsedError = providerErrorCodeSchema.safeParse(payload);
          if (parsedError.success) providerCode = parsedError.data.error.code;
        } catch {
          // The response body is discarded; only a fixed numeric code may affect categorization.
        }
        if (providerCode === 190) throw new WhatsAppPhoneMetadataError("provider_authentication_failed");
        if (providerCode === 10 || providerCode === 200) throw new WhatsAppPhoneMetadataError("missing_permissions");
        if (providerCode === 100) throw new WhatsAppPhoneMetadataError("invalid_phone_number_id_at_provider");
      }
      throw new WhatsAppPhoneMetadataError("unexpected_provider_response");
    }

    let providerPayload: unknown;
    try {
      providerPayload = await response.json();
    } catch {
      throw new WhatsAppPhoneMetadataError("unexpected_provider_response");
    }

    const parsed = phoneMetadataResponseSchema.safeParse(providerPayload);
    if (!parsed.success) throw new WhatsAppPhoneMetadataError("unexpected_provider_response");

    return {
      id: parsed.data.id,
      ...(parsed.data.display_phone_number ? { displayPhoneNumber: parsed.data.display_phone_number } : {}),
      ...(parsed.data.verified_name ? { verifiedName: parsed.data.verified_name } : {}),
      ...(parsed.data.quality_rating ? { qualityRating: parsed.data.quality_rating } : {}),
    };
  };
}

/** Read-only Meta phone-number metadata lookup; this function never sends a message. */
export function getWhatsAppPhoneNumberMetadata(phoneNumberId: string): Promise<WhatsAppPhoneMetadata> {
  return createWhatsAppPhoneMetadataVerifier({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    graphApiVersion: env.META_GRAPH_API_VERSION,
  })(phoneNumberId);
}

export interface SendWhatsAppTextMessageResult {
  providerMessageId: string;
}

export async function sendWhatsAppTextMessage(
  business: Pick<BusinessFields, "whatsapp">,
  recipientPhoneNumber: string,
  text: string,
): Promise<SendWhatsAppTextMessageResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    throw new WhatsAppCloudApiError("missing_access_token");
  }
  if (!env.META_GRAPH_API_VERSION) {
    throw new WhatsAppCloudApiError("missing_graph_api_version");
  }

  const phoneNumberId = phoneNumberIdSchema.safeParse(business.whatsapp?.phoneNumberId);
  if (!phoneNumberId.success) {
    throw new WhatsAppCloudApiError("missing_phone_number_id");
  }

  const recipient = recipientSchema.safeParse(recipientPhoneNumber);
  if (!recipient.success) {
    throw new WhatsAppCloudApiError("invalid_recipient");
  }

  const messageText = messageTextSchema.safeParse(text);
  if (!messageText.success) {
    throw new WhatsAppCloudApiError("invalid_message_text");
  }

  const endpoint = new URL(
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${phoneNumberId.data}/messages`,
  );
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.data,
        type: "text",
        text: { body: messageText.data, preview_url: false },
      }),
      signal: timeoutSignal,
    });
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? error.name
        : undefined;
    if (timeoutSignal.aborted || errorName === "AbortError" || errorName === "TimeoutError") {
      throw new WhatsAppCloudApiError("provider_timeout");
    }
    throw new WhatsAppCloudApiError("provider_network_error");
  }

  if (!response.ok) {
    throw new WhatsAppCloudApiError("provider_http_error", response.status);
  }

  let providerPayload: unknown;
  try {
    providerPayload = await response.json();
  } catch {
    throw new WhatsAppCloudApiError("invalid_provider_response");
  }

  const parsedResponse = providerResponseSchema.safeParse(providerPayload);
  if (!parsedResponse.success) {
    throw new WhatsAppCloudApiError("invalid_provider_response");
  }

  return { providerMessageId: parsedResponse.data.messages[0].id };
}
