import app from "./app.js";
import mongoose from "mongoose";
import type { Server } from "node:http";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { createAiDraftProcessor } from "./services/ai-draft-processor.service.js";
import { createAiAutomaticReplyProcessor } from "./services/ai-automatic-reply-processor.service.js";
import { businessContextService } from "./services/business-context.service.js";
import { buildBusinessReplyPrompt } from "./services/business-prompt-builder.service.js";
import { createAiSendRecoveryRuntime } from "./services/ai-send-recovery.runtime.js";
import { createGeminiService } from "./services/gemini.service.js";
import { createAiDraftWorkerRuntime } from "./workers/ai-draft.worker.js";

let apiServer: Server | null = null;
let aiDraftWorker: ReturnType<typeof createAiDraftWorkerRuntime> | null = null;
const aiSendRecovery = createAiSendRecoveryRuntime();
let shutdownPromise: Promise<void> | null = null;
let shuttingDown = false;

function startAiDraftWorkerIfConfigured(): void {
  if (shuttingDown) return;
  if (!env.AI_DRAFT_WORKER_ENABLED) return;
  if (!env.GEMINI_API_KEY) {
    console.warn("AI draft worker is enabled but Gemini credentials are missing; the API will remain available and the worker will stay stopped.");
    return;
  }

  try {
    const generator = createGeminiService({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
    });
    const automaticProcessor = createAiAutomaticReplyProcessor({
      contextService: businessContextService,
      promptBuilder: buildBusinessReplyPrompt,
      generator,
    });
    const processor = createAiDraftProcessor({
      generator,
      automaticProcessor,
    });
    aiDraftWorker = createAiDraftWorkerRuntime({
      enabled: true,
      pollingIntervalMs: env.AI_DRAFT_WORKER_POLL_INTERVAL_MS,
      processNext: processor.processNext,
    });
    if (aiDraftWorker.start()) console.info("AI draft worker started.");
  } catch {
    console.error("AI draft worker could not start; the API will remain available.");
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  console.info(`Received ${signal}; beginning graceful shutdown.`);

  shutdownPromise = (async () => {
    const closeServer = apiServer?.listening
      ? new Promise<boolean>((resolve) => {
          try {
            apiServer!.close((error) => resolve(!error));
          } catch {
            resolve(false);
          }
        })
      : Promise.resolve(true);

    let shutdownFailed = false;

    try {
      await aiSendRecovery.stop();
    } catch {
      shutdownFailed = true;
      console.error("AI send recovery shutdown failed.");
    }

    try {
      await aiDraftWorker?.stop();
    } catch {
      shutdownFailed = true;
      console.error("AI draft worker shutdown failed.");
    }

    if (!(await closeServer)) {
      shutdownFailed = true;
      console.error("HTTP server shutdown failed.");
    }

    try {
      await mongoose.disconnect();
    } catch {
      shutdownFailed = true;
      console.error("MongoDB disconnect failed.");
    }

    if (shutdownFailed) {
      console.error("Graceful shutdown completed with errors.");
      process.exitCode = 1;
    } else {
      console.info("Graceful shutdown complete.");
    }
  })();

  return shutdownPromise;
}

async function startServer(): Promise<void> {
  try {
    await connectDatabase();
  } catch {
    console.error("MongoDB connection failed. Verify MONGODB_URI and Atlas network access.");
    process.exit(1);
  }

  if (shuttingDown) return;

  aiSendRecovery.start();

  apiServer = app.listen(env.PORT, () => {
    console.log(`WhatsApp Sales Assistant API listening on port ${env.PORT}`);
    startAiDraftWorkerIfConfigured();
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

void startServer();
