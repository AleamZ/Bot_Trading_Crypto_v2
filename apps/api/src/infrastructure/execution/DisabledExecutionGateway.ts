import type { ExecutionGateway, SubmittedOrder } from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export class DisabledExecutionGateway implements ExecutionGateway {
  constructor(private readonly reason = "BINANCE_NOT_CONNECTED") {}

  async submitBracketOrder(_plan: EntryPlan, _risk: RiskDecision): Promise<SubmittedOrder> {
    throw new Error(this.reason);
  }
}
