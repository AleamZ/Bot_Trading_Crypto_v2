import type { ExecutionGateway, SubmittedOrder } from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

export class LockedRealExecutionGateway implements ExecutionGateway {
  async submitBracketOrder(_plan: EntryPlan, _risk: RiskDecision): Promise<SubmittedOrder> {
    throw new Error("REAL_EXECUTION_LOCKED");
  }
}
