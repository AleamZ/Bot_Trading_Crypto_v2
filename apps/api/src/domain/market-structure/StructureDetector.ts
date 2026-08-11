import type { Candle } from "../market-data/Candle.js";
import type { Direction } from "../trade/Direction.js";
import type { MarketStructureSignal } from "./MarketStructureSignal.js";
import { detectSwings, latestSwing, type SwingConfig } from "./Swing.js";

export function detectM5StructureSignal(
  candles: readonly Candle[],
  currentTrend: Direction,
  config: SwingConfig
): MarketStructureSignal | null {
  const m5 = candles.filter((candle) => candle.timeframe === "M5" && candle.isClosed);
  const latest = m5.at(-1);
  if (!latest) {
    return null;
  }

  const prior = m5.slice(0, -1);
  const swings = detectSwings(prior, config);
  const swingHigh = latestSwing(swings, "high");
  const swingLow = latestSwing(swings, "low");

  if (currentTrend === "bullish") {
    if (swingHigh && latest.close > swingHigh.price) return signal("BOS", "bullish", latest, swingHigh);
    if (swingLow && latest.close < swingLow.price) return signal("CHOCH", "bearish", latest, swingLow);
  }

  if (currentTrend === "bearish") {
    if (swingLow && latest.close < swingLow.price) return signal("BOS", "bearish", latest, swingLow);
    if (swingHigh && latest.close > swingHigh.price) return signal("CHOCH", "bullish", latest, swingHigh);
  }

  return null;
}

function signal(
  type: "BOS" | "CHOCH",
  direction: Direction,
  candle: Candle,
  brokenSwing: MarketStructureSignal["brokenSwing"]
): MarketStructureSignal {
  return {
    id: `${candle.symbol}:M5:${type}:${direction}:${brokenSwing.candleOpenTime}:${candle.openTime}`,
    symbol: candle.symbol,
    timeframe: "M5",
    type,
    direction,
    brokenSwing,
    candleOpenTime: candle.openTime,
    close: candle.close
  };
}
