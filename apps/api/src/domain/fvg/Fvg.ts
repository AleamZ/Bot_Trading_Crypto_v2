import type { Direction } from "../trade/Direction.js";
import type { Timeframe } from "../market-data/Candle.js";

export type FvgStatus = "untouched" | "touched" | "invalidated" | "archived" | "created" | "waiting-mitigation" | "active";

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
  firstTouchedAt?: number;
  activatedAt?: number;
  invalidatedAt?: number;
}
