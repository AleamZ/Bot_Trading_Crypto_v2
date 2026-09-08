import type { Timeframe } from "../market-data/Candle.js";

export type LiquidityType = "BSL" | "SSL";

export interface LiquidityLevel {
  id: string;
  type: LiquidityType;
  timeframe: Timeframe;
  price: number;
  candleIndex: number;
  createdAt: number;
  active?: boolean;
  invalidated?: boolean;
  swept: boolean;
  sweptBy?: number;
  parentId?: string;
  isPrimary: boolean;
  isInternal: boolean;
  children: string[];
}

export interface LiquiditySweep {
  id: string;
  type: LiquidityType;
  timeframe: Timeframe;
  price: number;
  candleIndex: number;
  createdAt: number;
  direction: "up" | "down";
  levelId: string;
}

export interface LiquidityChain {
  id: string;
  type: LiquidityType;
  timeframe: Timeframe;
  levelIds: string[];
}
