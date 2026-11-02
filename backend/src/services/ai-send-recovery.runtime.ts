import { recoverExpiredAiReplySendReservations } from "./ai-reply-job.repository.js";

export const AI_SEND_RECOVERY_INTERVAL_MS = 30_000;
export const AI_SEND_RECOVERY_BATCH_LIMIT = 100;

export type AiSendRecoveryErrorCategory = "database_recovery_failed";

export interface AiSendRecoveryRuntimeOptions {
  intervalMs?: number;
  batchLimit?: number;
  recover?: typeof recoverExpiredAiReplySendReservations;
  schedule?: (callback: () => void, intervalMs: number) => () => void;
  onError?: (category: AiSendRecoveryErrorCategory) => void;
}

function scheduleInterval(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
}

/** Runs bounded send-reservation recovery independently of the Gemini draft worker. */
export function createAiSendRecoveryRuntime(options: AiSendRecoveryRuntimeOptions = {}) {
  const intervalMs = options.intervalMs ?? AI_SEND_RECOVERY_INTERVAL_MS;
  const batchLimit = options.batchLimit ?? AI_SEND_RECOVERY_BATCH_LIMIT;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
    throw new Error("INVALID_AI_SEND_RECOVERY_INTERVAL");
  }
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1000) {
    throw new Error("INVALID_AI_SEND_RECOVERY_BATCH_LIMIT");
  }

  const recover = options.recover ?? recoverExpiredAiReplySendReservations;
  const schedule = options.schedule ?? scheduleInterval;
  const reportError = options.onError ?? ((category) => {
    console.error(`Expired AI send recovery cycle failed (${category}).`);
  });

  let started = false;
  let stopping = false;
  let cancelSchedule: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;

  async function runCycle(): Promise<void> {
    if (!started || stopping || inFlight) return;

    let cycle!: Promise<void>;
    cycle = Promise.resolve()
      .then(() => recover(new Date(), batchLimit))
      .then(() => undefined)
      .catch(() => {
        try {
          reportError("database_recovery_failed");
        } catch {
          // Diagnostics must not turn a failed recovery cycle into an application failure.
        }
      })
      .finally(() => {
        if (inFlight === cycle) inFlight = null;
      });
    inFlight = cycle;
    await cycle;
  }

  function start(): boolean {
    if (started || stopping) return false;
    started = true;
    cancelSchedule = schedule(() => { void runCycle(); }, intervalMs);
    void runCycle();
    return true;
  }

  async function stop(): Promise<void> {
    if (!stopping) {
      stopping = true;
      started = false;
      cancelSchedule?.();
      cancelSchedule = null;
    }
    await inFlight;
  }

  return { start, stop };
}
