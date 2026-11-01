import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import {
  ingestWhatsAppPayload,
  type IngestionResult,
} from "../../services/whatsapp-ingestion.service.js";

type PayloadIngester = (payload: unknown) => Promise<IngestionResult>;

const verificationQuerySchema = z
  .object({
    "hub.mode": z.string().optional(),
    "hub.verify_token": z.string().optional(),
    "hub.challenge": z.string().optional(),
  })
  .strict();

function matchesVerificationToken(provided: string, configured: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const configuredBytes = Buffer.from(configured, "utf8");

  return (
    providedBytes.length > 0 &&
    providedBytes.length === configuredBytes.length &&
    timingSafeEqual(providedBytes, configuredBytes)
  );
}

export function getWhatsAppVerificationDiagnostics(query: unknown) {
  const queryValues =
    typeof query === "object" && query !== null
      ? (query as Record<string, unknown>)
      : {};
  const providedToken = queryValues["hub.verify_token"];
  const challenge = queryValues["hub.challenge"];
  const configuredToken = env.WHATSAPP_VERIFY_TOKEN;

  return {
    modePresent: Object.prototype.hasOwnProperty.call(queryValues, "hub.mode"),
    modeIsSubscribe: queryValues["hub.mode"] === "subscribe",
    verifyTokenPresent: Object.prototype.hasOwnProperty.call(
      queryValues,
      "hub.verify_token",
    ),
    tokenMatchesConfigured:
      typeof providedToken === "string" &&
      configuredToken !== undefined &&
      matchesVerificationToken(providedToken, configuredToken),
    challengePresent: typeof challenge === "string" && challenge.length > 0,
  };
}

export function createWhatsAppWebhookRouter(ingest: PayloadIngester = ingestWhatsAppPayload) {
  const whatsappWebhookRouter = Router();

  whatsappWebhookRouter.get("/", (request, response) => {
    if (!env.WHATSAPP_VERIFY_TOKEN) {
      response.status(503).json({
        success: false,
        message: "WhatsApp webhook verification is not configured.",
      });
      return;
    }

    const parsedQuery = verificationQuerySchema.safeParse(request.query);
    if (
      !parsedQuery.success ||
      parsedQuery.data["hub.mode"] !== "subscribe" ||
      !parsedQuery.data["hub.verify_token"] ||
      parsedQuery.data["hub.challenge"] === undefined ||
      parsedQuery.data["hub.challenge"].length === 0 ||
      !matchesVerificationToken(
        parsedQuery.data["hub.verify_token"],
        env.WHATSAPP_VERIFY_TOKEN,
      )
    ) {
      response.status(403).json({
        success: false,
        message: "Webhook verification failed.",
      });
      return;
    }

    response.status(200).type("text/plain").send(parsedQuery.data["hub.challenge"]);
  });

  whatsappWebhookRouter.post("/", async (request, response) => {
    if (!env.META_APP_SECRET) {
      response.status(503).json({
        success: false,
        message: "WhatsApp webhook signature verification is not configured.",
      });
      return;
    }

    const signature = request.get("x-hub-signature-256");
    if (!signature || !/^sha256=[a-f\d]{64}$/i.test(signature)) {
      response.status(401).json({
        success: false,
        message: "Invalid webhook signature.",
      });
      return;
    }

    if (!Buffer.isBuffer(request.body)) {
      response.status(400).json({
        success: false,
        message: "Webhook request body must be JSON.",
      });
      return;
    }

    const suppliedDigest = Buffer.from(signature.slice("sha256=".length), "hex");
    const expectedDigest = createHmac("sha256", env.META_APP_SECRET)
      .update(request.body)
      .digest();

    if (
      suppliedDigest.length !== expectedDigest.length ||
      !timingSafeEqual(suppliedDigest, expectedDigest)
    ) {
      response.status(401).json({
        success: false,
        message: "Invalid webhook signature.",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString("utf8")) as unknown;
    } catch {
      response.status(400).json({
        success: false,
        message: "Malformed webhook payload.",
      });
      return;
    }

    try {
      const result = await ingest(payload);
      if (result.kind === "malformed") {
        response.status(400).json({
          success: false,
          message: "Malformed supported webhook payload.",
        });
        return;
      }

      response.status(200).json({
        success: true,
        message: result.kind === "ignored" ? "Webhook event ignored." : "Webhook event processed.",
      });
    } catch {
      response.status(503).json({
        success: false,
        message: "Webhook processing is temporarily unavailable.",
      });
    }
  });

  return whatsappWebhookRouter;
}

export default createWhatsAppWebhookRouter();
