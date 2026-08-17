import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export interface SubmittedOrder {
  orderId: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  clientEntryOrderId?: string;
  clientStopOrderId?: string;
  clientTakeProfitOrderId?: string;
  mode: "paper" | "testnet" | "live";
}

export interface ExecutionOrderContext {
  executionIntentId: string;
  setupKey: string;
  clientEntryOrderId: string;
  clientStopOrderId: string;
  clientTakeProfitOrderId: string;
}

export interface ExecutionGateway {
  submitBracketOrder(plan: EntryPlan, risk: RiskDecision, context?: ExecutionOrderContext): Promise<SubmittedOrder>;
}

export interface ExecutionOrderLookupResult {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL" | string;
  type: string;
  status: string;
  reduceOnly: boolean;
  originalQuantity: number;
  executedQuantity: number;
  averagePrice: number | null;
}

export interface ProtectionOrderRequest {
  symbol: string;
  side: "BUY" | "SELL";
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  stopPrice: number;
  clientOrderId: string;
}

export interface RecoverableExecutionGateway extends ExecutionGateway {
  findOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<ExecutionOrderLookupResult | null>;
  submitProtectionOrder(request: ProtectionOrderRequest): Promise<ExecutionOrderLookupResult>;
  cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<void>;
}

export function isRecoverableExecutionGateway(gateway: ExecutionGateway): gateway is RecoverableExecutionGateway {
  const candidate = gateway as Partial<RecoverableExecutionGateway>;
  return (
    typeof candidate.findOrderByClientOrderId === "function" &&
    typeof candidate.submitProtectionOrder === "function" &&
    typeof candidate.cancelOrderByClientOrderId === "function"
  );
}
