import { describe, expect, it } from "vitest";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { RiskInput } from "../src/domain/risk/RiskDecision.js";
import { defaultTradingSettings, validateTradingSettings } from "../src/application/config/AppConfig.js";
import { detectLatestHtfFvg, isFvgInvalidated, isFvgMitigated } from "../src/domain/fvg/FvgDetector.js";
import { calculateEntryPlan } from "../src/domain/entry/EntryCalculator.js";
import { detectM5StructureSignal } from "../src/domain/market-structure/StructureDetector.js";
import { evaluateRisk } from "../src/domain/risk/RiskManager.js";
import { transitionSetupState } from "../src/domain/setup/SetupStateMachine.js";
import { LiquidityManager, buildLiquidityState, selectExternalLiquidityTarget } from "../src/domain/liquidity/LiquidityDetector.js";

describe("FVG rules", () => {
  it("detects bullish H1 FVG from three closed candles", () => {
    const fvg = detectLatestHtfFvg(
      [
        candle("H1", 1, 100, 110, 90, 105),
        candle("H1", 2, 106, 130, 104, 125),
        candle("H1", 3, 126, 140, 112, 136)
      ],
      "bullish"
    );

    expect(fvg?.direction).toBe("bullish");
    expect(fvg?.lower).toBe(110);
    expect(fvg?.upper).toBe(112);
    expect(fvg?.midpoint).toBe(111);
  });

  it("detects bearish H1 FVG from three closed candles", () => {
    const fvg = detectLatestHtfFvg(
      [
        candle("H1", 1, 120, 130, 100, 105),
        candle("H1", 2, 104, 108, 80, 84),
        candle("H1", 3, 83, 98, 70, 72)
      ],
      "bearish"
    );

    expect(fvg?.direction).toBe("bearish");
    expect(fvg?.lower).toBe(98);
    expect(fvg?.upper).toBe(100);
  });

  it("activates at CE and invalidates only on close beyond opposite boundary", () => {
    const fvg = detectLatestHtfFvg(
      [
        candle("H1", 1, 100, 110, 90, 105),
        candle("H1", 2, 106, 130, 104, 125),
        candle("H1", 3, 126, 140, 112, 136)
      ],
      "bullish"
    );
    if (!fvg) throw new Error("Expected FVG");

    expect(isFvgMitigated(fvg, candle("H1", 4, 120, 125, 111, 122), "ce")).toBe(true);
    expect(isFvgInvalidated(fvg, candle("H1", 5, 112, 114, 100, 110))).toBe(false);
    expect(isFvgInvalidated(fvg, candle("H1", 6, 112, 114, 100, 109))).toBe(true);
  });
});

describe("M5 market structure", () => {
  it("requires body close beyond swing for BOS", () => {
    const candles = [
      candle("M5", 1, 100, 105, 99, 102),
      candle("M5", 2, 102, 110, 101, 108),
      candle("M5", 3, 107, 106, 100, 101),
      candle("M5", 4, 101, 103, 99, 100),
      candle("M5", 5, 100, 111, 98, 109)
    ];

    expect(detectM5StructureSignal(candles, "bullish", { left: 1, right: 1 })).toBeNull();

    const confirmed = [...candles.slice(0, -1), candle("M5", 5, 100, 111, 98, 110.5)];
    expect(detectM5StructureSignal(confirmed, "bullish", { left: 1, right: 1 })?.type).toBe("BOS");
  });
});

describe("risk and state", () => {
  it("builds entry from mitigated M5 FVG and places SL outside the FVG", () => {
    const plan = calculateEntryPlan({
      direction: "bullish",
      ltfFvg: {
        id: "BTCUSDT:M5:bullish:1:2:3",
        symbol: "BTCUSDT",
        timeframe: "M5",
        direction: "bullish",
        firstCandleOpenTime: 1,
        middleCandleOpenTime: 2,
        thirdCandleOpenTime: 3,
        lower: 100,
        upper: 110,
        midpoint: 105,
        status: "active",
        createdAt: 4
      },
      m5Candles: [candle("M5", 1, 100, 110, 95, 105), candle("M5", 2, 105, 115, 101, 112)],
      externalLiquidityPrice: null,
      config: {
        entryFvgMitigation: "ce",
        takeProfitMode: "fixed-rr",
        fixedRr: 2,
        stopLossBufferMode: "ticks",
        stopLossBufferTicks: 5,
        stopLossBufferPercent: 0.1,
        stopLossAtrPeriod: 14,
        stopLossAtrMultiplier: 1,
        priceTickSize: 0.1
      }
    });

    expect(plan?.entry).toBe(105);
    expect(plan?.stopLoss).toBe(99.5);
    expect(plan?.takeProfit).toBe(116);
  });

  it("does not turn external-liquidity TP into fixed RR when liquidity is missing", () => {
    const plan = calculateEntryPlan({
      direction: "bullish",
      ltfFvg: {
        id: "BTCUSDT:M5:bullish:1:2:3",
        symbol: "BTCUSDT",
        timeframe: "M5",
        direction: "bullish",
        firstCandleOpenTime: 1,
        middleCandleOpenTime: 2,
        thirdCandleOpenTime: 3,
        lower: 100,
        upper: 110,
        midpoint: 105,
        status: "active",
        createdAt: 4
      },
      m5Candles: [candle("M5", 1, 100, 110, 95, 105), candle("M5", 2, 105, 115, 101, 112)],
      externalLiquidityPrice: null,
      config: {
        entryFvgMitigation: "ce",
        takeProfitMode: "external-liquidity",
        fixedRr: 2,
        stopLossBufferMode: "ticks",
        stopLossBufferTicks: 5,
        stopLossBufferPercent: 0.1,
        stopLossAtrPeriod: 14,
        stopLossAtrMultiplier: 1,
        priceTickSize: 0.1
      }
    });

    expect(plan).toBeNull();
  });

  it("calculates quantity from fixed margin and leverage", () => {
    const decision = evaluateRisk(riskInput());

    expect(decision.accepted).toBe(true);
    expect(decision.positionSize).toBe(1000);
    expect(decision.quantity).toBe(10);
    expect(decision.estimatedLoss).toBe(50);
  });

  it("rejects entries below minimum RR but passes at the threshold", () => {
    expect(evaluateRisk(riskInput({ takeProfit: 107.5, minimumRiskReward: 2 }))).toMatchObject({
      accepted: false,
      rejectCode: "MIN_RR_NOT_MET"
    });
    expect(evaluateRisk(riskInput({ takeProfit: 110, minimumRiskReward: 2 }))).toMatchObject({
      accepted: true
    });
  });

  it("rejects risk protection blockers with explicit reason codes", () => {
    expect(evaluateRisk(riskInput({ openPositions: 1, maxOpenPositions: 1 }))).toMatchObject({ rejectCode: "MAX_OPEN_POSITIONS" });
    expect(evaluateRisk(riskInput({ symbolOpenPositions: 1, maxPositionPerSymbol: 1 }))).toMatchObject({ rejectCode: "POSITION_ALREADY_OPEN" });
    expect(evaluateRisk(riskInput({ tradesToday: 5, maxTradesPerDay: 5 }))).toMatchObject({ rejectCode: "MAX_TRADES_PER_DAY" });
    expect(evaluateRisk(riskInput({ dailyRealizedLoss: 31, availableBalance: 1000, dailyLossLimitPercent: 3 }))).toMatchObject({ rejectCode: "DAILY_LOSS_LIMIT" });
    expect(evaluateRisk(riskInput({ consecutiveLosses: 3, maxConsecutiveLosses: 3 }))).toMatchObject({ rejectCode: "MAX_CONSECUTIVE_LOSSES" });
    expect(evaluateRisk(riskInput({ lastClosedTradeAt: 10 * 60_000, availableAt: 20 * 60_000, cooldownAfterTradeMinutes: 30 }))).toMatchObject({ rejectCode: "COOLDOWN_ACTIVE" });
    expect(evaluateRisk(riskInput({ tradingEnabled: false }))).toMatchObject({ rejectCode: "TRADING_DISABLED" });
  });

  it("rejects invalid setup state jumps", () => {
    expect(() => transitionSetupState("WaitingTrend", "ReadyToEnter")).toThrow();
  });
});

describe("trading settings", () => {
  it("loads defaults and normalizes database watchlist settings", () => {
    const settings = validateTradingSettings({
      ...defaultTradingSettings,
      watchlist: ["btcusdt", "ETHUSDT", "btcusdt"]
    });

    expect(settings.watchlist).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(settings.minimumRiskReward).toBe(2);
  });

  it("rejects invalid trading settings", () => {
    expect(() => validateTradingSettings({ ...defaultTradingSettings, leverage: 200, maxLeverage: 125 })).toThrow();
    expect(() => validateTradingSettings({ ...defaultTradingSettings, tradingEnabled: true, watchlist: [] })).toThrow();
  });
});

describe("liquidity state", () => {
  it("keeps the first external liquidity as primary while newer levels build a chain", () => {
    const state = buildLiquidityState(
      "BTCUSDT",
      "H1",
      [
        candle("H1", 1, 1, 8, 1, 5),
        candle("H1", 2, 5, 10, 4, 8),
        candle("H1", 3, 8, 7, 3, 4),
        candle("H1", 4, 4, 12, 3, 9),
        candle("H1", 5, 9, 8, 4, 5),
        candle("H1", 6, 5, 14, 4, 10),
        candle("H1", 7, 10, 9, 5, 7)
      ],
      { left: 1, right: 1 }
    );

    const bsl = state.levels.filter((level) => level.type === "BSL");

    expect(bsl).toHaveLength(3);
    expect(bsl[0]?.isPrimary).toBe(true);
    expect(bsl[1]?.parentId).toBe(bsl[0]?.id);
    expect(bsl[2]?.parentId).toBe(bsl[1]?.id);
    expect(bsl.every((level) => !level.swept)).toBe(true);
  });

  it("keeps swept liquidity and promotes the next unswept level", () => {
    const manager = new LiquidityManager("BTCUSDT", "H1");
    const first = manager.addLiquidity({
      id: "first",
      type: "BSL",
      timeframe: "H1",
      price: 100,
      candleIndex: 1,
      createdAt: 1,
      isInternal: false
    });
    const second = manager.addLiquidity({
      id: "second",
      type: "BSL",
      timeframe: "H1",
      price: 110,
      candleIndex: 2,
      createdAt: 2,
      isInternal: false
    });

    manager.markSwept("BSL", 3, 105, 3);
    const levels = manager.render().levels;

    expect(levels.find((level) => level.id === first.id)?.swept).toBe(true);
    expect(levels.find((level) => level.id === first.id)?.isPrimary).toBe(false);
    expect(levels.find((level) => level.id === second.id)?.isPrimary).toBe(true);
    expect(manager.render().sweeps).toHaveLength(1);
  });

  it("selects the nearest external liquidity beyond the entry price", () => {
    const swings = [
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "high" as const, candleOpenTime: 1, price: 100 },
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "high" as const, candleOpenTime: 2, price: 130 },
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "high" as const, candleOpenTime: 3, price: 120 },
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "low" as const, candleOpenTime: 4, price: 90 },
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "low" as const, candleOpenTime: 5, price: 70 },
      { symbol: "BTCUSDT", timeframe: "H1" as const, kind: "low" as const, candleOpenTime: 6, price: 80 }
    ];

    expect(selectExternalLiquidityTarget(swings, "bullish", 110)?.price).toBe(120);
    expect(selectExternalLiquidityTarget(swings, "bearish", 85)?.price).toBe(80);
  });
});

function candle(timeframe: Candle["timeframe"], openTime: number, open: number, high: number, low: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    timeframe,
    openTime,
    closeTime: openTime + 1,
    open,
    high,
    low,
    close,
    volume: 1,
    isClosed: true
  };
}

function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    symbol: "BTCUSDT",
    direction: "bullish",
    availableBalance: 1000,
    marginPerTrade: 200,
    leverage: 5,
    maxLeverage: 125,
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    minimumRiskReward: 2,
    minNotional: 5,
    maxPositionSize: 100_000,
    openPositions: 0,
    maxOpenPositions: 1,
    symbolOpenPositions: 0,
    maxPositionPerSymbol: 1,
    tradesToday: 0,
    maxTradesPerDay: 5,
    dailyRealizedLoss: 0,
    dailyLossLimitPercent: 3,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 3,
    lastClosedTradeAt: null,
    cooldownAfterTradeMinutes: 30,
    availableAt: 60 * 60_000,
    drawdownPercent: 0,
    maxDrawdownPercent: 10,
    tradingEnabled: true,
    killSwitch: false,
    createdAt: 1,
    ...overrides
  };
}
