import type { RiskDecision, RiskInput } from "./RiskDecision.js";

export function evaluateRisk(input: RiskInput): RiskDecision {
  const positionSize = input.marginPerTrade * input.leverage;
  const quantity = positionSize / input.entry;
  const estimatedLoss = Math.abs(input.entry - input.stopLoss) * quantity;
  const estimatedProfit = Math.abs(input.takeProfit - input.entry) * quantity;
  const riskReward = estimatedLoss > 0 ? estimatedProfit / estimatedLoss : 0;
  const baseDecision = {
    margin: input.marginPerTrade,
    leverage: input.leverage,
    positionSize,
    quantity,
    notional: positionSize,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    estimatedLoss,
    estimatedProfit,
    riskReward,
    createdAt: input.createdAt
  };

  if (input.killSwitch) return reject("Kill switch is enabled", baseDecision);
  if (input.availableBalance <= 0) return reject("Available balance must be greater than zero", baseDecision);
  if (input.marginPerTrade <= 0) return reject("Margin per trade must be greater than zero", baseDecision);
  if (input.leverage <= 0) return reject("Leverage must be greater than zero", baseDecision);
  if (input.leverage > input.maxLeverage) return reject("Leverage exceeds configured maximum", baseDecision);
  if (input.entry <= 0) return reject("Entry price must be greater than zero", baseDecision);
  if (input.stopLoss <= 0) return reject("Stop loss must be greater than zero", baseDecision);
  if (input.takeProfit <= 0) return reject("Take profit must be greater than zero", baseDecision);
  if (input.marginPerTrade > input.availableBalance) return reject("Margin requirement exceeds available balance", baseDecision);
  if (positionSize < input.minNotional) return reject("Position size is below minimum notional", baseDecision);
  if (positionSize > input.maxPositionSize) return reject("Position size exceeds maximum position size", baseDecision);
  if (input.openPositions >= input.maxOpenPositions) return reject("Maximum open positions reached", baseDecision);
  if (input.dailyLossPercent >= input.maxDailyLossPercent) return reject("Daily loss breaker is active", baseDecision);
  if (input.drawdownPercent >= input.maxDrawdownPercent) return reject("Drawdown breaker is active", baseDecision);
  if (riskReward <= 0) return reject("Risk reward must be greater than zero", baseDecision);

  return {
    accepted: true,
    reason: "Risk passed",
    ...baseDecision
  };
}

function reject(reason: string, decision: Omit<RiskDecision, "accepted" | "reason">): RiskDecision {
  return {
    accepted: false,
    reason,
    ...decision
  };
}
