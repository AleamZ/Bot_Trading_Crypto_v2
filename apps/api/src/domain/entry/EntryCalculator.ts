import type { Fvg } from "../fvg/Fvg.js";
import type { Candle } from "../market-data/Candle.js";
import type { Direction } from "../trade/Direction.js";

export type StopLossBufferMode = "ticks" | "percentage" | "atr";

export interface EntryPlan {
  direction: Direction;
  entry: number;
  structuralStopBoundary: number;
  stopLossBuffer: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reason: string;
  triggeringFvgId?: string;
  protectiveClusterFvgIds?: string[];
}

export interface EntryCalculatorConfig {
  stopLossBufferMode: StopLossBufferMode;
  stopLossBufferTicks: number;
  stopLossBufferPercent: number;
  stopLossAtrPeriod: number;
  stopLossAtrMultiplier: number;
  symbolTickSize: number;
}

export function calculateEntryPlan(params: {
  direction: Direction;
  triggeringFvg: Fvg;
  protectiveCluster: readonly Fvg[];
  m5Candles: readonly Candle[];
  externalLiquidityPrice: number | null;
  config: EntryCalculatorConfig;
}): EntryPlan | null {
  if (params.triggeringFvg.timeframe !== "M5" || params.triggeringFvg.direction !== params.direction) return null;
  const cluster = params.protectiveCluster.filter((fvg) => fvg.timeframe === "M5" && fvg.direction === params.direction);
  if (!cluster.some((fvg) => fvg.id === params.triggeringFvg.id)) return null;
  if (cluster.length === 0) return null;

  const entry = calculateFirstTouchEntry(params.triggeringFvg);
  const structuralStopBoundary = calculateClusterStopBoundary(params.direction, cluster);
  const stopLossBuffer = calculateStopLossBuffer(structuralStopBoundary, params.m5Candles, params.config);
  const stopLoss = params.direction === "bullish" ? structuralStopBoundary - stopLossBuffer : structuralStopBoundary + stopLossBuffer;
  const riskDistance = Math.abs(entry - stopLoss);
  if (entry <= 0 || stopLoss <= 0 || riskDistance <= 0) return null;

  if (params.externalLiquidityPrice === null) return null;
  const takeProfit = params.externalLiquidityPrice;

  const rewardDistance = params.direction === "bullish" ? takeProfit - entry : entry - takeProfit;
  if (takeProfit <= 0 || rewardDistance <= 0) return null;

  return {
    direction: params.direction,
    entry,
    structuralStopBoundary,
    stopLossBuffer,
    stopLoss,
    takeProfit,
    riskReward: rewardDistance / riskDistance,
    triggeringFvgId: params.triggeringFvg.id,
    protectiveClusterFvgIds: cluster.map((fvg) => fvg.id),
    reason: "Entry from first touch of fresh M5 FVG; SL outside frozen active LTF FVG cluster; TP from HTF liquidity"
  };
}

export function calculateFirstTouchEntry(fvg: Fvg): number {
  return fvg.direction === "bullish" ? fvg.upper : fvg.lower;
}

export function calculateClusterStopBoundary(direction: Direction, cluster: readonly Fvg[]): number {
  if (cluster.length === 0) return 0;
  if (direction === "bullish") return Math.min(...cluster.map((fvg) => fvg.lower));
  return Math.max(...cluster.map((fvg) => fvg.upper));
}

function calculateStopLossBuffer(structuralStopBoundary: number, candles: readonly Candle[], config: EntryCalculatorConfig): number {
  if (config.stopLossBufferMode === "percentage") {
    return structuralStopBoundary * (config.stopLossBufferPercent / 100);
  }

  if (config.stopLossBufferMode === "atr") {
    return calculateAtr(candles, config.stopLossAtrPeriod) * config.stopLossAtrMultiplier;
  }

  return config.stopLossBufferTicks * config.symbolTickSize;
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
