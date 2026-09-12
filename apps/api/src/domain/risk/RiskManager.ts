import { normalizeQuantity, type MaintenanceMarginBracket } from "../symbol/SymbolRules.js";
import type { RiskDecision, RiskInput, RiskRejectCode } from "./RiskDecision.js";

const MAX_LIQUIDATION_BRACKET_ITERATIONS = 8;

export function evaluateRisk(input: RiskInput): RiskDecision {
  const stopDistance = Math.abs(input.entry - input.stopLoss);
  const rawQuantity = input.riskPerTradeUsdt > 0 && stopDistance > 0 ? input.riskPerTradeUsdt / stopDistance : 0;
  const quantity = normalizeQuantity(rawQuantity, input.symbolRules.stepSize);
  const positionSize = quantity * input.entry;
  const actualRiskUsdt = quantity * stopDistance;
  const currentUsedMargin = Number.isFinite(input.currentUsedMargin ?? 0) && (input.currentUsedMargin ?? 0) >= 0 ? input.currentUsedMargin ?? 0 : 0;
  // Leverage must satisfy both the individual trade cap and the remaining portfolio cap.
  const maxTotalMarginUsagePercent = input.maxTotalMarginUsagePercent ?? 100;
  const maxAllowedMargin = input.availableBalance * (input.maxMarginUsagePercent / 100);
  const maxTotalMargin = input.availableBalance * (maxTotalMarginUsagePercent / 100);
  const remainingTotalMarginBudget = maxTotalMargin - currentUsedMargin;
  const effectiveMaxLeverage = Math.min(input.maxLeverage, input.symbolRules.maxLeverage ?? input.maxLeverage);
  const leverageRequiredForPerTrade = positionSize > 0 && maxAllowedMargin > 0 ? positionSize / maxAllowedMargin : 0;
  const leverageRequiredForTotal = positionSize > 0 && remainingTotalMarginBudget > 0 ? positionSize / remainingTotalMarginBudget : Number.POSITIVE_INFINITY;
  const rawRequiredLeverage = Math.max(1, leverageRequiredForPerTrade, leverageRequiredForTotal);
  const leverageNeededForMargin = Number.isFinite(rawRequiredLeverage) ? Math.ceil(rawRequiredLeverage) : Number.POSITIVE_INFINITY;
  const selectedLeverage = leverageNeededForMargin;
  const requiredMargin = Number.isFinite(selectedLeverage) && selectedLeverage > 0 ? positionSize / selectedLeverage : 0;
  const projectedTotalMargin = currentUsedMargin + requiredMargin;
  const liquidation = evaluateLiquidationSafety(input, quantity, positionSize, requiredMargin);
  const estimatedLoss = actualRiskUsdt;
  const estimatedProfit = Math.abs(input.takeProfit - input.entry) * quantity;
  const riskReward = actualRiskUsdt > 0 ? estimatedProfit / actualRiskUsdt : 0;
  const baseDecision = {
    symbol: input.symbol,
    margin: requiredMargin,
    leverage: selectedLeverage,
    requiredLeverage: rawRequiredLeverage,
    leverageRequiredForPerTrade,
    leverageRequiredForTotal,
    leverageNeededForMargin,
    effectiveMaxLeverage,
    selectedLeverage,
    requiredMargin,
    maxLeverage: input.maxLeverage,
    maxMarginUsagePercent: input.maxMarginUsagePercent,
    marginMode: input.marginMode,
    liquidationSafetyBufferPercent: input.liquidationSafetyBufferPercent,
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
    maxAllowedMargin,
    remainingTotalMarginBudget,
    marginUsagePercent: input.availableBalance > 0 ? (requiredMargin / input.availableBalance) * 100 : 0,
    currentUsedMargin,
    candidateRequiredMargin: requiredMargin,
    projectedTotalMargin,
    totalMarginUsagePercent: input.availableBalance > 0 ? (projectedTotalMargin / input.availableBalance) * 100 : 0,
    maxTotalMarginUsagePercent,
    maintenanceMarginRate: liquidation.maintenanceMarginRate,
    maintenanceMarginAmount: liquidation.maintenanceMarginAmount,
    maintenanceMarginBracket: liquidation.maintenanceMarginBracket,
    estimatedLiquidationPrice: liquidation.estimatedLiquidationPrice,
    distanceSlToLiquidation: liquidation.distanceSlToLiquidation,
    liquidationSafetyStatus: liquidation.status,
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
  if (remainingTotalMarginBudget <= 0) return reject("MAX_TOTAL_MARGIN_USAGE_EXCEEDED", "No remaining portfolio margin budget is available", baseDecision);
  if (selectedLeverage > effectiveMaxLeverage) return reject("REQUIRED_LEVERAGE_EXCEEDS_MAX", "Required leverage exceeds configured or Binance maximum", baseDecision);
  if (requiredMargin > input.availableBalance) return reject("MARGIN_REQUIREMENT", "Required margin exceeds available balance", baseDecision);
  if (requiredMargin > input.availableBalance * (input.maxMarginUsagePercent / 100)) return reject("MAX_MARGIN_USAGE_EXCEEDED", "Required margin exceeds configured maximum margin usage", baseDecision);
  if (projectedTotalMargin > input.availableBalance * (maxTotalMarginUsagePercent / 100)) return reject("MAX_TOTAL_MARGIN_USAGE_EXCEEDED", "Projected portfolio margin exceeds configured maximum total margin usage", baseDecision);
  if (riskReward < input.minimumRiskReward) return reject("RR_BELOW_MINIMUM", `Risk reward ${formatNumber(riskReward)} is below minimum ${formatNumber(input.minimumRiskReward)}`, baseDecision);
  if (!input.tradingEnabled) return reject("TRADING_DISABLED", "Trading is disabled", baseDecision);
  if (input.openPositions >= input.maxOpenPositions) return reject("MAX_OPEN_POSITIONS", "Maximum open positions reached", baseDecision);
  if (input.symbolOpenPositions >= input.maxPositionPerSymbol) return reject("POSITION_ALREADY_OPEN", "Maximum position per symbol reached", baseDecision);
  if (input.drawdownPercent >= input.maxDrawdownPercent) return reject("MAX_DRAWDOWN_REACHED", "Max drawdown protection is active", baseDecision);
	  if (liquidation.status === "UNAVAILABLE") return reject(liquidation.rejectCode ?? "LIQUIDATION_SAFETY_UNAVAILABLE", liquidation.reason ?? "Liquidation safety is unavailable", baseDecision);
  if (liquidation.status === "BLOCKED") return reject("LIQUIDATION_TOO_CLOSE_TO_STOP", liquidation.reason ?? "Liquidation price is too close to stop loss", baseDecision);

  return { accepted: true, reason: "Risk passed", ...baseDecision };
}

function evaluateLiquidationSafety(input: RiskInput, quantity: number, notional: number, initialMargin: number): {
  status: RiskDecision["liquidationSafetyStatus"];
  rejectCode?: RiskRejectCode;
  reason?: string;
  maintenanceMarginRate: number | null;
  maintenanceMarginAmount: number | null;
  maintenanceMarginBracket: RiskDecision["maintenanceMarginBracket"];
  estimatedLiquidationPrice: number | null;
  distanceSlToLiquidation: number | null;
} {
  const unavailable = (rejectCode: RiskRejectCode, reason: string) => ({
    status: "UNAVAILABLE" as const,
    rejectCode,
    reason,
    maintenanceMarginRate: null,
    maintenanceMarginAmount: null,
    maintenanceMarginBracket: null,
    estimatedLiquidationPrice: null,
    distanceSlToLiquidation: null
  });

  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(notional) || notional <= 0 || !Number.isFinite(initialMargin) || initialMargin <= 0) {
    return unavailable("LIQUIDATION_SAFETY_UNAVAILABLE", "Valid quantity, notional and initial margin are required for liquidation safety");
  }

  if (input.marginMode === "CROSS") {
    return unavailable(
      "CROSS_MARGIN_LIQUIDATION_SAFETY_UNSUPPORTED",
      "Cross-margin liquidation safety is not supported for automated execution because account-wide cross collateral exposure is not fully modeled"
    );
  }

  let bracket = findMaintenanceBracket(input.symbolRules.maintenanceMarginBrackets, notional);
  if (!bracket) return unavailable("MAINTENANCE_MARGIN_DATA_UNAVAILABLE", "Maintenance margin bracket data is unavailable for this notional");

  let liquidationPrice: number | null = null;
  for (let iteration = 0; iteration < MAX_LIQUIDATION_BRACKET_ITERATIONS; iteration += 1) {
    const validation = validateMaintenanceBracket(bracket);
    if (validation) return unavailable("MAINTENANCE_MARGIN_DATA_UNAVAILABLE", validation);

    liquidationPrice = calculateLiquidationPrice(input.direction, input.entry, quantity, initialMargin, bracket);
    if (liquidationPrice === null || liquidationPrice < 0) return unavailable("LIQUIDATION_SAFETY_UNAVAILABLE", "Liquidation price could not be calculated safely");

    const liquidationNotional = quantity * liquidationPrice;
    if (!Number.isFinite(liquidationNotional) || liquidationNotional < 0) {
      return unavailable("LIQUIDATION_SAFETY_UNAVAILABLE", "Liquidation notional could not be calculated safely");
    }

    const liquidationBracket = findMaintenanceBracket(input.symbolRules.maintenanceMarginBrackets, liquidationNotional);
    if (!liquidationBracket) return unavailable("MAINTENANCE_MARGIN_DATA_UNAVAILABLE", "Maintenance margin bracket data is unavailable for liquidation notional");
    if (sameMaintenanceBracket(bracket, liquidationBracket)) {
      bracket = liquidationBracket;
      break;
    }
    bracket = liquidationBracket;
    liquidationPrice = null;
  }

  if (liquidationPrice === null) return unavailable("LIQUIDATION_BRACKET_UNRESOLVED", "Liquidation maintenance bracket did not converge");

  const maintenanceMarginAmount = notional * bracket.maintenanceMarginRatio - bracket.cumulativeMaintenanceAmount;
  if (!Number.isFinite(maintenanceMarginAmount) || maintenanceMarginAmount < 0) {
    return unavailable("MAINTENANCE_MARGIN_DATA_UNAVAILABLE", "Maintenance margin amount is invalid");
  }

  const distance =
    input.direction === "bullish"
      ? input.stopLoss - liquidationPrice
      : liquidationPrice - input.stopLoss;
  const requiredBuffer = input.entry * (input.liquidationSafetyBufferPercent / 100);
  const safe = Number.isFinite(distance) && distance > requiredBuffer;
  const status: RiskDecision["liquidationSafetyStatus"] = safe ? "SAFE" : "BLOCKED";
  const result = {
    status,
    maintenanceMarginRate: bracket.maintenanceMarginRatio,
    maintenanceMarginAmount,
    maintenanceMarginBracket: {
      bracket: bracket.bracket,
      notionalFloor: bracket.notionalFloor,
      notionalCap: bracket.notionalCap,
      cumulativeMaintenanceAmount: bracket.cumulativeMaintenanceAmount,
      initialLeverage: bracket.initialLeverage
    },
    estimatedLiquidationPrice: liquidationPrice,
    distanceSlToLiquidation: distance
  };
  return safe ? result : { ...result, reason: `Liquidation price must be at least ${formatNumber(requiredBuffer)} beyond stop loss` };
}

function findMaintenanceBracket(brackets: readonly MaintenanceMarginBracket[], notional: number): MaintenanceMarginBracket | null {
  return (
    brackets
      .filter((bracket) => notional >= bracket.notionalFloor && (bracket.notionalCap === null || notional <= bracket.notionalCap))
      .sort((a, b) => a.notionalFloor - b.notionalFloor)[0] ?? null
  );
}

function validateMaintenanceBracket(bracket: MaintenanceMarginBracket): string | null {
  if (!Number.isFinite(bracket.maintenanceMarginRatio) || bracket.maintenanceMarginRatio <= 0 || bracket.maintenanceMarginRatio >= 1) {
    return "Maintenance margin ratio is invalid";
  }
  if (!Number.isFinite(bracket.cumulativeMaintenanceAmount) || bracket.cumulativeMaintenanceAmount < 0) {
    return "Maintenance margin cumulative amount is invalid";
  }
  return null;
}

function sameMaintenanceBracket(left: MaintenanceMarginBracket, right: MaintenanceMarginBracket): boolean {
  return (
    left.bracket === right.bracket &&
    left.notionalFloor === right.notionalFloor &&
    left.notionalCap === right.notionalCap &&
    left.maintenanceMarginRatio === right.maintenanceMarginRatio &&
    left.cumulativeMaintenanceAmount === right.cumulativeMaintenanceAmount
  );
}

function calculateLiquidationPrice(direction: RiskInput["direction"], entry: number, quantity: number, initialMargin: number, bracket: MaintenanceMarginBracket): number | null {
  const cum = bracket.cumulativeMaintenanceAmount;
  const mmr = bracket.maintenanceMarginRatio;
  if (direction === "bullish") {
    const denominator = quantity * (1 - mmr);
    if (denominator <= 0) return null;
    return (quantity * entry - initialMargin - cum) / denominator;
  }
  const denominator = quantity * (1 + mmr);
  if (denominator <= 0) return null;
  return (initialMargin + quantity * entry + cum) / denominator;
}

function reject(code: RiskRejectCode, reason: string, decision: Omit<RiskDecision, "accepted" | "reason" | "rejectCode">): RiskDecision {
  return { accepted: false, reason, rejectCode: code, ...decision };
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
