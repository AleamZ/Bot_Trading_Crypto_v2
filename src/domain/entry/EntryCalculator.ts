import type { Fvg, FvgMitigationMode } from "../fvg/Fvg.js";
import type { Candle } from "../market-data/Candle.js";
import type { Direction } from "../trade/Direction.js";

export type TakeProfitMode = "external-liquidity" | "fixed-rr";
export type StopLossBufferMode = "ticks" | "percentage" | "atr";

export interface EntryPlan {
  direction: Direction;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reason: string;
}

export interface EntryCalculatorConfig {
  entryFvgMitigation: FvgMitigationMode;
  takeProfitMode: TakeProfitMode;
  fixedRr: number;
  stopLossBufferMode: StopLossBufferMode;
  stopLossBufferTicks: number;
  stopLossBufferPercent: number;
  stopLossAtrPeriod: number;
  stopLossAtrMultiplier: number;
  priceTickSize: number;
}

export function calculateEntryPlan(params: {
  direction: Direction;
  ltfFvg: Fvg;
  m5Candles: readonly Candle[];
  externalLiquidityPrice: number | null;
  config: EntryCalculatorConfig;
}): EntryPlan | null {
  if (params.ltfFvg.timeframe !== "M5" || params.ltfFvg.direction !== params.direction) return null;

  const entry = calculateFvgEntry(params.ltfFvg, params.config.entryFvgMitigation);
  const stopLoss = calculateFvgStopLoss(params.direction, params.ltfFvg, params.m5Candles, params.config);
  const riskDistance = Math.abs(entry - stopLoss);
  if (entry <= 0 || stopLoss <= 0 || riskDistance <= 0) return null;

  let takeProfit: number;
  if (params.config.takeProfitMode === "external-liquidity") {
    if (params.externalLiquidityPrice === null) return null;
    takeProfit = params.externalLiquidityPrice;
  } else {
    takeProfit = params.direction === "bullish" ? entry + riskDistance * params.config.fixedRr : entry - riskDistance * params.config.fixedRr;
  }

  const rewardDistance = params.direction === "bullish" ? takeProfit - entry : entry - takeProfit;
  if (takeProfit <= 0 || rewardDistance <= 0) return null;

  return {
    direction: params.direction,
    entry,
    stopLoss,
    takeProfit,
    riskReward: rewardDistance / riskDistance,
    reason: `Entry from mitigated M5 FVG ${params.config.entryFvgMitigation}; SL outside M5 FVG; TP from ${params.config.takeProfitMode}`
  };
}

export function calculateFvgEntry(fvg: Fvg, mode: FvgMitigationMode): number {
  if (mode === "ce") return fvg.midpoint;
  if (fvg.direction === "bullish") return mode === "edge" ? fvg.upper : fvg.lower;
  return mode === "edge" ? fvg.lower : fvg.upper;
}

function calculateFvgStopLoss(direction: Direction, fvg: Fvg, candles: readonly Candle[], config: EntryCalculatorConfig): number {
  const buffer = calculateStopLossBuffer(fvg, candles, config);
  return direction === "bullish" ? fvg.lower - buffer : fvg.upper + buffer;
}

function calculateStopLossBuffer(fvg: Fvg, candles: readonly Candle[], config: EntryCalculatorConfig): number {
  if (config.stopLossBufferMode === "percentage") {
    return fvg.midpoint * (config.stopLossBufferPercent / 100);
  }

  if (config.stopLossBufferMode === "atr") {
    return calculateAtr(candles, config.stopLossAtrPeriod) * config.stopLossAtrMultiplier;
  }

  return config.stopLossBufferTicks * config.priceTickSize;
}

function calculateAtr(candles: readonly Candle[], period: number): number {
  const closed = candles.filter((candle) => candle.isClosed);
  if (closed.length < 2) return 0;

  const ranges: number[] = [];
  for (let index = Math.max(1, closed.length - period); index < closed.length; index += 1) {
    const current = closed[index];
    const previous = closed[index - 1];
    if (!current || !previous) continue;
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }

  if (ranges.length === 0) return 0;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}
