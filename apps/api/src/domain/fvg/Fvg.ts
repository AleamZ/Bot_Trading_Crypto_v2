import type { Direction } from "../trade/Direction.js";
import type { Timeframe } from "../market-data/Candle.js";

export type FvgStatus = "created" | "waiting-mitigation" | "active" | "invalidated" | "archived";
export type FvgMitigationMode = "edge" | "ce" | "full";

export interface Fvg {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  firstCandleOpenTime: number;
  middleCandleOpenTime: number;
  thirdCandleOpenTime: number;
  lower: number;
  upper: number;
  midpoint: number;
  status: FvgStatus;
  createdAt: number;
  activatedAt?: number;
  invalidatedAt?: number;
}
