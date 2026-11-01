import express from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { env } from "./config/env.js";
import errorHandler from "./middleware/error-handler.js";
import authRouter from "./routes/v1/auth.routes.js";
import businessRouter from "./routes/v1/business.routes.js";
import catalogItemsRouter from "./routes/v1/catalog-items.routes.js";
import conversationsRouter from "./routes/v1/conversations.routes.js";
import faqsRouter from "./routes/v1/faqs.routes.js";
import healthRouter from "./routes/v1/health.routes.js";
import whatsappWebhookRouter, {
  getWhatsAppVerificationDiagnostics,
} from "./routes/v1/whatsapp-webhook.routes.js";

const app = express();

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (origin === undefined || origin === env.FRONTEND_ORIGIN) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
};

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  handler: (_request, response) => {
    response.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  },
});

function rejectCompressedWebhookBodies(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  const contentEncoding = request.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    response.status(415).json({
      success: false,
      message: "Compressed webhook request bodies are not supported.",
    });
    return;
  }

  next();
}

function logWebhookVerificationRequest(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (request.method !== "GET") {
    next();
    return;
  }

  const pathname = request.originalUrl.split("?")[0] || "/";
  if (
    pathname !== "/api/v1/webhooks/whatsapp" &&
    pathname !== "/api/v1/webhooks/whatsapp/"
  ) {
    next();
    return;
  }

  const diagnostics = getWhatsAppVerificationDiagnostics(request.query);

  response.once("finish", () => {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        pathname,
        statusCode: response.statusCode,
        verification: response.statusCode === 200 ? "succeeded" : "failed",
        modePresent: diagnostics.modePresent,
        modeIsSubscribe: diagnostics.modeIsSubscribe,
        verifyTokenPresent: diagnostics.verifyTokenPresent,
        tokenMatchesConfigured: diagnostics.tokenMatchesConfigured,
        challengePresent: diagnostics.challengePresent,
      }),
    );
  });

  next();
}

app.use(helmet());
app.use(cors(corsOptions));
app.use(
  "/api/v1/webhooks/whatsapp",
  logWebhookVerificationRequest,
  apiRateLimiter,
  rejectCompressedWebhookBodies,
  express.raw({ type: "application/json", limit: "100kb", inflate: false }),
  whatsappWebhookRouter,
);
app.use(express.json({ limit: "100kb" }));
app.use("/api/v1/auth", apiRateLimiter, authRouter);
app.use("/api/v1/business", apiRateLimiter, businessRouter);
app.use("/api/v1/catalog-items", apiRateLimiter, catalogItemsRouter);
app.use("/api/v1/conversations", apiRateLimiter, conversationsRouter);
app.use("/api/v1/faqs", apiRateLimiter, faqsRouter);
app.use("/api/v1", apiRateLimiter, healthRouter);

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use(errorHandler);

export default app;
