import type { CreateExecutionIntentInput, ExecutionAuditEvent, ExecutionIntent, ExecutionIntentStatus } from "../../application/execution/ExecutionIntent.js";
import type { ExecutionIntentRepository } from "../../application/execution/ExecutionIntentRepository.js";

export class MemoryExecutionIntentRepository implements ExecutionIntentRepository {
  private readonly intents = new Map<string, ExecutionIntent>();
  private readonly setupIndex = new Map<string, string>();
  private readonly auditEvents: ExecutionAuditEvent[] = [];

  async createOrGet(input: CreateExecutionIntentInput): Promise<{ intent: ExecutionIntent; created: boolean }> {
    const key = indexKey(input.tradingAccountId, input.setupKey);
    const existingId = this.setupIndex.get(key);
    if (existingId) return { intent: cloneIntent(this.intents.get(existingId) as ExecutionIntent), created: false };

    const now = new Date().toISOString();
    const intent: ExecutionIntent = {
      id: input.id,
      tradingAccountId: input.tradingAccountId,
      symbol: input.symbol,
      side: input.side,
      setupKey: input.setupKey,
      status: "CREATED",
      entryType: input.entryType,
      requestedEntry: input.requestedEntry,
      requestedStopLoss: input.requestedStopLoss,
      requestedTakeProfit: input.requestedTakeProfit,
      quantity: input.quantity,
      binanceEntryOrderId: null,
      binanceStopOrderId: null,
      binanceTakeProfitOrderId: null,
      clientEntryOrderId: input.clientEntryOrderId,
      clientStopOrderId: input.clientStopOrderId,
      clientTakeProfitOrderId: input.clientTakeProfitOrderId,
      source: input.source ?? "BOT",
      version: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    this.intents.set(intent.id, intent);
    this.setupIndex.set(key, intent.id);
    return { intent: cloneIntent(intent), created: true };
  }

  async findBySetupKey(tradingAccountId: string, setupKey: string): Promise<ExecutionIntent | null> {
    const id = this.setupIndex.get(indexKey(tradingAccountId, setupKey));
    const intent = id ? this.intents.get(id) : null;
    return intent ? cloneIntent(intent) : null;
  }

  async listByAccount(tradingAccountId: string, limit = 100): Promise<ExecutionIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => intent.tradingAccountId === tradingAccountId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(cloneIntent);
  }

  async listOpenByAccount(tradingAccountId: string): Promise<ExecutionIntent[]> {
    const closed = new Set<ExecutionIntentStatus>(["CLOSED", "CANCELLED", "FAILED"]);
    return [...this.intents.values()].filter((intent) => intent.tradingAccountId === tradingAccountId && !closed.has(intent.status)).map(cloneIntent);
  }

  async transitionStatus(id: string, expected: ExecutionIntentStatus[], next: ExecutionIntentStatus, patch: Partial<ExecutionIntent> = {}): Promise<ExecutionIntent | null> {
    const current = this.intents.get(id);
    if (!current || !expected.includes(current.status)) return null;
    const updated: ExecutionIntent = {
      ...current,
      ...patch,
      id: current.id,
      tradingAccountId: current.tradingAccountId,
      setupKey: current.setupKey,
      status: next,
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    };
    this.intents.set(id, updated);
    return cloneIntent(updated);
  }

  async saveAuditEvent(event: ExecutionAuditEvent): Promise<void> {
    this.auditEvents.push({ ...event, metadata: { ...event.metadata } });
  }

  async listAuditEvents(tradingAccountId: string, executionIntentId?: string, limit = 100, type?: string): Promise<ExecutionAuditEvent[]> {
    return this.auditEvents
      .filter((event) => event.tradingAccountId === tradingAccountId && (!executionIntentId || event.executionIntentId === executionIntentId) && (!type || event.type === type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((event) => ({ ...event, metadata: { ...event.metadata } }));
  }

  async deleteAccountData(tradingAccountId: string): Promise<void> {
    for (const intent of this.intents.values()) {
      if (intent.tradingAccountId !== tradingAccountId) continue;
      this.intents.delete(intent.id);
      this.setupIndex.delete(indexKey(intent.tradingAccountId, intent.setupKey));
    }
    for (let index = this.auditEvents.length - 1; index >= 0; index -= 1) {
      if (this.auditEvents[index]?.tradingAccountId === tradingAccountId) this.auditEvents.splice(index, 1);
    }
  }
}

function indexKey(tradingAccountId: string, setupKey: string): string {
  return `${tradingAccountId}:${setupKey}`;
}

function cloneIntent(intent: ExecutionIntent): ExecutionIntent {
  return { ...intent };
}
