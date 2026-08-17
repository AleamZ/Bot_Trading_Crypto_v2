import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export type ExecutionIntentStatus =
  | "CREATED"
  | "RISK_APPROVED"
  | "ENTRY_SUBMITTING"
  | "ENTRY_SUBMITTED"
  | "ENTRY_FILLED"
  | "PROTECTION_SUBMITTING"
  | "PROTECTED"
  | "PROTECTION_INCOMPLETE"
  | "CLOSING"
  | "CLOSED"
  | "CANCELLED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED"
  | "BINANCE_CONNECTION_LOST";

export type ExecutionSide = "long" | "short";
export type ExecutionSource = "BOT" | "EXTERNAL" | "UNKNOWN";

export interface ExecutionIntent {
  id: string;
  tradingAccountId: string;
  symbol: string;
  side: ExecutionSide;
  setupKey: string;
  status: ExecutionIntentStatus;
  entryType: "limit" | "market" | null;
  requestedEntry: number | null;
  requestedStopLoss: number | null;
  requestedTakeProfit: number | null;
  quantity: number | null;
  binanceEntryOrderId: string | null;
  binanceStopOrderId: string | null;
  binanceTakeProfitOrderId: string | null;
  clientEntryOrderId: string | null;
  clientStopOrderId: string | null;
  clientTakeProfitOrderId: string | null;
  source: ExecutionSource;
  version: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExecutionIntentInput {
  id: string;
  tradingAccountId: string;
  symbol: string;
  side: ExecutionSide;
  setupKey: string;
  entryType: "limit" | "market";
  requestedEntry: number;
  requestedStopLoss: number;
  requestedTakeProfit: number;
  quantity: number;
  clientEntryOrderId: string;
  clientStopOrderId: string;
  clientTakeProfitOrderId: string;
}

export interface ExecutionAuditEvent {
  id: string;
  tradingAccountId: string;
  executionIntentId: string | null;
  symbol: string | null;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function buildSetupKey(tradingAccountId: string, plan: EntryPlan, risk: RiskDecision): string {
  return [
    tradingAccountId,
    risk.symbol,
    plan.direction,
    numberKey(plan.entry),
    numberKey(plan.stopLoss),
    numberKey(plan.takeProfit),
    numberKey(risk.quantity)
  ].join(":");
}

export function sideFromDirection(direction: EntryPlan["direction"]): ExecutionSide {
  return direction === "bullish" ? "long" : "short";
}

function numberKey(value: number): string {
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}
