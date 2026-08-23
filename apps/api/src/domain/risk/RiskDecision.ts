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
  maxLeverage: number;
  selectedLeverage: number;
  requiredMargin: number;
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
  | "MIN_NOTIONAL"
  | "REQUIRED_LEVERAGE_EXCEEDS_MAX"
  | "RR_BELOW_MINIMUM"
  | "MAX_OPEN_POSITIONS"
  | "POSITION_ALREADY_OPEN"
  | "MAX_DRAWDOWN_REACHED";
