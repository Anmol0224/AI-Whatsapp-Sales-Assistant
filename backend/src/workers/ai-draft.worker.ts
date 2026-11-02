import type { AiDraftWorkerOutcome } from "../services/ai-draft-processor.service.js";
import { subscribeToAiDraftWorkerWake } from "../services/ai-draft-worker-wake.js";

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
  let wakeVersion = 0;
  let unsubscribeWake: (() => void) | null = null;

  function handleWake(): void {
    if (stopping) return;
    wakeVersion += 1;
    wakePendingWait?.();
  }

  function waitForNextPoll(observedWakeVersion: number): Promise<void> {
    if (stopping || wakeVersion !== observedWakeVersion) return Promise.resolve();

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
      const observedWakeVersion = wakeVersion;
      let outcome: AiDraftWorkerOutcome | undefined;
      try {
        outcome = await options.processNext();
      } catch {
        reportError();
      }

      if (stopping) break;

      // A claimed job may have been completed or deferred. Immediately drain any other
      // currently eligible jobs; claimNext still enforces nextAttemptAt and the lease fences.
      if (outcome && outcome.kind !== "idle") continue;

      // Idle polling remains the fallback for other processes and missed notifications.
      // A wake received while this cycle was running skips the wait without overlapping it.
      await waitForNextPoll(observedWakeVersion);
    }
  }

  function start(): boolean {
    if (!enabled || loopPromise) return false;
    stopping = false;
    unsubscribeWake = subscribeToAiDraftWorkerWake(handleWake);
    loopPromise = run();
    return true;
  }

  async function stop(): Promise<void> {
    const currentLoop = loopPromise;
    if (!currentLoop) return;
    stopping = true;
    unsubscribeWake?.();
    unsubscribeWake = null;
    wakePendingWait?.();
    await currentLoop;
    if (loopPromise === currentLoop) loopPromise = null;
  }

  return { start, stop };
}
