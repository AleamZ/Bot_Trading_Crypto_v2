import type { Direction } from "../trade/Direction.js";

export interface RiskInput {
  symbol: string;
  direction: Direction;
  availableBalance: number;
  marginPerTrade: number;
  leverage: number;
  maxLeverage: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  minimumRiskReward: number;
  minNotional: number;
  maxPositionSize: number;
  openPositions: number;
  maxOpenPositions: number;
  tradesToday: number;
  maxTradesPerDay: number;
  dailyRealizedLoss: number;
  dailyLossLimitPercent: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  lastClosedTradeAt: number | null;
  cooldownAfterTradeMinutes: number;
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
  margin: number;
  leverage: number;
  positionSize: number;
  quantity: number;
  notional: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  estimatedLoss: number;
  estimatedProfit: number;
  riskReward: number;
  rejectCode?: RiskRejectCode;
  createdAt: number;
}

export type RiskRejectCode =
  | "TRADING_DISABLED"
  | "KILL_SWITCH"
  | "INVALID_BALANCE"
  | "INVALID_MARGIN"
  | "INVALID_LEVERAGE"
  | "INVALID_PRICE"
  | "MARGIN_REQUIREMENT"
  | "MIN_NOTIONAL"
  | "MAX_POSITION_SIZE"
  | "MIN_RR_NOT_MET"
  | "MAX_OPEN_POSITIONS"
  | "MAX_TRADES_PER_DAY"
  | "DAILY_LOSS_LIMIT"
  | "MAX_CONSECUTIVE_LOSSES"
  | "COOLDOWN_ACTIVE"
  | "DRAWDOWN_LIMIT";
