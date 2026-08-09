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
  minNotional: number;
  maxPositionSize: number;
  openPositions: number;
  maxOpenPositions: number;
  dailyLossPercent: number;
  maxDailyLossPercent: number;
  drawdownPercent: number;
  maxDrawdownPercent: number;
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
  createdAt: number;
}
