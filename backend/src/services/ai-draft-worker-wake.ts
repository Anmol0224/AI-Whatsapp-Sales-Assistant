type WakeListener = () => void;

const listeners = new Set<WakeListener>();

/** Subscribe one running worker to process-local notifications for newly committed jobs. */
export function subscribeToAiDraftWorkerWake(listener: WakeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notify running workers after a queued job has committed. Notifications are best-effort. */
export function wakeAiDraftWorker(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A wake notification must never fail an already committed webhook transaction.
    }
  }
}
