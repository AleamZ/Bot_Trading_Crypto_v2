import type { CreateExecutionIntentInput, ExecutionAuditEvent, ExecutionIntent, ExecutionIntentStatus } from "./ExecutionIntent.js";

export interface ExecutionIntentRepository {
  migrate?(): Promise<void>;
  createOrGet(input: CreateExecutionIntentInput): Promise<{ intent: ExecutionIntent; created: boolean }>;
  findBySetupKey(tradingAccountId: string, setupKey: string): Promise<ExecutionIntent | null>;
  listByAccount(tradingAccountId: string, limit?: number): Promise<ExecutionIntent[]>;
  listOpenByAccount(tradingAccountId: string): Promise<ExecutionIntent[]>;
  transitionStatus(id: string, expected: ExecutionIntentStatus[], next: ExecutionIntentStatus, patch?: Partial<ExecutionIntent>): Promise<ExecutionIntent | null>;
  saveAuditEvent(event: ExecutionAuditEvent): Promise<void>;
  listAuditEvents(tradingAccountId: string, executionIntentId?: string, limit?: number, type?: string): Promise<ExecutionAuditEvent[]>;
  deleteAccountData?(tradingAccountId: string): Promise<void>;
}
