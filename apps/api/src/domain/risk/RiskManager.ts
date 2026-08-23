import { normalizeQuantity } from "../symbol/SymbolRules.js";
import type { RiskDecision, RiskInput, RiskRejectCode } from "./RiskDecision.js";

export function evaluateRisk(input: RiskInput): RiskDecision {
  const stopDistance = Math.abs(input.entry - input.stopLoss);
  const rawQuantity = input.riskPerTradeUsdt > 0 && stopDistance > 0 ? input.riskPerTradeUsdt / stopDistance : 0;
  const quantity = normalizeQuantity(rawQuantity, input.symbolRules.stepSize);
  const positionSize = quantity * input.entry;
  const actualRiskUsdt = quantity * stopDistance;
  const rawRequiredLeverage = positionSize > 0 && input.availableBalance > 0 ? positionSize / input.availableBalance : 0;
  const selectedLeverage = Number.isFinite(rawRequiredLeverage) ? Math.max(1, Math.ceil(rawRequiredLeverage)) : 0;
  const requiredMargin = selectedLeverage > 0 ? positionSize / selectedLeverage : 0;
  const estimatedLoss = actualRiskUsdt;
  const estimatedProfit = Math.abs(input.takeProfit - input.entry) * quantity;
  const riskReward = actualRiskUsdt > 0 ? estimatedProfit / actualRiskUsdt : 0;
  const baseDecision = {
    symbol: input.symbol,
    margin: requiredMargin,
    leverage: selectedLeverage,
    requiredLeverage: rawRequiredLeverage,
    selectedLeverage,
    requiredMargin,
    maxLeverage: input.maxLeverage,
    maxMarginUsagePercent: input.maxMarginUsagePercent,
    positionSize,
    quantity,
    notional: positionSize,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    estimatedLoss,
    estimatedProfit,
    actualRiskUsdt,
    targetRiskUsdt: input.riskPerTradeUsdt,
    riskPerTradeUsdt: input.riskPerTradeUsdt,
    availableBalance: input.availableBalance,
    maxAllowedMargin: input.availableBalance * (input.maxMarginUsagePercent / 100),
    marginUsagePercent: input.availableBalance > 0 ? (requiredMargin / input.availableBalance) * 100 : 0,
    riskReward,
    createdAt: input.createdAt
  };

  if (input.killSwitch) return reject("KILL_SWITCH", "Kill switch is enabled", baseDecision);
  if (input.availableBalance <= 0) return reject("INVALID_BALANCE", "Available balance must be greater than zero", baseDecision);
  if (input.riskPerTradeUsdt <= 0) return reject("INVALID_RISK_PER_TRADE", "Risk per trade must be greater than zero", baseDecision);
  if (input.entry <= 0 || input.stopLoss <= 0 || input.takeProfit <= 0 || stopDistance <= 0) return reject("INVALID_PRICE", "Entry, stop loss, take profit and stop distance must be valid", baseDecision);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(positionSize) || positionSize <= 0) return reject("INVALID_QUANTITY", "Calculated quantity and position size must be valid", baseDecision);
  if (quantity < input.symbolRules.minQty) return reject("MIN_QTY", "Quantity is below Binance minimum quantity", baseDecision);
  if (input.symbolRules.maxQty !== null && quantity > input.symbolRules.maxQty) return reject("MAX_QTY", "Quantity exceeds Binance maximum quantity", baseDecision);
  if (input.symbolRules.minNotional !== null && positionSize < input.symbolRules.minNotional) return reject("MIN_NOTIONAL", "Position size is below Binance minimum notional", baseDecision);
  if (selectedLeverage > input.maxLeverage || (input.symbolRules.maxLeverage !== null && selectedLeverage > input.symbolRules.maxLeverage)) return reject("REQUIRED_LEVERAGE_EXCEEDS_MAX", "Required leverage exceeds configured or Binance maximum", baseDecision);
  if (requiredMargin > input.availableBalance) return reject("MARGIN_REQUIREMENT", "Required margin exceeds available balance", baseDecision);
  if (requiredMargin > input.availableBalance * (input.maxMarginUsagePercent / 100)) return reject("MAX_MARGIN_USAGE_EXCEEDED", "Required margin exceeds configured maximum margin usage", baseDecision);
  if (riskReward < input.minimumRiskReward) return reject("RR_BELOW_MINIMUM", `Risk reward ${formatNumber(riskReward)} is below minimum ${formatNumber(input.minimumRiskReward)}`, baseDecision);
  if (!input.tradingEnabled) return reject("TRADING_DISABLED", "Trading is disabled", baseDecision);
  if (input.openPositions >= input.maxOpenPositions) return reject("MAX_OPEN_POSITIONS", "Maximum open positions reached", baseDecision);
  if (input.symbolOpenPositions >= input.maxPositionPerSymbol) return reject("POSITION_ALREADY_OPEN", "Maximum position per symbol reached", baseDecision);
  if (input.drawdownPercent >= input.maxDrawdownPercent) return reject("MAX_DRAWDOWN_REACHED", "Max drawdown protection is active", baseDecision);

  return { accepted: true, reason: "Risk passed", ...baseDecision };
}

function reject(code: RiskRejectCode, reason: string, decision: Omit<RiskDecision, "accepted" | "reason" | "rejectCode">): RiskDecision {
  return { accepted: false, reason, rejectCode: code, ...decision };
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
