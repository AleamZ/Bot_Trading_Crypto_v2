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
import { LiquidityManager, buildLiquidityState, selectExternalLiquidityTarget } from "../src/domain/liquidity/LiquidityDetector.js";
import { formatRuleNumber, normalizePrice, normalizeQuantity, validateAgainstSymbolRules, type FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";

describe("Binance symbol rules", () => {
  it("normalizes quantity down to step size", () => {
    expect(normalizeQuantity(0.00129, 0.001)).toBe(0.001);
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

  it("rejects risk decisions that require leverage above the symbol effective maximum", () => {
    const bnbRules = { ...symbolRules(), symbol: "BNBUSDT", maxQty: null, maxLeverage: 75 };

    const rejected = evaluateRisk(
      riskInput({
        symbol: "BNBUSDT",
        symbolRules: bnbRules,
        riskPerTradeUsdt: 100,
        maxLeverage: 125,
        maxMarginUsagePercent: 100,
        availableBalance: 100,
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
        maxMarginUsagePercent: 100,
        availableBalance: 134,
        entry: 100,
        stopLoss: 99,
        takeProfit: 103
      })
    );

    expect(rejected).toMatchObject({ accepted: false, rejectCode: "REQUIRED_LEVERAGE_EXCEEDS_MAX", selectedLeverage: 100 });
    expect(accepted).toMatchObject({ accepted: true, selectedLeverage: 75 });
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
    supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
  };
}
