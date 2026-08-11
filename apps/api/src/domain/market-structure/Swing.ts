import type { Candle, Timeframe } from "../market-data/Candle.js";

export type SwingKind = "high" | "low";

export interface SwingPoint {
  symbol: string;
  timeframe: Timeframe;
  kind: SwingKind;
  candleOpenTime: number;
  price: number;
}

export interface SwingConfig {
  left: number;
  right: number;
}

export function detectSwings(candles: readonly Candle[], config: SwingConfig): SwingPoint[] {
  if (config.left < 1 || config.right < 1) {
    throw new Error("Swing left/right must be at least 1");
  }

  const closed = candles.filter((candle) => candle.isClosed);
  const swings: SwingPoint[] = [];

  for (let i = config.left; i < closed.length - config.right; i += 1) {
    const current = closed[i];
    if (!current) continue;

    const left = closed.slice(i - config.left, i);
    const right = closed.slice(i + 1, i + 1 + config.right);

    if (left.every((candle) => candle.high < current.high) && right.every((candle) => candle.high < current.high)) {
      swings.push({
        symbol: current.symbol,
        timeframe: current.timeframe,
        kind: "high",
        candleOpenTime: current.openTime,
        price: current.high
      });
    }

    if (left.every((candle) => candle.low > current.low) && right.every((candle) => candle.low > current.low)) {
      swings.push({
        symbol: current.symbol,
        timeframe: current.timeframe,
        kind: "low",
        candleOpenTime: current.openTime,
        price: current.low
      });
    }
  }

  return swings;
}

export function latestSwing(swings: readonly SwingPoint[], kind: SwingKind): SwingPoint | null {
  return swings.filter((swing) => swing.kind === kind).at(-1) ?? null;
}
