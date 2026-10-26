import type { AiProgressStep } from "../ai/AiTradeAdvisor.js";

/** What changed in an account runtime; listeners re-read the state they need. */
export type LiveChange =
  | { topic: "scan"; symbol: string }
  | { topic: "reconcile" }
  | { topic: "config" }
  | { topic: "ai-step"; step: AiProgressStep }
  /** The runtime is going away (account deleted, execution disabled, shutdown): close streams. */
  | { topic: "closed" };

export type LiveListener = (change: LiveChange) => void;

/** AI steps kept per account so a dashboard that connects late still sees what the AI did recently. */
export const AI_STEP_HISTORY = 50;

/** Per-account fan-out of runtime changes to live dashboard streams. Listener errors never reach the runtime. */
export class LiveUpdateHub {
  private readonly listeners = new Map<string, Set<LiveListener>>();
  private readonly aiSteps = new Map<string, AiProgressStep[]>();

  subscribe(accountId: string, listener: LiveListener): () => void {
    const current = this.listeners.get(accountId) ?? new Set<LiveListener>();
    current.add(listener);
    this.listeners.set(accountId, current);
    return () => {
      current.delete(listener);
      if (current.size === 0 && this.listeners.get(accountId) === current) this.listeners.delete(accountId);
    };
  }

  publish(accountId: string, change: LiveChange): void {
    for (const listener of [...(this.listeners.get(accountId) ?? [])]) {
      try {
        listener(change);
      } catch {
        // A broken stream must not affect the runtime or the other streams.
      }
    }
  }

  recordAiStep(accountId: string, step: AiProgressStep): void {
    const steps = this.aiSteps.get(accountId) ?? [];
    steps.push(step);
    if (steps.length > AI_STEP_HISTORY) steps.splice(0, steps.length - AI_STEP_HISTORY);
    this.aiSteps.set(accountId, steps);
    this.publish(accountId, { topic: "ai-step", step });
  }

  recentAiSteps(accountId: string): AiProgressStep[] {
    return [...(this.aiSteps.get(accountId) ?? [])];
  }

  listenerCount(accountId: string): number {
    return this.listeners.get(accountId)?.size ?? 0;
  }

  closeAccount(accountId: string): void {
    this.publish(accountId, { topic: "closed" });
    this.listeners.delete(accountId);
    this.aiSteps.delete(accountId);
  }

  closeAll(): void {
    for (const accountId of [...this.listeners.keys()]) this.closeAccount(accountId);
    this.aiSteps.clear();
  }
}
