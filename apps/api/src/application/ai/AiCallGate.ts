/** Default spacing between AI advisor model calls (AI_MIN_CALL_INTERVAL_MS). */
export const DEFAULT_AI_MIN_CALL_INTERVAL_MS = 30_000;

/**
 * Spaces LLM calls so a burst (several symbols or accounts eligible on the same scan) does not hit
 * the model provider at once: each acquire() starts at least intervalMs after the previous one, in
 * the order acquire() was called. One instance is shared by every advisor in the process.
 */
export class AiCallGate {
  private nextStartAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** Resolves when the caller may start its call, with how long it waited. */
  async acquire(): Promise<number> {
    const now = this.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.intervalMs;
    const waitedMs = startAt - now;
    if (waitedMs > 0) await this.sleep(waitedMs);
    return waitedMs;
  }
}
