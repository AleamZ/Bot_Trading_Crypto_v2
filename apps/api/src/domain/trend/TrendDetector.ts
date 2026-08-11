import type { Candle } from "../market-data/Candle.js";
import type { Direction } from "../trade/Direction.js";
import { ema } from "./Ema.js";

export interface TrendResult {
  direction: Direction | "neutral";
  ema: number;
  close: number;
  reason: string;
}

export function detectH1Trend(candles: readonly Candle[], period: number): TrendResult {
  const h1 = candles.filter((candle) => candle.timeframe === "H1" && candle.isClosed);
  if (h1.length < period) {
    return {
      direction: "neutral",
      ema: Number.NaN,
      close: Number.NaN,
      reason: `Need at least ${period} closed H1 candles for EMA trend filter`
    };
  }

  const closes = h1.map((candle) => candle.close);
  const emaValues = ema(closes, period);
  const latest = h1[h1.length - 1];
  const latestEma = emaValues[emaValues.length - 1];

  if (latest === undefined || latestEma === undefined) {
    throw new Error("Unexpected missing H1 candle or EMA value");
  }

  if (latest.close > latestEma) {
    return {
      direction: "bullish",
      ema: latestEma,
      close: latest.close,
      reason: `H1 close ${latest.close} is above EMA(${period}) ${latestEma}`
    };
  }

  if (latest.close < latestEma) {
    return {
      direction: "bearish",
      ema: latestEma,
      close: latest.close,
      reason: `H1 close ${latest.close} is below EMA(${period}) ${latestEma}`
    };
  }

  return {
    direction: "neutral",
    ema: latestEma,
    close: latest.close,
    reason: `H1 close equals EMA(${period})`
  };
}
