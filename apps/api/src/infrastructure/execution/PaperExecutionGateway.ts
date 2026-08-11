import type { ExecutionGateway, SubmittedOrder } from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export class PaperExecutionGateway implements ExecutionGateway {
  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder> {
    return {
      orderId: `paper:${risk.symbol}:${plan.direction}:${plan.entry}:${plan.stopLoss}:${plan.takeProfit}:${risk.quantity}`,
      mode: "paper"
    };
  }
}
