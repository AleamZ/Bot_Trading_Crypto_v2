import type { Direction } from "../trade/Direction.js";
import type { SwingPoint } from "./Swing.js";

export type MarketStructureSignalType = "BOS" | "CHOCH";

export interface MarketStructureSignal {
  id: string;
  symbol: string;
  timeframe: "M5";
  type: MarketStructureSignalType;
  direction: Direction;
  brokenSwing: SwingPoint;
  candleOpenTime: number;
  close: number;
}
