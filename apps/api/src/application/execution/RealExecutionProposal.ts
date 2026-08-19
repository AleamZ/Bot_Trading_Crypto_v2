import crypto from "node:crypto";

export type RealExecutionProposalStatus = "PENDING" | "DRY_RUN" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "EXECUTION_BLOCKED" | "EXECUTED";

export interface RealExecutionProposal {
  id: string;
  tradingAccountId: string;
  setupKey: string;
  symbol: string;
  direction: "bullish" | "bearish";
  status: RealExecutionProposalStatus;
  requestedEntryType: "limit" | "market";
  requestedEntryPrice: number;
  normalizedEntryPrice: number | null;
  requestedQuantity: number;
  normalizedQuantity: number;
  requestedStopLoss: number;
  normalizedStopLoss: number;
  requestedTakeProfit: number;
  normalizedTakeProfit: number;
  estimatedNotional: number;
  estimatedMargin: number;
  configuredLeverage: number;
  configuredMarginMode: "CROSS" | "ISOLATED";
  symbolTickSize: number;
  symbolStepSize: number;
  symbolMinQty: number;
  symbolMinNotional: number | null;
  proposalHash: string;
  strategySnapshot: Record<string, unknown>;
  riskSnapshot: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  executedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  executionIntentId: string | null;
}

export interface CreateRealExecutionProposalInput extends Omit<
  RealExecutionProposal,
  "createdAt" | "approvedAt" | "approvedByUserId" | "executedAt" | "rejectedAt" | "cancelledAt" | "executionIntentId"
> {}

export function fingerprintProposal(input: Pick<
  RealExecutionProposal,
  | "tradingAccountId"
  | "setupKey"
  | "symbol"
  | "direction"
  | "normalizedQuantity"
  | "normalizedEntryPrice"
  | "normalizedStopLoss"
  | "normalizedTakeProfit"
  | "configuredLeverage"
  | "configuredMarginMode"
  | "symbolTickSize"
  | "symbolStepSize"
  | "symbolMinQty"
  | "symbolMinNotional"
>): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        tradingAccountId: input.tradingAccountId,
        setupKey: input.setupKey,
        symbol: input.symbol,
        direction: input.direction,
        normalizedQuantity: input.normalizedQuantity,
        normalizedEntryPrice: input.normalizedEntryPrice,
        normalizedStopLoss: input.normalizedStopLoss,
        normalizedTakeProfit: input.normalizedTakeProfit,
        configuredLeverage: input.configuredLeverage,
        configuredMarginMode: input.configuredMarginMode,
        symbolTickSize: input.symbolTickSize,
        symbolStepSize: input.symbolStepSize,
        symbolMinQty: input.symbolMinQty,
        symbolMinNotional: input.symbolMinNotional
      })
    )
    .digest("hex");
}
