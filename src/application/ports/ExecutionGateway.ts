import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export interface SubmittedOrder {
  orderId: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  mode: "testnet" | "live";
}

export interface ExecutionGateway {
  submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder>;
}
