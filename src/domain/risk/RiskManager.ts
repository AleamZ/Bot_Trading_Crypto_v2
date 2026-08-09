import type { RiskDecision, RiskInput, RiskRejectCode } from "./RiskDecision.js";

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

  if (input.killSwitch) return reject("KILL_SWITCH", "Kill switch is enabled", baseDecision);
  if (input.availableBalance <= 0) return reject("INVALID_BALANCE", "Available balance must be greater than zero", baseDecision);
  if (input.marginPerTrade <= 0) return reject("INVALID_MARGIN", "Margin per order must be greater than zero", baseDecision);
  if (input.leverage <= 0) return reject("INVALID_LEVERAGE", "Leverage must be greater than zero", baseDecision);
  if (input.leverage > input.maxLeverage) return reject("INVALID_LEVERAGE", "Leverage exceeds configured maximum", baseDecision);
  if (input.entry <= 0 || input.stopLoss <= 0 || input.takeProfit <= 0) return reject("INVALID_PRICE", "Entry, stop loss and take profit must be greater than zero", baseDecision);
  if (input.marginPerTrade > input.availableBalance) return reject("MARGIN_REQUIREMENT", "Margin requirement exceeds available balance", baseDecision);
  if (positionSize < input.minNotional) return reject("MIN_NOTIONAL", "Position size is below minimum notional", baseDecision);
  if (positionSize > input.maxPositionSize) return reject("MAX_POSITION_SIZE", "Position size exceeds maximum position size", baseDecision);
  if (riskReward < input.minimumRiskReward) return reject("MIN_RR_NOT_MET", `Risk reward ${formatNumber(riskReward)} is below minimum ${formatNumber(input.minimumRiskReward)}`, baseDecision);
  if (!input.tradingEnabled) return reject("TRADING_DISABLED", "Trading is disabled", baseDecision);
  if (input.openPositions >= input.maxOpenPositions) return reject("MAX_OPEN_POSITIONS", "Maximum open positions reached", baseDecision);
  if (input.tradesToday >= input.maxTradesPerDay) return reject("MAX_TRADES_PER_DAY", "Maximum trades per day reached", baseDecision);
  if (input.dailyRealizedLoss >= input.availableBalance * (input.dailyLossLimitPercent / 100)) return reject("DAILY_LOSS_LIMIT", "Daily realized loss limit is active", baseDecision);
  if (input.consecutiveLosses >= input.maxConsecutiveLosses) return reject("MAX_CONSECUTIVE_LOSSES", "Maximum consecutive losses reached", baseDecision);
  if (isCooldownActive(input)) return reject("COOLDOWN_ACTIVE", "Cooldown after trade is active", baseDecision);
  if (input.drawdownPercent >= input.maxDrawdownPercent) return reject("DRAWDOWN_LIMIT", "Drawdown breaker is active", baseDecision);

  return {
    accepted: true,
    reason: "Risk passed",
    ...baseDecision
  };
}

function reject(code: RiskRejectCode, reason: string, decision: Omit<RiskDecision, "accepted" | "reason" | "rejectCode">): RiskDecision {
  return {
    accepted: false,
    reason,
    rejectCode: code,
    ...decision
  };
}

function isCooldownActive(input: RiskInput): boolean {
  if (input.lastClosedTradeAt === null || input.cooldownAfterTradeMinutes <= 0) return false;
  const cooldownMs = input.cooldownAfterTradeMinutes * 60_000;
  return input.availableAt - input.lastClosedTradeAt < cooldownMs;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
