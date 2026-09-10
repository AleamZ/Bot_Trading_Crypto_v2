import { describe, expect, it } from "vitest";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { RiskInput } from "../src/domain/risk/RiskDecision.js";
import type { Direction } from "../src/domain/trade/Direction.js";
import { defaultTradingSettings, validateTradingSettings } from "../src/application/config/AppConfig.js";
import type { ExecutionIntent } from "../src/application/execution/ExecutionIntent.js";
import { updateAccountProtectionState } from "../src/application/risk/AccountProtectionService.js";
import { calculateDailyRiskStatus } from "../src/application/risk/DailyRiskService.js";
import type { BinanceFuturesTradeHistoryStatus } from "../src/infrastructure/execution/BinanceFuturesAccountClient.js";
import { detectLatestHtfFvg, isFvgInvalidated, isFvgTouched } from "../src/domain/fvg/FvgDetector.js";
import { calculateEntryPlan } from "../src/domain/entry/EntryCalculator.js";
import { detectM5StructureSignal } from "../src/domain/market-structure/StructureDetector.js";
import { evaluateRisk } from "../src/domain/risk/RiskManager.js";
import { transitionSetupState } from "../src/domain/setup/SetupStateMachine.js";
import type { LiquidityLevel, LiquidityType } from "../src/domain/liquidity/Liquidity.js";
import { LiquidityManager, buildLiquidityState, selectExternalLiquidityTarget } from "../src/domain/liquidity/LiquidityDetector.js";
import { formatRuleNumber, normalizePrice, normalizeQuantity, validateAgainstSymbolRules, type FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";

describe("Binance symbol rules", () => {
  it("normalizes quantity down to step size", () => {
    expect(normalizeQuantity(0.00129, 0.001)).toBe(0.001);
  });

  it("keeps quantities already aligned to decimal step size", () => {
    expect(normalizeQuantity(555.55, 0.01)).toBe(555.55);
  });

  it("formats exchange rule numbers without stripping integer zeros", () => {
    expect(formatRuleNumber(100)).toBe("100");
    expect(formatRuleNumber(100.5)).toBe("100.5");
    expect(formatRuleNumber(0.1)).toBe("0.1");
  });

  it("normalizes price down to tick size", () => {
    expect(normalizePrice(43123.456, 0.1)).toBe(43123.4);
  });

  it("rejects quantity below minQty", () => {
    const result = validateAgainstSymbolRules(symbolRules(), {
      symbol: "BTCUSDT",
      orderType: "MARKET",
      quantity: 0.0009,
      notional: 100,
      leverage: 20
    });

    expect(result).toMatchObject({ ok: false, reason: "MIN_QTY" });
  });

  it("rejects minimum notional failure", () => {
    const result = validateAgainstSymbolRules(symbolRules(), {
      symbol: "BTCUSDT",
      orderType: "MARKET",
      quantity: 0.01,
      notional: 4,
      leverage: 20
    });

    expect(result).toMatchObject({ ok: false, reason: "MIN_NOTIONAL" });
  });

  it("rejects leverage above Binance max", () => {
    const result = validateAgainstSymbolRules(symbolRules(), {
      symbol: "BTCUSDT",
      orderType: "MARKET",
      quantity: 0.01,
      notional: 100,
      leverage: 126
    });

    expect(result).toMatchObject({ ok: false, reason: "MAX_LEVERAGE" });
  });
});

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

  it("marks fresh FVGs as untouched and touches only on subsequent nearest-boundary wick", () => {
    const bullish = detectLatestHtfFvg(
      [
        candle("H1", 1, 100, 110, 90, 105),
        candle("H1", 2, 106, 130, 104, 125),
        candle("H1", 3, 126, 140, 112, 136)
      ],
      "bullish"
    );
    const bearish = detectLatestHtfFvg(
      [
        candle("H1", 1, 120, 130, 100, 105),
        candle("H1", 2, 104, 108, 80, 84),
        candle("H1", 3, 83, 98, 70, 72)
      ],
      "bearish"
    );
    if (!bullish || !bearish) throw new Error("Expected FVGs");

    expect(bullish.status).toBe("untouched");
    expect(bearish.status).toBe("untouched");
    expect(isFvgTouched(bullish, candle("H1", 3, 126, 140, 112, 136))).toBe(false);
    expect(isFvgTouched(bullish, candle("H1", 4, 120, 125, 112, 122))).toBe(true);
    expect(isFvgTouched(bearish, candle("H1", 4, 80, 98, 78, 82))).toBe(true);
    expect(isFvgTouched(bullish, candle("H1", 5, 120, 125, 111, 122))).toBe(true);
    expect(isFvgInvalidated(bullish, candle("H1", 6, 112, 114, 100, 109))).toBe(true);
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
  it("builds entry from first-touched M5 FVG and places SL outside the frozen FVG cluster", () => {
    const triggeringFvg = testFvg("bullish", 100, 110);
    const plan = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg,
      protectiveCluster: [triggeringFvg, testFvg("bullish", 98, 104, "cluster-b")],
      m5Candles: [candle("M5", 1, 100, 110, 95, 105), candle("M5", 2, 105, 115, 101, 112)],
      externalLiquidityPrice: 130,
      config: {
        stopLossBufferMode: "ticks",
        stopLossBufferTicks: 5,
        stopLossBufferPercent: 0.1,
        stopLossAtrPeriod: 14,
        stopLossAtrMultiplier: 1,
        symbolTickSize: 0.1
      }
    });

    expect(plan?.entry).toBe(110);
    expect(plan?.structuralStopBoundary).toBe(98);
    expect(plan?.stopLoss).toBe(97.5);
    expect(plan?.takeProfit).toBe(130);
    expect(plan?.protectiveClusterFvgIds).toEqual([triggeringFvg.id, "cluster-b"]);
  });

  it("does not turn external-liquidity TP into fixed RR when liquidity is missing", () => {
    const fvg = testFvg("bullish", 100, 110);
    const plan = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: fvg,
      protectiveCluster: [fvg],
      m5Candles: [candle("M5", 1, 100, 110, 95, 105), candle("M5", 2, 105, 115, 101, 112)],
      externalLiquidityPrice: null,
      config: {
        stopLossBufferMode: "ticks",
        stopLossBufferTicks: 5,
        stopLossBufferPercent: 0.1,
        stopLossAtrPeriod: 14,
        stopLossAtrMultiplier: 1,
        symbolTickSize: 0.1
      }
    });

    expect(plan).toBeNull();
  });

  it("uses HTF BSL/SSL liquidity as TP and keeps SL outside the frozen cluster", () => {
    const longFvg = testFvg("bullish", 100, 110);
    const shortFvg = testFvg("bearish", 90, 100);
    const long = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: longFvg,
      protectiveCluster: [longFvg],
      m5Candles: [candle("M5", 1, 100, 110, 95, 105)],
      externalLiquidityPrice: 130,
      config: entryConfig()
    });
    const short = calculateEntryPlan({
      direction: "bearish",
      triggeringFvg: shortFvg,
      protectiveCluster: [shortFvg],
      m5Candles: [candle("M5", 1, 100, 105, 90, 95)],
      externalLiquidityPrice: 70,
      config: entryConfig()
    });

    expect(long?.takeProfit).toBe(130);
    expect(long?.entry).toBe(110);
    expect(long?.stopLoss).toBe(99.5);
    expect(short?.takeProfit).toBe(70);
    expect(short?.entry).toBe(90);
    expect(short?.stopLoss).toBe(100.5);
  });

  it("uses only the selected stop-loss buffer mode and honors symbol tick size", () => {
    const fvg = testFvg("bullish", 100, 110);
    const candles = [
      candle("M5", 1, 100, 112, 99, 105),
      candle("M5", 2, 105, 118, 104, 114),
      candle("M5", 3, 114, 116, 108, 109)
    ];

    const ticks = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: fvg,
      protectiveCluster: [fvg],
      m5Candles: candles,
      externalLiquidityPrice: 130,
      config: { ...entryConfig(), stopLossBufferMode: "ticks", stopLossBufferTicks: 4, stopLossBufferPercent: 9, stopLossAtrMultiplier: 99, symbolTickSize: 0.25 }
    });
    const percent = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: fvg,
      protectiveCluster: [fvg],
      m5Candles: candles,
      externalLiquidityPrice: 130,
      config: { ...entryConfig(), stopLossBufferMode: "percentage", stopLossBufferTicks: 999, stopLossBufferPercent: 2, stopLossAtrMultiplier: 99, symbolTickSize: 0.25 }
    });
    const atr = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: fvg,
      protectiveCluster: [fvg],
      m5Candles: candles,
      externalLiquidityPrice: 130,
      config: { ...entryConfig(), stopLossBufferMode: "atr", stopLossBufferTicks: 999, stopLossBufferPercent: 9, stopLossAtrPeriod: 2, stopLossAtrMultiplier: 0.5, symbolTickSize: 0.25 }
    });

    expect(ticks?.stopLoss).toBe(99);
    expect(percent?.stopLoss).toBe(98);
    expect(atr?.stopLoss).toBe(94.5);
  });

  it("uses the outermost frozen cluster boundary and keeps triggering FVG in the frozen cluster", () => {
    const trigger = testFvg("bearish", 90, 100, "trigger");
    const wider = testFvg("bearish", 92, 104, "wider");
    const ignoredOpposite = testFvg("bullish", 80, 85, "opposite");

    const plan = calculateEntryPlan({
      direction: "bearish",
      triggeringFvg: trigger,
      protectiveCluster: [trigger, wider, ignoredOpposite],
      m5Candles: [candle("M5", 1, 100, 105, 90, 95)],
      externalLiquidityPrice: 70,
      config: entryConfig()
    });

    expect(plan?.entry).toBe(90);
    expect(plan?.structuralStopBoundary).toBe(104);
    expect(plan?.stopLoss).toBe(104.5);
    expect(plan?.protectiveClusterFvgIds).toEqual(["trigger", "wider"]);
  });

  it("wide cluster can fail minimum RR and wider SL reduces quantity for the same 1R", () => {
    const tightFvg = testFvg("bullish", 100, 110, "tight");
    const wideFvg = testFvg("bullish", 90, 104, "wide");
    const tightPlan = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: tightFvg,
      protectiveCluster: [tightFvg],
      m5Candles: [candle("M5", 1, 100, 110, 95, 105)],
      externalLiquidityPrice: 130,
      config: entryConfig()
    });
    const widePlan = calculateEntryPlan({
      direction: "bullish",
      triggeringFvg: tightFvg,
      protectiveCluster: [tightFvg, wideFvg],
      m5Candles: [candle("M5", 1, 100, 110, 95, 105)],
      externalLiquidityPrice: 130,
      config: entryConfig()
    });
    if (!tightPlan || !widePlan) throw new Error("Expected plans");

    const tightRisk = evaluateRisk(riskInput({ entry: tightPlan.entry, stopLoss: tightPlan.stopLoss, takeProfit: tightPlan.takeProfit, minimumRiskReward: 1 }));
    const wideRisk = evaluateRisk(riskInput({ entry: widePlan.entry, stopLoss: widePlan.stopLoss, takeProfit: widePlan.takeProfit, minimumRiskReward: 2 }));

    expect(widePlan.riskReward).toBeLessThan(tightPlan.riskReward);
    expect(wideRisk).toMatchObject({ accepted: false, rejectCode: "RR_BELOW_MINIMUM" });
    expect(evaluateRisk(riskInput({ entry: widePlan.entry, stopLoss: widePlan.stopLoss, takeProfit: widePlan.takeProfit, minimumRiskReward: 1 })).quantity).toBeLessThan(tightRisk.quantity);
  });

  it("max open positions counts simultaneous account positions, not closed historical trades", () => {
    expect(evaluateRisk(riskInput({ openPositions: 2, maxOpenPositions: 3, symbolOpenPositions: 0 }))).toMatchObject({ accepted: true });
    expect(evaluateRisk(riskInput({ openPositions: 3, maxOpenPositions: 3, symbolOpenPositions: 0 }))).toMatchObject({ rejectCode: "MAX_OPEN_POSITIONS" });
  });

  it("enforces the account portfolio margin cap independently from per-trade margin", () => {
    const under = evaluateRisk(riskInput({ riskPerTradeUsdt: 0.5, maxTotalMarginUsagePercent: 60, currentUsedMargin: 500, maxMarginUsagePercent: 100 }));
    const atBoundary = evaluateRisk(riskInput({ riskPerTradeUsdt: 0.5, maxTotalMarginUsagePercent: 60, currentUsedMargin: 590, maxMarginUsagePercent: 100 }));
    const over = evaluateRisk(riskInput({ riskPerTradeUsdt: 0.5, maxTotalMarginUsagePercent: 60, currentUsedMargin: 600, maxMarginUsagePercent: 100 }));

    expect(under).toMatchObject({ accepted: true, currentUsedMargin: 500, candidateRequiredMargin: 10, projectedTotalMargin: 510 });
    expect(atBoundary).toMatchObject({ accepted: true, totalMarginUsagePercent: 60 });
    expect(over).toMatchObject({ accepted: false, rejectCode: "MAX_TOTAL_MARGIN_USAGE_EXCEEDED" });
  });

  it("risk per trade changes quantity without moving entry, SL or HTF TP", () => {
    const base = riskInput({ riskPerTradeUsdt: 50 });
    const larger = riskInput({ riskPerTradeUsdt: 100 });

    const baseDecision = evaluateRisk(base);
    const largerDecision = evaluateRisk(larger);

    expect(largerDecision.quantity).toBe(baseDecision.quantity * 2);
    expect(largerDecision.entry).toBe(baseDecision.entry);
    expect(largerDecision.stopLoss).toBe(baseDecision.stopLoss);
    expect(largerDecision.takeProfit).toBe(baseDecision.takeProfit);
  });

  it("legacy maxPositionSize does not block normal risk-based sizing", () => {
    expect(evaluateRisk(riskInput({ maxPositionSize: 1 } as Partial<RiskInput>)).accepted).toBe(true);
  });

  it("calculates quantity from risk per trade and stop distance", () => {
    const decision = evaluateRisk(riskInput());

    expect(decision.accepted).toBe(true);
    expect(decision.positionSize).toBe(1000);
    expect(decision.quantity).toBe(10);
    expect(decision.actualRiskUsdt).toBe(50);
    expect(decision.estimatedLoss).toBe(50);
  });

  it("selects the minimum leverage needed to keep LINKUSDT inside max margin usage", () => {
    const decision = evaluateRisk(
      riskInput({
        symbol: "LINKUSDT",
        direction: "bearish",
        availableBalance: 5893.7684269,
        symbolRules: linkSymbolRules(),
        riskPerTradeUsdt: 5,
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        entry: 11.563,
        stopLoss: 11.572,
        takeProfit: 11.524,
        minimumRiskReward: 1
      })
    );

    expect(decision.accepted).toBe(true);
    expect(decision.quantity).toBeCloseTo(555.55, 8);
    expect(decision.notional).toBeCloseTo(6423.82465, 8);
    expect(decision.actualRiskUsdt).toBeCloseTo(4.99995, 8);
    expect(decision.maxAllowedMargin).toBeCloseTo(1178.75368538, 8);
    expect(decision.requiredLeverage).toBeCloseTo(5.449675135, 8);
    expect(decision.leverageNeededForMargin).toBe(6);
    expect(decision.effectiveMaxLeverage).toBe(75);
    expect(decision.selectedLeverage).toBe(6);
    expect(decision.requiredMargin).toBeCloseTo(1070.6374417, 7);
    expect(decision.marginUsagePercent).toBeCloseTo(18.16558378, 7);
    expect(decision.maintenanceMarginBracket?.bracket).toBe(1);
    expect(decision.maintenanceMarginRate).toBe(0.0065);
    expect(decision.maintenanceMarginAmount).toBeCloseTo(41.754860225, 9);
    expect(decision.estimatedLiquidationPrice).toBeCloseTo(13.403046862063256, 12);
    expect(decision.liquidationSafetyStatus).toBe("SAFE");
  });

  it("fails CROSS margin liquidation safety closed while preserving LINKUSDT sizing", () => {
    const isolated = evaluateRisk(
      riskInput({
        symbol: "LINKUSDT",
        direction: "bearish",
        availableBalance: 5893.7684269,
        symbolRules: linkSymbolRules(),
        riskPerTradeUsdt: 5,
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        marginMode: "ISOLATED",
        entry: 11.563,
        stopLoss: 11.572,
        takeProfit: 11.524,
        minimumRiskReward: 1
      })
    );
    const cross = evaluateRisk(
      riskInput({
        symbol: "LINKUSDT",
        direction: "bearish",
        availableBalance: 5893.7684269,
        symbolRules: linkSymbolRules(),
        riskPerTradeUsdt: 5,
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        marginMode: "CROSS",
        entry: 11.563,
        stopLoss: 11.572,
        takeProfit: 11.524,
        minimumRiskReward: 1
      })
    );

    expect(isolated).toMatchObject({ accepted: true, selectedLeverage: 6, liquidationSafetyStatus: "SAFE" });
    expect(cross).toMatchObject({
      accepted: false,
      rejectCode: "CROSS_MARGIN_LIQUIDATION_SAFETY_UNSUPPORTED",
      liquidationSafetyStatus: "UNAVAILABLE",
      selectedLeverage: 6
    });
    expect(cross.quantity).toBe(isolated.quantity);
    expect(cross.actualRiskUsdt).toBeCloseTo(isolated.actualRiskUsdt, 8);
    expect(cross.entry).toBe(isolated.entry);
    expect(cross.stopLoss).toBe(isolated.stopLoss);
    expect(cross.takeProfit).toBe(isolated.takeProfit);
  });

  it("keeps quantity and 1R risk invariant when margin cap changes only selected leverage", () => {
    const looseMargin = evaluateRisk(
      riskInput({
        riskPerTradeUsdt: 5,
        availableBalance: 5893.7684269,
        symbolRules: { ...symbolRules(), stepSize: 0.01, minQty: 0.01, maxQty: null, maxLeverage: 75 },
        maxLeverage: 125,
        maxMarginUsagePercent: 100,
        entry: 11.563,
        stopLoss: 11.572,
        takeProfit: 11.524,
        minimumRiskReward: 1
      })
    );
    const tightMargin = evaluateRisk(
      riskInput({
        riskPerTradeUsdt: 5,
        availableBalance: 5893.7684269,
        symbolRules: { ...symbolRules(), stepSize: 0.01, minQty: 0.01, maxQty: null, maxLeverage: 75 },
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        entry: 11.563,
        stopLoss: 11.572,
        takeProfit: 11.524,
        minimumRiskReward: 1
      })
    );

    expect(looseMargin.selectedLeverage).toBe(2);
    expect(tightMargin.selectedLeverage).toBe(6);
    expect(tightMargin.quantity).toBe(looseMargin.quantity);
    expect(tightMargin.entry).toBe(looseMargin.entry);
    expect(tightMargin.stopLoss).toBe(looseMargin.stopLoss);
    expect(tightMargin.takeProfit).toBe(looseMargin.takeProfit);
    expect(tightMargin.actualRiskUsdt).toBeCloseTo(looseMargin.actualRiskUsdt, 8);
  });

  it("passes exactly at the max-margin boundary and selects the next leverage when slightly over", () => {
    const atBoundary = evaluateRisk(
      riskInput({
        riskPerTradeUsdt: 10,
        availableBalance: 1000,
        maxMarginUsagePercent: 20,
        entry: 100,
        stopLoss: 99,
        takeProfit: 103,
        minimumRiskReward: 1
      })
    );
    const slightlyOverBoundary = evaluateRisk(
      riskInput({
        riskPerTradeUsdt: 10.001,
        availableBalance: 1000,
        maxMarginUsagePercent: 20,
        entry: 100,
        stopLoss: 99,
        takeProfit: 103,
        minimumRiskReward: 1
      })
    );

    expect(atBoundary.accepted).toBe(true);
    expect(atBoundary.selectedLeverage).toBe(5);
    expect(atBoundary.requiredMargin).toBe(200);
    expect(atBoundary.marginUsagePercent).toBe(20);
    expect(slightlyOverBoundary.accepted).toBe(true);
    expect(slightlyOverBoundary.selectedLeverage).toBe(6);
    expect(slightlyOverBoundary.marginUsagePercent).toBeLessThan(20);
  });

  it("rejects risk decisions that require leverage above the symbol effective maximum", () => {
    const bnbRules = { ...symbolRules(), symbol: "BNBUSDT", maxQty: null, maxLeverage: 75 };

    const rejected = evaluateRisk(
      riskInput({
        symbol: "BNBUSDT",
        symbolRules: bnbRules,
        riskPerTradeUsdt: 100,
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        availableBalance: 500,
        entry: 100,
        stopLoss: 99,
        takeProfit: 103
      })
    );
    const accepted = evaluateRisk(
      riskInput({
        symbol: "BNBUSDT",
        symbolRules: bnbRules,
        riskPerTradeUsdt: 100,
        maxLeverage: 125,
        maxMarginUsagePercent: 20,
        availableBalance: 1333.34,
        entry: 100,
        stopLoss: 99.5,
        takeProfit: 103,
        minimumRiskReward: 1,
        liquidationSafetyBufferPercent: 0.1
      })
    );

    expect(rejected).toMatchObject({ accepted: false, rejectCode: "REQUIRED_LEVERAGE_EXCEEDS_MAX", selectedLeverage: 100, effectiveMaxLeverage: 75 });
    expect(accepted).toMatchObject({ accepted: true, selectedLeverage: 75 });
  });

  it("uses configured max leverage as the effective cap when it is below the symbol cap", () => {
    const decision = evaluateRisk(
      riskInput({
        riskPerTradeUsdt: 100,
        availableBalance: 500,
        maxLeverage: 50,
        maxMarginUsagePercent: 20,
        entry: 100,
        stopLoss: 99,
        takeProfit: 103
      })
    );

    expect(decision).toMatchObject({
      accepted: false,
      rejectCode: "REQUIRED_LEVERAGE_EXCEEDS_MAX",
      selectedLeverage: 100,
      effectiveMaxLeverage: 50
    });
  });

  it("keeps step-size normalization and min/max/notional filters enforced after leverage selection", () => {
    expect(evaluateRisk(riskInput({ riskPerTradeUsdt: 0.000001, stopLoss: 99.99 })).rejectCode).toBe("INVALID_QUANTITY");
    expect(evaluateRisk(riskInput({ symbolRules: { ...symbolRules(), minQty: 11 } })).rejectCode).toBe("MIN_QTY");
    expect(evaluateRisk(riskInput({ symbolRules: { ...symbolRules(), maxQty: 9 } })).rejectCode).toBe("MAX_QTY");
    expect(evaluateRisk(riskInput({ riskPerTradeUsdt: 0.01, stopLoss: 99, symbolRules: { ...symbolRules(), minNotional: 5 } })).rejectCode).toBe("MIN_NOTIONAL");
  });

  it("rejects invalid balance and zero max-margin usage safely", () => {
    expect(evaluateRisk(riskInput({ availableBalance: 0 }))).toMatchObject({ accepted: false, rejectCode: "INVALID_BALANCE" });
    expect(evaluateRisk(riskInput({ maxMarginUsagePercent: 0 }))).toMatchObject({ accepted: false, rejectCode: "MAX_MARGIN_USAGE_EXCEEDED" });
  });

  it("selects the correct maintenance bracket for small and threshold-crossing notionals", () => {
    const small = evaluateRisk(riskInput({ riskPerTradeUsdt: 10, entry: 100, stopLoss: 99, takeProfit: 103, minimumRiskReward: 1 }));
    const larger = evaluateRisk(riskInput({ riskPerTradeUsdt: 60, entry: 100, stopLoss: 99, takeProfit: 103, minimumRiskReward: 1 }));

    expect(small.maintenanceMarginBracket?.bracket).toBe(1);
    expect(larger.maintenanceMarginBracket?.bracket).toBe(2);
    expect(larger.maintenanceMarginRate).toBe(0.005);
  });

  it("converges maintenance bracket when liquidation notional crosses from bracket A to B", () => {
    const decision = evaluateRisk(
      riskInput({
        direction: "bearish",
        availableBalance: 1000,
        riskPerTradeUsdt: 50,
        maxMarginUsagePercent: 100,
        entry: 100,
        stopLoss: 105,
        takeProfit: 90,
        symbolRules: {
          ...symbolRules(),
          maintenanceMarginBrackets: [
            { bracket: 1, notionalFloor: 0, notionalCap: 1500, maintenanceMarginRatio: 0.004, cumulativeMaintenanceAmount: 0, initialLeverage: 125 },
            { bracket: 2, notionalFloor: 1500, notionalCap: null, maintenanceMarginRatio: 0.02, cumulativeMaintenanceAmount: 10, initialLeverage: 50 }
          ]
        }
      })
    );

    expect(decision.accepted).toBe(true);
    expect(decision.notional).toBe(1000);
    expect(decision.maintenanceMarginBracket?.bracket).toBe(2);
    expect(decision.maintenanceMarginRate).toBe(0.02);
    expect(decision.maintenanceMarginBracket?.cumulativeMaintenanceAmount).toBe(10);
    expect(decision.maintenanceMarginAmount).toBe(10);
    expect(decision.estimatedLiquidationPrice).toBeCloseTo(197.05882352941177, 8);
    expect(decision.distanceSlToLiquidation).toBeCloseTo(92.05882352941177, 8);
  });

  it("fails closed when liquidation bracket iteration cannot converge", () => {
    const decision = evaluateRisk(
      riskInput({
        direction: "bearish",
        availableBalance: 1000,
        riskPerTradeUsdt: 50,
        maxMarginUsagePercent: 100,
        entry: 100,
        stopLoss: 105,
        takeProfit: 90,
        symbolRules: {
          ...symbolRules(),
          maintenanceMarginBrackets: [
            { bracket: 1, notionalFloor: 0, notionalCap: 1500, maintenanceMarginRatio: 0.004, cumulativeMaintenanceAmount: 0, initialLeverage: 125 },
            { bracket: 2, notionalFloor: 1500, notionalCap: null, maintenanceMarginRatio: 0.9, cumulativeMaintenanceAmount: 0, initialLeverage: 2 }
          ]
        }
      })
    );

    expect(decision).toMatchObject({
      accepted: false,
      rejectCode: "LIQUIDATION_BRACKET_UNRESOLVED",
      liquidationSafetyStatus: "UNAVAILABLE"
    });
  });

  it("rejects safely when maintenance bracket data is unavailable", () => {
    expect(evaluateRisk(riskInput({ symbolRules: { ...symbolRules(), maintenanceMarginBrackets: [] } }))).toMatchObject({
      accepted: false,
      rejectCode: "MAINTENANCE_MARGIN_DATA_UNAVAILABLE",
      liquidationSafetyStatus: "UNAVAILABLE"
    });
  });

  it("accepts long liquidation safely below SL and rejects when too close", () => {
    const safe = evaluateRisk(riskInput({ direction: "bullish", entry: 100, stopLoss: 95, takeProfit: 110, maxMarginUsagePercent: 100 }));
    const blocked = evaluateRisk(riskInput({ direction: "bullish", availableBalance: 100, entry: 100, stopLoss: 82, takeProfit: 140, maxMarginUsagePercent: 20, minimumRiskReward: 0.1 }));

    expect(safe).toMatchObject({ accepted: true, liquidationSafetyStatus: "SAFE" });
    expect(safe.estimatedLiquidationPrice).toBeLessThan(safe.stopLoss);
    expect(blocked).toMatchObject({ accepted: false, rejectCode: "LIQUIDATION_TOO_CLOSE_TO_STOP", liquidationSafetyStatus: "BLOCKED" });
  });

  it("accepts short liquidation safely above SL and rejects when too close", () => {
    const safe = evaluateRisk(riskInput({ direction: "bearish", entry: 100, stopLoss: 105, takeProfit: 90, maxMarginUsagePercent: 100 }));
    const blocked = evaluateRisk(riskInput({ direction: "bearish", entry: 100, stopLoss: 199, takeProfit: 50, maxMarginUsagePercent: 100, minimumRiskReward: 0.1 }));

    expect(safe).toMatchObject({ accepted: true, liquidationSafetyStatus: "SAFE" });
    expect(safe.estimatedLiquidationPrice).toBeGreaterThan(safe.stopLoss);
    expect(blocked).toMatchObject({ accepted: false, rejectCode: "LIQUIDATION_TOO_CLOSE_TO_STOP", liquidationSafetyStatus: "BLOCKED" });
  });

  it("enforces liquidation safety buffer boundary", () => {
    const base = evaluateRisk(riskInput({ direction: "bullish", entry: 100, stopLoss: 95, takeProfit: 110, maxMarginUsagePercent: 100, liquidationSafetyBufferPercent: 0 }));
    const strict = evaluateRisk(riskInput({ direction: "bullish", entry: 100, stopLoss: 95, takeProfit: 110, maxMarginUsagePercent: 100, liquidationSafetyBufferPercent: 99 }));

    expect(base.accepted).toBe(true);
    expect(strict).toMatchObject({ accepted: false, rejectCode: "LIQUIDATION_TOO_CLOSE_TO_STOP" });
  });

  it("rejects entries below minimum RR but passes at the threshold", () => {
    expect(evaluateRisk(riskInput({ takeProfit: 107.5, minimumRiskReward: 2 }))).toMatchObject({
      accepted: false,
      rejectCode: "RR_BELOW_MINIMUM"
    });
    expect(evaluateRisk(riskInput({ takeProfit: 110, minimumRiskReward: 2 }))).toMatchObject({
      accepted: true
    });
  });

  it("rejects risk protection blockers with explicit reason codes", () => {
    expect(evaluateRisk(riskInput({ openPositions: 1, maxOpenPositions: 1 }))).toMatchObject({ rejectCode: "MAX_OPEN_POSITIONS" });
    expect(evaluateRisk(riskInput({ symbolOpenPositions: 1, maxPositionPerSymbol: 1 }))).toMatchObject({ rejectCode: "POSITION_ALREADY_OPEN" });
    expect(evaluateRisk(riskInput({ drawdownPercent: 11, maxDrawdownPercent: 10 }))).toMatchObject({ rejectCode: "MAX_DRAWDOWN_REACHED" });
    expect(evaluateRisk(riskInput({ tradingEnabled: false }))).toMatchObject({ rejectCode: "TRADING_DISABLED" });
  });

  it("rejects invalid setup state jumps", () => {
    expect(() => transitionSetupState("WaitingTrend", "ReadyToEnter")).toThrow();
  });
});

describe("daily realized R protection", () => {
  it("sums bot-owned realized PnL into R using each intent risk basis", () => {
    const status = calculateDailyRiskStatus({
      tradingAccountId: "account-1",
      settings: { dailyProfitLimitR: 10, dailyLossLimitR: 10 },
      intents: [
        intent({ id: "win", binanceStopOrderId: "sl-win", binanceTakeProfitOrderId: "tp-win", requestedEntry: 100, requestedStopLoss: 95, quantity: 10 }),
        intent({ id: "loss", binanceStopOrderId: "sl-loss", binanceTakeProfitOrderId: "tp-loss", requestedEntry: 200, requestedStopLoss: 190, quantity: 5 })
      ],
      trades: [
        trade({ id: "trade-win", orderId: "tp-win", realizedPnl: 50 }),
        trade({ id: "trade-loss", orderId: "sl-loss", realizedPnl: -25 })
      ],
      now: new Date("2026-08-22T12:00:00.000Z")
    });

    expect(status.tradingDay).toBe("2026-08-22");
    expect(status.timezone).toBe("UTC");
    expect(status.realizedPnlUsdt).toBe(25);
    expect(status.realizedR).toBe(0.5);
    expect(status.newEntriesAllowed).toBe(true);
  });

  it("blocks new entries only after the daily profit or loss R limit is reached", () => {
    const win = calculateDailyRiskStatus({
      tradingAccountId: "account-1",
      settings: { dailyProfitLimitR: 2, dailyLossLimitR: 2 },
      intents: [intent({ id: "win", binanceTakeProfitOrderId: "tp-win", requestedEntry: 100, requestedStopLoss: 95, quantity: 10 })],
      trades: [trade({ id: "trade-win", orderId: "tp-win", realizedPnl: 100 })],
      now: new Date("2026-08-22T12:00:00.000Z")
    });
    const loss = calculateDailyRiskStatus({
      tradingAccountId: "account-1",
      settings: { dailyProfitLimitR: 2, dailyLossLimitR: 2 },
      intents: [intent({ id: "loss", binanceStopOrderId: "sl-loss", requestedEntry: 100, requestedStopLoss: 95, quantity: 10 })],
      trades: [trade({ id: "trade-loss", orderId: "sl-loss", realizedPnl: -100 })],
      now: new Date("2026-08-22T12:00:00.000Z")
    });

    expect(win).toMatchObject({ realizedR: 2, newEntriesAllowed: false, blockReason: "DAILY_PROFIT_LIMIT_REACHED" });
    expect(loss).toMatchObject({ realizedR: -2, newEntriesAllowed: false, blockReason: "DAILY_LOSS_LIMIT_REACHED" });
  });

  it("ignores unrealized, manual, external-account, and previous-day activity", () => {
    const status = calculateDailyRiskStatus({
      tradingAccountId: "account-1",
      settings: { dailyProfitLimitR: 1, dailyLossLimitR: 1 },
      intents: [
        intent({ id: "bot-today", binanceStopOrderId: "sl-today" }),
        intent({ id: "manual", binanceStopOrderId: "sl-manual", source: "EXTERNAL" }),
        intent({ id: "other-account", binanceStopOrderId: "sl-other", tradingAccountId: "account-2" })
      ],
      trades: [
        trade({ id: "manual-trade", orderId: "sl-manual", realizedPnl: -500 }),
        trade({ id: "other-trade", orderId: "sl-other", realizedPnl: -500, tradingAccountId: "account-2" }),
        trade({ id: "old-trade", orderId: "sl-today", realizedPnl: -500, createdAt: Math.floor(Date.parse("2026-08-21T23:59:59.000Z") / 1000) })
      ],
      now: new Date("2026-08-22T12:00:00.000Z")
    });

    expect(status).toMatchObject({ realizedPnlUsdt: 0, realizedR: 0, newEntriesAllowed: true, blockReason: null });
  });
});

describe("account drawdown protection", () => {
  it("creates an account-scoped baseline and updates peak equity", () => {
    const first = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 10_000,
      maxDrawdownPercent: 10,
      state: null,
      now: new Date("2026-08-22T00:00:00.000Z")
    });
    const second = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 12_000,
      maxDrawdownPercent: 10,
      state: first.state,
      now: new Date("2026-08-22T01:00:00.000Z")
    });

    expect(first.status).toMatchObject({ baselineEquityUsdt: 10_000, peakEquityUsdt: 10_000, drawdownPercent: 0, newEntriesAllowed: true });
    expect(second.status).toMatchObject({ baselineEquityUsdt: 10_000, peakEquityUsdt: 12_000, drawdownPercent: 0, newEntriesAllowed: true });
    expect(second.changed).toBe(true);
  });

  it("blocks new entries at threshold and preserves the locked state after restart", () => {
    const peak = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 10_000,
      maxDrawdownPercent: 10,
      state: null,
      now: new Date("2026-08-22T00:00:00.000Z")
    });
    const blocked = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 8_900,
      maxDrawdownPercent: 10,
      state: peak.state,
      now: new Date("2026-08-22T01:00:00.000Z")
    });
    const afterRestart = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 10_500,
      maxDrawdownPercent: 10,
      state: blocked.state,
      now: new Date("2026-08-22T02:00:00.000Z")
    });

    expect(blocked.status).toMatchObject({ newEntriesAllowed: false, blockReason: "MAX_DRAWDOWN_REACHED" });
    expect(blocked.status.drawdownPercent).toBe(11);
    expect(afterRestart.status).toMatchObject({ newEntriesAllowed: false, blockReason: "MAX_DRAWDOWN_REACHED" });
    expect(afterRestart.status.maxDrawdownReachedAt).toBe(blocked.status.maxDrawdownReachedAt);
  });

  it("rejects invalid cross-account state and unavailable equity", () => {
    const state = updateAccountProtectionState({
      tradingAccountId: "account-1",
      currentEquityUsdt: 10_000,
      maxDrawdownPercent: 10,
      state: null
    }).state;

    expect(() =>
      updateAccountProtectionState({
        tradingAccountId: "account-2",
        currentEquityUsdt: 9_000,
        maxDrawdownPercent: 10,
        state
      })
    ).toThrow("ACCOUNT_PROTECTION_ACCOUNT_MISMATCH");
    expect(() => updateAccountProtectionState({ tradingAccountId: "account-1", currentEquityUsdt: 0, maxDrawdownPercent: 10, state: null })).toThrow(
      "ACCOUNT_PROTECTION_EQUITY_UNAVAILABLE"
    );
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

  it("strips obsolete production settings and keeps only the risk-based active contract", () => {
    const settings = validateTradingSettings({
      ...defaultTradingSettings,
      positionSizingMode: "fixed-margin",
      marginPerTrade: 100,
      leverage: 20,
      fvgMitigation: "full",
      ltfFvgEntryMode: "edge",
      takeProfitMode: "fixed-rr",
      fixedRr: 9,
      maxTradesPerDay: 99
    });

    expect(settings.positionSizingMode).toBe("risk-based");
    expect(settings).not.toHaveProperty("marginPerTrade");
    expect(settings).not.toHaveProperty("leverage");
    expect(settings).not.toHaveProperty("fvgMitigation");
    expect(settings).not.toHaveProperty("ltfFvgEntryMode");
    expect(settings).not.toHaveProperty("takeProfitMode");
    expect(settings).not.toHaveProperty("fixedRr");
    expect(settings).not.toHaveProperty("maxTradesPerDay");
  });

  it("rejects invalid trading settings", () => {
    expect(() => validateTradingSettings({ ...defaultTradingSettings, maxLeverage: 0 })).toThrow();
    expect(() => validateTradingSettings({ ...defaultTradingSettings, tradingEnabled: true, watchlist: [] })).toThrow();
  });

  it("defaults and validates total margin usage without changing legacy settings", () => {
    expect(defaultTradingSettings.maxTotalMarginUsagePercent).toBe(60);
    expect(validateTradingSettings({ ...defaultTradingSettings }).maxTotalMarginUsagePercent).toBe(60);
    expect(() => validateTradingSettings({ ...defaultTradingSettings, maxTotalMarginUsagePercent: 0 })).toThrow();
    expect(() => validateTradingSettings({ ...defaultTradingSettings, maxTotalMarginUsagePercent: 101 })).toThrow();
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

  it("selects the nearest eligible external liquidity beyond the entry price", () => {
    const state = liquidityState([
      liquidityLevel("BSL", 100, 1),
      liquidityLevel("BSL", 130, 2),
      liquidityLevel("BSL", 120, 3),
      liquidityLevel("SSL", 90, 4),
      liquidityLevel("SSL", 70, 5),
      liquidityLevel("SSL", 80, 6)
    ]);

    expect(selectExternalLiquidityTarget(state, "bullish", 110, 10)?.price).toBe(120);
    expect(selectExternalLiquidityTarget(state, "bearish", 85, 10)?.price).toBe(80);
  });

  it("ignores swept SSL/BSL before entry and keeps swept-after-entry liquidity historically eligible", () => {
    const shortSwept = liquidityLevel("SSL", 0.08841, 1, "short-swept");
    const shortActive = liquidityLevel("SSL", 0.0874, 2, "short-active");
    const longSwept = liquidityLevel("BSL", 110, 1, "long-swept");
    const longActive = liquidityLevel("BSL", 120, 2, "long-active");
    const state = liquidityState([shortSwept, shortActive, longSwept, longActive], [
      { id: "sweep-short", type: "SSL", timeframe: "H1", price: 0.08841, candleIndex: 10, createdAt: 9, direction: "up", levelId: shortSwept.id },
      { id: "sweep-long", type: "BSL", timeframe: "H1", price: 110, candleIndex: 10, createdAt: 9, direction: "down", levelId: longSwept.id },
      { id: "sweep-after", type: "SSL", timeframe: "H1", price: 0.0874, candleIndex: 20, createdAt: 20, direction: "up", levelId: shortActive.id }
    ]);

    expect(selectExternalLiquidityTarget(state, "bearish", 0.08859, 10)?.id).toBe(shortActive.id);
    expect(selectExternalLiquidityTarget(state, "bullish", 100, 10)?.id).toBe(longActive.id);
    expect(selectExternalLiquidityTarget(state, "bearish", 0.08859, 19)?.id).toBe(shortActive.id);
    expect(selectExternalLiquidityTarget(state, "bearish", 0.08859, 20)).toBeNull();
  });

  it("ignores invalidated, inactive, internal, wrong-side, wrong-type and future-created liquidity", () => {
    const valid = liquidityLevel("SSL", 70, 2, "valid");
    const state = liquidityState([
      liquidityLevel("SSL", 80, 1, "invalidated", { invalidated: true }),
      liquidityLevel("SSL", 81, 1, "inactive", { active: false }),
      liquidityLevel("SSL", 82, 1, "internal", { isInternal: true }),
      liquidityLevel("SSL", 120, 1, "wrong-side"),
      liquidityLevel("BSL", 90, 1, "wrong-type"),
      liquidityLevel("SSL", 75, 99, "future"),
      valid
    ]);

    expect(selectExternalLiquidityTarget(state, "bearish", 100, 10)?.id).toBe(valid.id);
  });

  it("fails closed when no eligible external liquidity target exists", () => {
    const state = liquidityState([
      liquidityLevel("SSL", 80, 1, "swept"),
      liquidityLevel("SSL", 70, 2, "internal", { isInternal: true })
    ], [{ id: "sweep", type: "SSL", timeframe: "H1", price: 80, candleIndex: 3, createdAt: 3, direction: "up", levelId: "swept" }]);

    expect(selectExternalLiquidityTarget(state, "bearish", 100, 10)).toBeNull();
  });

  it("recalculates DOGEUSDT RR from the corrected unswept SSL without moving entry or SL", () => {
    const sweptSsl = liquidityLevel("SSL", 0.08841, 1, "swept-doge-ssl");
    const correctedSsl = liquidityLevel("SSL", 0.0874, 2, "corrected-doge-ssl");
    const state = liquidityState([sweptSsl, correctedSsl], [
      { id: "doge-sweep", type: "SSL", timeframe: "H1", price: 0.08841, candleIndex: 3, createdAt: 9, direction: "up", levelId: sweptSsl.id }
    ]);
    const fvg = testFvg("bearish", 0.08859, 0.08875, "DOGEUSDT:M5:bearish:entry");
    const target = selectExternalLiquidityTarget(state, "bearish", 0.08859, 10);
    const plan = calculateEntryPlan({
      direction: "bearish",
      triggeringFvg: fvg,
      protectiveCluster: [fvg],
      m5Candles: [candle("M5", 1, 0.0887, 0.0888, 0.0885, 0.0886)],
      externalLiquidityPrice: target?.price ?? null,
      config: { ...entryConfig(), stopLossBufferTicks: 5, symbolTickSize: 0.00001 }
    });

    expect(target?.id).toBe(correctedSsl.id);
    expect(plan?.entry).toBe(0.08859);
    expect(plan?.stopLoss).toBeCloseTo(0.0888, 12);
    expect(plan?.takeProfit).toBe(0.0874);
    expect(plan?.riskReward).toBeCloseTo((0.08859 - 0.0874) / (0.0888 - 0.08859), 12);
    expect(evaluateRisk(riskInput({ entry: plan?.entry, stopLoss: plan?.stopLoss, takeProfit: plan?.takeProfit, minimumRiskReward: 1 })).rejectCode).not.toBe("RR_BELOW_MINIMUM");
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

function testFvg(direction: Direction, lower: number, upper: number, id = `BTCUSDT:M5:${direction}:1:2:3`) {
  return {
    id,
    symbol: "BTCUSDT",
    timeframe: "M5" as const,
    direction,
    firstCandleOpenTime: 1,
    middleCandleOpenTime: 2,
    thirdCandleOpenTime: 3,
    lower,
    upper,
    midpoint: (lower + upper) / 2,
    status: "untouched" as const,
    createdAt: 4
  };
}

function liquidityLevel(
  type: LiquidityType,
  price: number,
  createdAt: number,
  id = `${type}:${price}:${createdAt}`,
  overrides: Partial<LiquidityLevel> = {}
): LiquidityLevel {
  return {
    id,
    type,
    timeframe: "H1",
    price,
    candleIndex: createdAt,
    createdAt,
    active: true,
    invalidated: false,
    swept: false,
    isPrimary: false,
    isInternal: false,
    children: [],
    ...overrides
  };
}

function liquidityState(levels: LiquidityLevel[], sweeps: ReturnType<LiquidityManager["render"]>["sweeps"] = []) {
  return { levels, sweeps };
}

function entryConfig() {
  return {
    stopLossBufferMode: "ticks" as const,
    stopLossBufferTicks: 5,
    stopLossBufferPercent: 0.1,
    stopLossAtrPeriod: 14,
    stopLossAtrMultiplier: 1,
    symbolTickSize: 0.1
  };
}

function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    symbol: "BTCUSDT",
    direction: "bullish",
    availableBalance: 1000,
    symbolRules: symbolRules(),
    riskPerTradeUsdt: 50,
    maxLeverage: 125,
    maxMarginUsagePercent: 100,
    marginMode: "ISOLATED",
    liquidationSafetyBufferPercent: 0.5,
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    minimumRiskReward: 2,
    openPositions: 0,
    maxOpenPositions: 1,
    symbolOpenPositions: 0,
    maxPositionPerSymbol: 1,
    availableAt: 60 * 60_000,
    drawdownPercent: 0,
    maxDrawdownPercent: 10,
    tradingEnabled: true,
    killSwitch: false,
    createdAt: 1,
    ...overrides
  };
}

function intent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  const id = overrides.id ?? "intent-1";
  return {
    id,
    tradingAccountId: "account-1",
    symbol: "BTCUSDT",
    side: "long",
    setupKey: `${id}-setup`,
    status: "PROTECTED",
    entryType: "market",
    requestedEntry: 100,
    requestedStopLoss: 95,
    requestedTakeProfit: 110,
    quantity: 10,
    binanceEntryOrderId: "entry-1",
    binanceStopOrderId: "stop-1",
    binanceTakeProfitOrderId: "tp-1",
    clientEntryOrderId: null,
    clientStopOrderId: null,
    clientTakeProfitOrderId: null,
    source: "BOT",
    version: 1,
    lastError: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides
  };
}

function trade(overrides: Partial<BinanceFuturesTradeHistoryStatus> = {}): BinanceFuturesTradeHistoryStatus {
  return {
    id: "trade-1",
    symbol: "BTCUSDT",
    tradeId: "trade-1",
    orderId: "tp-1",
    side: "SELL",
    price: 110,
    quantity: 10,
    quoteQuantity: 1100,
    realizedPnl: 50,
    commission: 0,
    commissionAsset: "USDT",
    createdAt: Math.floor(Date.parse("2026-08-22T12:00:00.000Z") / 1000),
    source: "binance",
    sourceEnvironment: "TESTNET",
    tradingAccountId: "account-1",
    ...overrides
  };
}

function symbolRules(): FuturesSymbolRules {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    pricePrecision: 1,
    quantityPrecision: 3,
    tickSize: 0.1,
    minPrice: 0.1,
    maxPrice: null,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 100,
    minNotional: 5,
    maxLeverage: 125,
    maintenanceMarginBrackets: maintenanceBrackets(),
    supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
  };
}

function linkSymbolRules(): FuturesSymbolRules {
  return {
    ...symbolRules(),
    symbol: "LINKUSDT",
    pricePrecision: 3,
    quantityPrecision: 2,
    tickSize: 0.001,
    stepSize: 0.01,
    minQty: 0.01,
    maxQty: 100000,
    minNotional: 5,
    maxLeverage: 75,
    maintenanceMarginBrackets: [
      { bracket: 1, initialLeverage: 75, notionalFloor: 0, notionalCap: 10_000, maintenanceMarginRatio: 0.0065, cumulativeMaintenanceAmount: 0 },
      { bracket: 2, initialLeverage: 50, notionalFloor: 10_000, notionalCap: 50_000, maintenanceMarginRatio: 0.01, cumulativeMaintenanceAmount: 35 },
      { bracket: 3, initialLeverage: 25, notionalFloor: 50_000, notionalCap: 250_000, maintenanceMarginRatio: 0.02, cumulativeMaintenanceAmount: 535 },
      { bracket: 4, initialLeverage: 10, notionalFloor: 250_000, notionalCap: 1_000_000, maintenanceMarginRatio: 0.05, cumulativeMaintenanceAmount: 8035 },
      { bracket: 5, initialLeverage: 5, notionalFloor: 1_000_000, notionalCap: 2_000_000, maintenanceMarginRatio: 0.1, cumulativeMaintenanceAmount: 58035 },
      { bracket: 6, initialLeverage: 4, notionalFloor: 2_000_000, notionalCap: 5_000_000, maintenanceMarginRatio: 0.125, cumulativeMaintenanceAmount: 108035 },
      { bracket: 7, initialLeverage: 3, notionalFloor: 5_000_000, notionalCap: 10_000_000, maintenanceMarginRatio: 0.15, cumulativeMaintenanceAmount: 233035 },
      { bracket: 8, initialLeverage: 2, notionalFloor: 10_000_000, notionalCap: 9223372036854776000, maintenanceMarginRatio: 0.25, cumulativeMaintenanceAmount: 1233035 }
    ]
  };
}

function maintenanceBrackets() {
  return [
    { bracket: 1, notionalFloor: 0, notionalCap: 5_000, maintenanceMarginRatio: 0.004, cumulativeMaintenanceAmount: 0, initialLeverage: 125 },
    { bracket: 2, notionalFloor: 5_000, notionalCap: 25_000, maintenanceMarginRatio: 0.005, cumulativeMaintenanceAmount: 5, initialLeverage: 75 }
  ];
}
