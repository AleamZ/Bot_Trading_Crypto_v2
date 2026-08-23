import type { Candle, Timeframe } from "../market-data/Candle.js";
import type { Direction } from "../trade/Direction.js";
import type { Fvg } from "./Fvg.js";

export function detectLatestHtfFvg(candles: readonly Candle[], expectedTrend: Direction): Fvg | null {
  return detectLatestFvg(candles, "H1", expectedTrend);
}

export function detectLatestLtfFvg(candles: readonly Candle[], expectedDirection: Direction, afterOpenTime: number): Fvg | null {
  const fvg = detectLatestFvg(candles, "M5", expectedDirection);
  if (!fvg || fvg.thirdCandleOpenTime <= afterOpenTime) return null;
  return fvg;
}

export function detectLatestFvg(candles: readonly Candle[], timeframe: Timeframe, expectedDirection: Direction): Fvg | null {
  const closed = candles.filter((candle) => candle.timeframe === timeframe && candle.isClosed);
  if (closed.length < 3) {
    return null;
  }

  const c1 = closed[closed.length - 3];
  const c2 = closed[closed.length - 2];
  const c3 = closed[closed.length - 1];
  if (!c1 || !c2 || !c3) {
    return null;
  }

  if (expectedDirection === "bullish" && c3.low > c1.high) {
    return createFvg(c1, c2, c3, "bullish", c1.high, c3.low);
  }

  if (expectedDirection === "bearish" && c3.high < c1.low) {
    return createFvg(c1, c2, c3, "bearish", c3.high, c1.low);
  }

  return null;
}

export function isFvgTouched(fvg: Fvg, candle: Candle): boolean {
  if (!candle.isClosed) {
    return false;
  }
  if (candle.openTime <= fvg.thirdCandleOpenTime) {
    return false;
  }

  if (fvg.direction === "bullish") {
    return candle.low <= fvg.upper;
  }

  return candle.high >= fvg.lower;
}

export function isFvgUntouchedByCandles(fvg: Fvg, candles: readonly Candle[]): boolean {
  return !candles.some((candle) => candle.symbol === fvg.symbol && candle.timeframe === fvg.timeframe && isFvgTouched(fvg, candle));
}

export function isFvgInvalidated(fvg: Fvg, candle: Candle): boolean {
  if (!candle.isClosed) {
    return false;
  }

  return fvg.direction === "bullish" ? candle.close < fvg.lower : candle.close > fvg.upper;
}

function createFvg(
  c1: Candle,
  c2: Candle,
  c3: Candle,
  direction: Direction,
  lower: number,
  upper: number
): Fvg {
  return {
    id: `${c3.symbol}:${c3.timeframe}:${direction}:${c1.openTime}:${c2.openTime}:${c3.openTime}`,
    symbol: c3.symbol,
    timeframe: c3.timeframe,
    direction,
    firstCandleOpenTime: c1.openTime,
    middleCandleOpenTime: c2.openTime,
    thirdCandleOpenTime: c3.openTime,
    lower,
    upper,
    midpoint: (lower + upper) / 2,
    status: "untouched",
    createdAt: c3.closeTime
  };
}
