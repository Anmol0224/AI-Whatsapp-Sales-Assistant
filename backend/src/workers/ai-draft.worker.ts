import type { AiDraftWorkerOutcome } from "../services/ai-draft-processor.service.js";

export interface AiDraftWorkerRuntimeOptions {
  enabled?: boolean;
  pollingIntervalMs?: number;
  processNext(): Promise<AiDraftWorkerOutcome>;
  onError?: () => void;
}

/**
 * Runs one processing cycle at a time. Shutdown stops future claims and waits for the
 * current cycle; an in-flight Gemini request is allowed to finish because the SDK
 * request cannot be cancelled through the current adapter.
 */
export function createAiDraftWorkerRuntime(options: AiDraftWorkerRuntimeOptions) {
  const enabled = options.enabled ?? false;
  const pollingIntervalMs = options.pollingIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(pollingIntervalMs) || pollingIntervalMs < 250 || pollingIntervalMs > 60_000) {
    throw new Error("INVALID_AI_DRAFT_WORKER_POLL_INTERVAL");
  }

  const reportError = options.onError ?? (() => {
    console.error("AI draft worker iteration failed; eligible jobs will be recovered by lease handling.");
  });

  let stopping = false;
  let loopPromise: Promise<void> | null = null;
  let wakePendingWait: (() => void) | null = null;

  function waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakePendingWait = null;
        resolve();
      }, pollingIntervalMs);
      wakePendingWait = () => {
        clearTimeout(timer);
        wakePendingWait = null;
        resolve();
      };
    });
  }

  async function run(): Promise<void> {
    while (!stopping) {
      try {
        await options.processNext();
      } catch {
        reportError();
      }

      if (!stopping) await waitForNextPoll();
    }
  }

  function start(): boolean {
    if (!enabled || loopPromise) return false;
    stopping = false;
    loopPromise = run();
    return true;
  }

  async function stop(): Promise<void> {
    const currentLoop = loopPromise;
    if (!currentLoop) return;
    stopping = true;
    wakePendingWait?.();
    await currentLoop;
    if (loopPromise === currentLoop) loopPromise = null;
  }

  return { start, stop };
}
