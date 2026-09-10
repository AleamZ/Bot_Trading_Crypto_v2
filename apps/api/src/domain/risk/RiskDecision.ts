import type { Direction } from "../trade/Direction.js";
import type { FuturesSymbolRules } from "../symbol/SymbolRules.js";

export interface RiskInput {
  symbol: string;
  direction: Direction;
  availableBalance: number;
  symbolRules: FuturesSymbolRules;
  riskPerTradeUsdt: number;
  maxLeverage: number;
  maxMarginUsagePercent: number;
  maxTotalMarginUsagePercent?: number;
  currentUsedMargin?: number;
  marginMode: "CROSS" | "ISOLATED";
  liquidationSafetyBufferPercent: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  minimumRiskReward: number;
  openPositions: number;
  maxOpenPositions: number;
  symbolOpenPositions: number;
  maxPositionPerSymbol: number;
  availableAt: number;
  drawdownPercent: number;
  maxDrawdownPercent: number;
  tradingEnabled: boolean;
  killSwitch: boolean;
  createdAt: number;
}

export interface RiskDecision {
  accepted: boolean;
  reason: string;
  symbol: string;
  margin: number;
  leverage: number;
  requiredLeverage: number;
  leverageNeededForMargin: number;
  effectiveMaxLeverage: number;
  maxLeverage: number;
  selectedLeverage: number;
  requiredMargin: number;
  maxMarginUsagePercent: number;
  marginMode: "CROSS" | "ISOLATED";
  liquidationSafetyBufferPercent: number;
  positionSize: number;
  quantity: number;
  notional: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  estimatedLoss: number;
  estimatedProfit: number;
  actualRiskUsdt: number;
  targetRiskUsdt: number;
  riskPerTradeUsdt: number;
  availableBalance: number;
  maxAllowedMargin: number;
  marginUsagePercent: number;
  currentUsedMargin: number;
  candidateRequiredMargin: number;
  projectedTotalMargin: number;
  totalMarginUsagePercent: number;
  maxTotalMarginUsagePercent: number;
  maintenanceMarginRate: number | null;
  maintenanceMarginAmount: number | null;
  maintenanceMarginBracket: {
    bracket: number | null;
    notionalFloor: number;
    notionalCap: number | null;
    cumulativeMaintenanceAmount: number;
    initialLeverage: number | null;
  } | null;
  estimatedLiquidationPrice: number | null;
  distanceSlToLiquidation: number | null;
  liquidationSafetyStatus: "SAFE" | "BLOCKED" | "UNAVAILABLE";
  riskReward: number;
  rejectCode?: RiskRejectCode;
  createdAt: number;
}

export type RiskRejectCode =
  | "TRADING_DISABLED"
  | "KILL_SWITCH"
  | "INVALID_BALANCE"
  | "INVALID_RISK_PER_TRADE"
  | "INVALID_LEVERAGE"
  | "INVALID_PRICE"
  | "INVALID_QUANTITY"
  | "MIN_QTY"
  | "MAX_QTY"
  | "MARGIN_REQUIREMENT"
  | "MAX_MARGIN_USAGE_EXCEEDED"
  | "MAX_TOTAL_MARGIN_USAGE_EXCEEDED"
  | "MIN_NOTIONAL"
  | "REQUIRED_LEVERAGE_EXCEEDS_MAX"
  | "RR_BELOW_MINIMUM"
  | "MAX_OPEN_POSITIONS"
  | "POSITION_ALREADY_OPEN"
  | "MAX_DRAWDOWN_REACHED"
  | "MAINTENANCE_MARGIN_DATA_UNAVAILABLE"
  | "CROSS_MARGIN_LIQUIDATION_SAFETY_UNSUPPORTED"
  | "LIQUIDATION_BRACKET_UNRESOLVED"
  | "LIQUIDATION_SAFETY_UNAVAILABLE"
  | "LIQUIDATION_TOO_CLOSE_TO_STOP";
