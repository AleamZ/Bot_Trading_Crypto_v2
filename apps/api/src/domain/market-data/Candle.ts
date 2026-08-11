export type Timeframe = "M1" | "M5" | "M15" | "H1" | "H4" | "D1";

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export function assertClosedCandle(candle: Candle): void {
  if (!candle.isClosed) {
    throw new Error(`Candle ${candle.symbol} ${candle.timeframe} ${candle.openTime} is not closed`);
  }
}
