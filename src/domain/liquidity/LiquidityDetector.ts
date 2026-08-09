import type { Candle, Timeframe } from "../market-data/Candle.js";
import type { SwingPoint } from "../market-structure/Swing.js";
import type { Direction } from "../trade/Direction.js";
import type { LiquidityLevel, LiquiditySweep, LiquidityType } from "./Liquidity.js";

export interface LiquidityState {
  levels: LiquidityLevel[];
  sweeps: LiquiditySweep[];
}

export class LiquidityManager {
  private readonly levels = new Map<string, LiquidityLevel>();
  private readonly queues = new Map<LiquidityType, string[]>();
  private readonly sweeps: LiquiditySweep[] = [];

  constructor(
    private readonly symbol: string,
    private readonly timeframe: Timeframe
  ) {
    this.queues.set("BSL", []);
    this.queues.set("SSL", []);
  }

  addLiquidity(input: Omit<LiquidityLevel, "swept" | "isPrimary" | "children">): LiquidityLevel {
    const existing = this.levels.get(input.id);
    if (existing) return existing;

    const queue = this.queues.get(input.type) ?? [];
    const parent = findChainParent(queue.map((id) => this.levels.get(id)).filter(isLiquidityLevel), input);
    const level: LiquidityLevel = {
      ...input,
      swept: false,
      isPrimary: false,
      children: []
    };
    if (parent) level.parentId = parent.id;

    this.levels.set(level.id, level);
    queue.push(level.id);
    this.queues.set(level.type, queue);

    if (parent) parent.children.push(level.id);
    this.promotePrimary(level.type);
    return level;
  }

  markSwept(type: LiquidityType, candleIndex: number, price: number, createdAt: number): LiquidityLevel[] {
    const swept: LiquidityLevel[] = [];
    const queue = this.queues.get(type) ?? [];

    for (const id of queue) {
      const level = this.levels.get(id);
      if (!level || level.swept || level.candleIndex >= candleIndex) continue;
      const hit = type === "BSL" ? price > level.price : price < level.price;
      if (!hit) continue;

      level.swept = true;
      level.sweptBy = candleIndex;
      level.isPrimary = false;
      swept.push(level);
      this.sweeps.push({
        id: `${this.symbol}:${this.timeframe}:sweep:${type}:${level.createdAt}:${createdAt}`,
        type,
        timeframe: this.timeframe,
        price: level.price,
        candleIndex,
        createdAt,
        direction: type === "BSL" ? "down" : "up",
        levelId: level.id
      });
    }

    if (swept.length > 0) this.promotePrimary(type);
    return swept;
  }

  promotePrimary(type: LiquidityType): LiquidityLevel | null {
    const queue = this.queues.get(type) ?? [];
    let primary: LiquidityLevel | null = null;

    for (const id of queue) {
      const level = this.levels.get(id);
      if (!level) continue;
      level.isPrimary = false;
      if (!primary && !level.swept && !level.isInternal) primary = level;
    }

    if (primary) primary.isPrimary = true;
    return primary;
  }

  render(): LiquidityState {
    return {
      levels: [...this.levels.values()].sort((a, b) => a.candleIndex - b.candleIndex),
      sweeps: [...this.sweeps].sort((a, b) => a.candleIndex - b.candleIndex)
    };
  }

  cleanup(): void {
    // Kept for future retention policies; swept liquidity intentionally remains visible.
  }
}

export function buildLiquidityState(
  symbol: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
  config: { left: number; right: number }
): LiquidityState {
  const manager = new LiquidityManager(symbol, timeframe);
  const swingsByIndex = new Map<number, { type: LiquidityType; price: number; candleIndex: number; createdAt: number }>();

  for (let index = config.left; index < candles.length - config.right; index += 1) {
    const swing = detectSwingAt(candles, index, config);
    if (swing) swingsByIndex.set(index, swing);
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const currentSwing = swingsByIndex.get(index);

    if (currentSwing?.type !== "BSL") manager.markSwept("BSL", index, candle.high, candle.openTime);
    if (currentSwing?.type !== "SSL") manager.markSwept("SSL", index, candle.low, candle.openTime);

    const swingIndex = index - config.right;
    const swing = swingsByIndex.get(swingIndex);
    if (!swing) continue;

    const sweptCandleIds = new Set(manager.render().sweeps.map((sweep) => sweep.candleIndex));
    if (sweptCandleIds.has(swingIndex)) continue;

    manager.addLiquidity({
      id: `${symbol}:${timeframe}:liq:${swing.type}:${swing.candleIndex}:${swing.createdAt}:${swing.price}`,
      type: swing.type,
      timeframe,
      price: swing.price,
      candleIndex: swing.candleIndex,
      createdAt: swing.createdAt,
      isInternal: isInternalLiquidity(swing, candles)
    });
  }

  manager.cleanup();
  return manager.render();
}

export function selectExternalLiquidityTarget(
  swings: readonly SwingPoint[],
  tradeDirection: Direction
): LiquidityLevel | null {
  const type: LiquidityType = tradeDirection === "bullish" ? "BSL" : "SSL";
  const queue = swings
    .filter((swing) => (type === "BSL" ? swing.kind === "high" : swing.kind === "low"))
    .map((swing, index): LiquidityLevel => ({
      id: `${swing.symbol}:${swing.timeframe}:liq:${type}:${swing.candleOpenTime}:${swing.price}`,
      type,
      timeframe: swing.timeframe,
      price: swing.price,
      candleIndex: index,
      createdAt: Math.floor(swing.candleOpenTime / 1000),
      swept: false,
      isPrimary: index === 0,
      isInternal: false,
      children: []
    }));

  return queue[0] ?? null;
}

function detectSwingAt(
  candles: readonly Candle[],
  index: number,
  config: { left: number; right: number }
): { type: LiquidityType; price: number; candleIndex: number; createdAt: number } | null {
  if (index < config.left || index >= candles.length - config.right) return null;
  const current = candles[index];
  if (!current) return null;

  const left = candles.slice(index - config.left, index);
  const right = candles.slice(index + 1, index + 1 + config.right);

  if (left.every((candle) => candle.high < current.high) && right.every((candle) => candle.high < current.high)) {
    return { type: "BSL", price: current.high, candleIndex: index, createdAt: current.openTime };
  }

  if (left.every((candle) => candle.low > current.low) && right.every((candle) => candle.low > current.low)) {
    return { type: "SSL", price: current.low, candleIndex: index, createdAt: current.openTime };
  }

  return null;
}

function findChainParent(levels: LiquidityLevel[], input: { type: LiquidityType; price: number }): LiquidityLevel | null {
  const candidates = levels.filter((level) => !level.swept && !level.isInternal);
  const previous = candidates.at(-1);
  if (!previous) return null;
  if (input.type === "BSL" && input.price > previous.price) return previous;
  if (input.type === "SSL" && input.price < previous.price) return previous;
  return null;
}

function isInternalLiquidity(
  swing: { type: LiquidityType; price: number; candleIndex: number },
  candles: readonly Candle[]
): boolean {
  const lookback = candles.slice(Math.max(0, swing.candleIndex - 24), swing.candleIndex);
  if (lookback.length < 6) return false;
  if (swing.type === "BSL") return swing.price < Math.max(...lookback.map((candle) => candle.high));
  return swing.price > Math.min(...lookback.map((candle) => candle.low));
}

function isLiquidityLevel(value: LiquidityLevel | undefined): value is LiquidityLevel {
  return value !== undefined;
}
