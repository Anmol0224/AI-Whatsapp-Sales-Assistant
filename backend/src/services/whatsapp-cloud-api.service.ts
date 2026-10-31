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
