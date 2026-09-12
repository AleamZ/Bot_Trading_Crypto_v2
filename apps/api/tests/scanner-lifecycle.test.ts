import { describe, expect, it, vi } from "vitest";
import { MarketScanner } from "../src/application/scanner/MarketScanner.js";
import type { ExecutionGateway, SubmittedOrder } from "../src/application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { AppConfig } from "../src/application/config/AppConfig.js";
import { defaultTradingSettings } from "../src/application/config/AppConfig.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { buildSymbolAnalysis } from "../src/presentation/http/Server.js";

describe("scanner setup lifecycle", () => {
  it("separates live funnel telemetry from bootstrap replay", async () => {
    const scanner = new MarketScanner(
      config("account-a", "SOLUSDT"),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData(solLifecycleCandles("SOLUSDT", false)) as never,
      null,
      null,
      { accountId: "account-a", runtimeId: "runtime-a" }
    );

    await scanner.scan();
    const metrics = scanner.getFunnelMetrics("SOLUSDT").SOLUSDT;
    expect(metrics?.countersBySource.LIVE_SCAN?.SCAN_EVALUATED).toBe(1);
    expect(metrics?.countersBySource.BOOTSTRAP_REPLAY).toBeUndefined();
    expect(metrics?.countersBySource.LIVE_SCAN?.HTF_FVG_RAW_DETECTED).toBeGreaterThan(0);
  });

  it.each([
    ["bullish", [100, 100, 120]],
    ["bearish", [120, 100, 80]]
  ] as const)("reports stable %s HTF state on every scan without new H1 candles", async (_label, closes) => {
    const symbol = "BTCUSDT";
    const scanner = new MarketScanner(
      config("account-a", symbol),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData(closes.map((close, index) => candle(symbol, "H1", index + 1, close, close + 1, close - 1, close))) as never,
      null
    );

    await scanner.scan();
    const before = scanner.getFunnelMetrics(symbol).BTCUSDT?.countersBySource.LIVE_SCAN ?? {};
    for (let index = 0; index < 10; index += 1) await scanner.scan();
    const after = scanner.getFunnelMetrics(symbol).BTCUSDT?.countersBySource.LIVE_SCAN ?? {};

    expect((after.SCAN_EVALUATED ?? 0) - (before.SCAN_EVALUATED ?? 0)).toBe(10);
    expect((after.HTF_TREND_STATE_VALID ?? 0) - (before.HTF_TREND_STATE_VALID ?? 0)).toBe(10);
    expect((after.HTF_TREND_STATE_BULLISH ?? 0) - (before.HTF_TREND_STATE_BULLISH ?? 0) + ((after.HTF_TREND_STATE_BEARISH ?? 0) - (before.HTF_TREND_STATE_BEARISH ?? 0))).toBe(10);
    expect((after.HTF_NEW_CANDLE_TREND_VALID ?? 0) - (before.HTF_NEW_CANDLE_TREND_VALID ?? 0)).toBe(0);
  });

  it("keeps scan-level HTF state invariant for neutral and unknown trends", async () => {
    const neutral = new MarketScanner(
      config("account-a", "BTCUSDT"),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData([1, 2, 3].map((index) => candle("BTCUSDT", "H1", index, 100, 101, 99, 100))) as never,
      null
    );
    const unknown = new MarketScanner(config("account-a", "ETHUSDT"), new MemoryTradingRepository(), new NoopExecutionGateway(), fakeLogger(), new StaticMarketData([]) as never, null);

    for (let index = 0; index < 3; index += 1) {
      await neutral.scan();
      await unknown.scan();
    }

    const neutralCounters = neutral.getFunnelMetrics("BTCUSDT").BTCUSDT?.countersBySource.LIVE_SCAN ?? {};
    const unknownCounters = unknown.getFunnelMetrics("ETHUSDT").ETHUSDT?.countersBySource.LIVE_SCAN ?? {};
    expect(neutralCounters.HTF_TREND_STATE_NEUTRAL).toBe(2);
    expect(unknownCounters.HTF_TREND_STATE_UNKNOWN).toBe(3);
    expect((neutralCounters.HTF_TREND_STATE_VALID ?? 0) + (neutralCounters.HTF_TREND_STATE_NEUTRAL ?? 0) + (neutralCounters.HTF_TREND_STATE_UNKNOWN ?? 0)).toBe(neutralCounters.SCAN_EVALUATED);
    expect((unknownCounters.HTF_TREND_STATE_VALID ?? 0) + (unknownCounters.HTF_TREND_STATE_NEUTRAL ?? 0) + (unknownCounters.HTF_TREND_STATE_UNKNOWN ?? 0)).toBe(unknownCounters.SCAN_EVALUATED);
  });

  it("keeps account-scoped funnel counters separate for the same symbol", async () => {
    const a = new MarketScanner(config("account-a", "SOLUSDT"), new MemoryTradingRepository(), new NoopExecutionGateway(), fakeLogger(), new StaticMarketData(solLifecycleCandles("SOLUSDT", false)) as never, null, null, null, { accountId: "account-a" });
    const b = new MarketScanner(config("account-b", "SOLUSDT"), new MemoryTradingRepository(), new NoopExecutionGateway(), fakeLogger(), new StaticMarketData([]) as never, null, null, null, { accountId: "account-b" });

    await a.scan();
    await b.scan();
    expect(a.getFunnelMetrics("SOLUSDT").SOLUSDT?.counters.SCAN_EVALUATED).toBe(1);
    expect(b.getFunnelMetrics("SOLUSDT").SOLUSDT?.counters.SCAN_EVALUATED).toBe(1);
    expect(a.getFunnelMetrics("SOLUSDT").SOLUSDT?.counters.HTF_FVG_RAW_DETECTED).toBeGreaterThan(0);
    expect(b.getFunnelMetrics("SOLUSDT").SOLUSDT?.counters.HTF_FVG_RAW_DETECTED ?? 0).toBe(0);
  });

  it("keeps SOLUSDT Home and Analysis on the same canonical M5 FVG before and after pullback", async () => {
    const beforePullbackData = new StaticMarketData(solLifecycleCandles("SOLUSDT", false));
    const beforeRepository = new MemoryTradingRepository();
    const beforeScanner = new MarketScanner(config("account-a", "SOLUSDT"), beforeRepository, new NoopExecutionGateway(), fakeLogger(), beforePullbackData as never, null);

    await beforeScanner.scan();
    const beforeHome = beforeScanner.getWatchlistStatus()[0];
    const beforeDiagnostic = beforeScanner.getSetupDiagnostic("SOLUSDT");
    const beforeAnalysis = await buildSymbolAnalysis("SOLUSDT", config("account-a", "SOLUSDT"), beforePullbackData as never, beforeDiagnostic);

    expect(beforeHome).toMatchObject({ symbol: "SOLUSDT", state: "WaitingLtfMitigation", conditions: "5/7", status: "Monitoring" });
    expect(beforeAnalysis.setupState).toBe("WAITING_M5_PULLBACK");
    expect(beforeAnalysis.conditions.filter((condition) => condition.status === "PASSED")).toHaveLength(5);
    expect(beforeDiagnostic?.ltfFvg?.id).toBe("SOLUSDT:M5:bullish:9:10:11");
    expect(beforeAnalysis.conditions[4]?.detail).toContain("82.45");
    expect(beforeAnalysis.conditions[4]?.detail).toContain("82.47");

    const afterPullbackData = new StaticMarketData(solLifecycleCandles("SOLUSDT", true));
    const afterRepository = new MemoryTradingRepository();
    const afterScanner = new MarketScanner(config("account-a", "SOLUSDT"), afterRepository, new NoopExecutionGateway(), fakeLogger(), afterPullbackData as never, null);

    await afterScanner.scan();
    const afterHome = afterScanner.getWatchlistStatus()[0];
    const afterDiagnostic = afterScanner.getSetupDiagnostic("SOLUSDT");
    const afterAnalysis = await buildSymbolAnalysis("SOLUSDT", config("account-a", "SOLUSDT"), afterPullbackData as never, afterDiagnostic);

    expect(afterHome).toMatchObject({ symbol: "SOLUSDT", state: "ReadyToEnter", conditions: "7/7", status: "Ready" });
    expect(afterAnalysis.setupState).toBe("READY_TO_ENTRY");
    expect(afterAnalysis.conditions.filter((condition) => condition.status === "PASSED")).toHaveLength(7);
    expect(afterDiagnostic?.ltfFvg?.id).toBe("SOLUSDT:M5:bullish:9:10:11");
    expect(afterDiagnostic?.ltfFvg?.mitigatedAt).toBe(720_000);
    expect(afterDiagnostic?.entryPlan?.entry).toBeCloseTo(82.47);
    expect(afterDiagnostic?.entryPlan?.stopLoss).toBeCloseTo(81.95);
  });

  it("uses canonical runtime setup when Analysis candle history is shorter than the active ReadyToEnter setup", async () => {
    const scannerData = new StaticMarketData(solLifecycleCandles("SOLUSDT", true));
    const scanner = new MarketScanner(config("account-a", "SOLUSDT"), new MemoryTradingRepository(), new NoopExecutionGateway(), fakeLogger(), scannerData as never, null);
    await scanner.scan();

    const diagnostic = scanner.getSetupDiagnostic("SOLUSDT");
    const shortAnalysisData = new StaticMarketData([
      ...solLifecycleCandles("SOLUSDT", true).filter((candle) => candle.timeframe === "H1"),
      candle("SOLUSDT", "M5", 99, 90, 91, 89, 90)
    ]);
    const canonical = await buildSymbolAnalysis("SOLUSDT", config("account-a", "SOLUSDT"), shortAnalysisData as never, diagnostic);
    const stateless = await buildSymbolAnalysis("SOLUSDT", config("account-a", "SOLUSDT"), shortAnalysisData as never, null);

    expect(scanner.getWatchlistStatus()[0]).toMatchObject({ state: "ReadyToEnter", conditions: "7/7" });
    expect(canonical.analysisSource).toBe("runtime");
    expect(stateless.analysisSource).toBe("diagnostic-fallback");
    expect(canonical.setupState).toBe("READY_TO_ENTRY");
    expect(canonical.conditions.filter((condition) => condition.status === "PASSED")).toHaveLength(7);
    expect(stateless.setupState).not.toBe("READY_TO_ENTRY");
  });

  it("archives sticky ReadyToEnter when the selected M5 FVG invalidates before a position opens", async () => {
    const data = new StaticMarketData([...solLifecycleCandles("SOLUSDT", true), candle("SOLUSDT", "M5", 13, 82.4, 82.42, 81.8, 81.9)]);
    const scanner = new MarketScanner(config("account-a", "SOLUSDT"), new MemoryTradingRepository(), new NoopExecutionGateway(), fakeLogger(), data as never, null);

    await scanner.scan();

    expect(scanner.getWatchlistStatus()[0]).toMatchObject({ symbol: "SOLUSDT", state: "Archived", status: "Invalidated" });
    expect(scanner.getSetupDiagnostic("SOLUSDT")?.ltfFvg?.id).toBe("SOLUSDT:M5:bullish:9:10:11");
    expect(scanner.getSetupDiagnostic("SOLUSDT")?.ltfFvg?.status).toBe("invalidated");
  });

  it("processes a later BNBUSDT H1 setup even when M5 already advanced beyond that H1 close time", async () => {
    const marketData = new StaticMarketData([
      ...oldInvalidatedBullishHtfSetup("BNBUSDT"),
      candle("BNBUSDT", "M5", 10_000, 1, 1, 1, 1)
    ]);
    const repository = new MemoryTradingRepository();
    const scanner = new MarketScanner(config("account-a", "BNBUSDT"), repository, new NoopExecutionGateway(), fakeLogger(), marketData as never, null);

    await scanner.bootstrap();
    expect(scanner.getWatchlistStatus()[0]).toMatchObject({
      symbol: "BNBUSDT",
      state: "Archived",
      conditions: "0/7",
      status: "Invalidated"
    });

    marketData.setCandles([
      ...oldInvalidatedBullishHtfSetup("BNBUSDT"),
      ...newBullishHtfSetupAfterInvalidation("BNBUSDT"),
      candle("BNBUSDT", "M5", 10_001, 1, 1, 1, 1)
    ]);
    await scanner.scan();

    const home = scanner.getWatchlistStatus()[0];
    const snapshot = (await repository.getDashboardSnapshot()) as { currentHtfFvg: { id: string } | null };
    const analysis = await buildSymbolAnalysis("BNBUSDT", config("account-a", "BNBUSDT"), marketData as never);

    expect(home).toMatchObject({
      symbol: "BNBUSDT",
      state: "WaitingMitigation",
      conditions: "2/7",
      status: "Monitoring"
    });
    expect(snapshot.currentHtfFvg?.id).toBe("BNBUSDT:H1:bullish:5:6:7");
    expect(snapshot.currentHtfFvg?.id).not.toBe("BNBUSDT:H1:bullish:1:2:3");
    expect(analysis.setupState).toBe("WAITING_HTF_MITIGATION");
    expect(analysis.conditions.filter((condition) => condition.status === "PASSED")).toHaveLength(2);
  });

  it("archives an invalidated setup but continues into the current HTF setup like Analysis", async () => {
    const candles = invalidatedThenCurrentBullishHtfSetup("BNBUSDT");
    const marketData = new StaticMarketData(candles);
    const repository = new MemoryTradingRepository();
    const scanner = new MarketScanner(config("account-a", "BNBUSDT"), repository, new NoopExecutionGateway(), fakeLogger(), marketData as never, null);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T09:04:59.000Z"));
    await scanner.bootstrap();

    const home = scanner.getWatchlistStatus()[0];
    const snapshot = await repository.getDashboardSnapshot();
    const events = (snapshot as { events: Array<{ type: string }> }).events;
    const analysis = await buildSymbolAnalysis("BNBUSDT", config("account-a", "BNBUSDT"), marketData as never);

    expect(events.some((event) => event.type === "FVGInvalidated")).toBe(true);
    expect(home).toMatchObject({
      symbol: "BNBUSDT",
      state: "WaitingMitigation",
      conditions: "2/7",
      position: "None",
      status: "Monitoring"
    });
    expect(home?.lastScanAt).toBe("2026-08-20T09:04:59.000Z");
    expect(analysis.setupState).toBe("WAITING_HTF_MITIGATION");
    expect(analysis.conditions.filter((condition) => condition.status === "PASSED")).toHaveLength(2);

    vi.setSystemTime(new Date("2026-08-20T09:09:48.000Z"));
    await scanner.scan();
    expect(scanner.getWatchlistStatus()[0]?.lastScanAt).toBe("2026-08-20T09:09:48.000Z");
    expect(scanner.getWatchlistStatus()[0]?.conditions).toBe("2/7");
    vi.useRealTimers();
  });

  it("keeps account-scoped scanners isolated for the same symbol", async () => {
    const accountARepository = new MemoryTradingRepository();
    const accountBRepository = new MemoryTradingRepository();
    const accountAScanner = new MarketScanner(
      config("account-a", "BNBUSDT"),
      accountARepository,
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData(invalidatedThenCurrentBullishHtfSetup("BNBUSDT")) as never,
      null
    );
    const accountBScanner = new MarketScanner(
      config("account-b", "BNBUSDT"),
      accountBRepository,
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData([]) as never,
      null
    );

    await accountAScanner.bootstrap();
    await accountBScanner.bootstrap();

    expect(accountAScanner.getWatchlistStatus()[0]).toMatchObject({ symbol: "BNBUSDT", conditions: "2/7" });
    expect(accountBScanner.getWatchlistStatus()[0]).toMatchObject({ symbol: "BNBUSDT", conditions: "0/7" });
    expect(accountAScanner.getEngine("BNBUSDT")).not.toBe(accountBScanner.getEngine("BNBUSDT"));
  });

  it("selects the nearest untouched same-direction H1 FVG instead of the oldest candidate", async () => {
    const scanner = new MarketScanner(
      config("account-a", "ADAUSDT"),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData(twoUntouchedBullishHtfFvgs("ADAUSDT")) as never,
      null
    );

    await scanner.scan();

    const diagnostic = scanner.getSetupDiagnostic("ADAUSDT");
    expect(diagnostic?.state).toBe("WaitingMitigation");
    expect(diagnostic?.htfFvg?.id).toBe("ADAUSDT:H1:bullish:5:6:7");
    expect(diagnostic?.htfFvg?.status).toBe("untouched");
  });

  it("does not let a historically touched H1 FVG return as a fresh candidate", async () => {
    const scanner = new MarketScanner(
      config("account-a", "ADAUSDT"),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData(touchedBullishHtfFvg("ADAUSDT")) as never,
      null
    );

    await scanner.bootstrap();

    const diagnostic = scanner.getSetupDiagnostic("ADAUSDT");
    expect(diagnostic?.htfFvg?.id).toBe("ADAUSDT:H1:bullish:1:2:3");
    expect(diagnostic?.htfFvg?.status).toBe("touched");
    expect(diagnostic?.htfFvg?.mitigatedAt).toBe(240_000);
    expect(diagnostic?.state).toBe("MonitoringLTF");
  });

  it("does not let an old touched H1 FVG block a newer fresh nearest candidate", async () => {
    const scanner = new MarketScanner(
      config("account-a", "ADAUSDT"),
      new MemoryTradingRepository(),
      new NoopExecutionGateway(),
      fakeLogger(),
      new StaticMarketData([...touchedBullishHtfFvg("ADAUSDT"), ...newBullishHtfSetupAfterInvalidation("ADAUSDT")]) as never,
      null
    );

    await scanner.bootstrap();

    const diagnostic = scanner.getSetupDiagnostic("ADAUSDT");
    expect(diagnostic?.state).toBe("WaitingMitigation");
    expect(diagnostic?.htfFvg?.id).toBe("ADAUSDT:H1:bullish:5:6:7");
    expect(diagnostic?.htfFvg?.status).toBe("untouched");
  });
});

function config(_accountId: string, symbol: string): AppConfig {
  return {
    ...defaultTradingSettings,
    symbol,
    watchlist: [symbol],
    emaPeriod: 3,
    swingLeft: 1,
    swingRight: 1,
    port: 8787,
    executionMode: "testnet",
    logLevel: "info",
    corsOrigins: ["http://localhost:5173"],
    databaseUrl: undefined,
    sessionSecret: "test-session-secret-with-at-least-thirty-two-chars",
    binanceCredentialEncryptionKey: "1111111111111111111111111111111111111111111111111111111111111111",
    binanceApiKey: undefined,
    binanceApiSecret: undefined,
    binanceTestnet: true,
    reconciliationIntervalMs: 30_000,
    binanceRetryMaxAttempts: 3,
    binanceRetryBaseDelayMs: 0,
    postgresPoolMax: 2,
    realLiveExecutionEnabled: false
  };
}

function invalidatedThenCurrentBullishHtfSetup(symbol: string): Candle[] {
  return [
    candle(symbol, "H1", 1, 100, 1000, 90, 100),
    candle(symbol, "H1", 2, 100, 150, 95, 100),
    candle(symbol, "H1", 3, 1100, 1250, 1100, 1200),
    candle(symbol, "H1", 4, 1150, 1160, 890, 900)
  ];
}

function oldInvalidatedBullishHtfSetup(symbol: string): Candle[] {
  return [
    candle(symbol, "H1", 1, 100, 1000, 90, 100),
    candle(symbol, "H1", 2, 100, 150, 95, 100),
    candle(symbol, "H1", 3, 1100, 1250, 1100, 1200),
    candle(symbol, "H1", 4, 900, 1160, 80, 900)
  ];
}

function newBullishHtfSetupAfterInvalidation(symbol: string): Candle[] {
  return [
    candle(symbol, "H1", 5, 930, 980, 850, 950),
    candle(symbol, "H1", 6, 950, 970, 900, 960),
    candle(symbol, "H1", 7, 1180, 1250, 1000, 1200)
  ];
}

function twoUntouchedBullishHtfFvgs(symbol: string): Candle[] {
  return [
    candle(symbol, "H1", 1, 80, 90, 70, 80),
    candle(symbol, "H1", 2, 82, 85, 80, 82),
    candle(symbol, "H1", 3, 98, 100, 95, 98),
    candle(symbol, "H1", 4, 99, 101, 96, 99),
    candle(symbol, "H1", 5, 104, 105, 100, 104),
    candle(symbol, "H1", 6, 105, 106, 104, 105),
    candle(symbol, "H1", 7, 120, 122, 108, 120)
  ];
}

function touchedBullishHtfFvg(symbol: string): Candle[] {
  return [
    candle(symbol, "H1", 1, 80, 90, 70, 80),
    candle(symbol, "H1", 2, 82, 96, 80, 82),
    candle(symbol, "H1", 3, 98, 100, 95, 98),
    candle(symbol, "H1", 4, 99, 101, 94, 99)
  ];
}

function solLifecycleCandles(symbol: string, includePullback: boolean): Candle[] {
  return [
    candle(symbol, "H1", 1, 80, 81, 79, 80),
    candle(symbol, "H1", 2, 81, 82, 80, 81),
    candle(symbol, "H1", 3, 84, 86, 83, 85),
    candle(symbol, "H1", 4, 85, 85.5, 81.4, 85),
    candle(symbol, "M5", 5, 100, 101, 99, 100),
    candle(symbol, "M5", 6, 105, 110, 104, 108),
    candle(symbol, "M5", 7, 103, 105, 101, 102),
    candle(symbol, "M5", 8, 108, 112, 107, 111),
    candle(symbol, "M5", 9, 82.4, 82.45, 82.38, 82.42),
    candle(symbol, "M5", 10, 82.43, 82.46, 82.4, 82.44),
    candle(symbol, "M5", 11, 82.5, 82.7, 82.47, 82.6),
    ...(includePullback ? [candle(symbol, "M5", 12, 82.62, 82.68, 82.46, 82.62)] : [])
  ];
}

function candle(symbol: string, timeframe: Candle["timeframe"], openTime: number, open: number, high: number, low: number, close: number): Candle {
  return {
    symbol,
    timeframe,
    openTime,
    closeTime: openTime * 60_000,
    open,
    high,
    low,
    close,
    volume: 1,
    isClosed: true
  };
}

class StaticMarketData {
  constructor(private candles: Candle[]) {}

  setCandles(candles: Candle[]): void {
    this.candles = candles;
  }

  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number): Promise<Candle[]> {
    return this.candles.filter((candle) => candle.symbol === symbol && candle.timeframe === timeframe).slice(-limit);
  }
}

class NoopExecutionGateway implements ExecutionGateway {
  async submitBracketOrder(_plan: EntryPlan, _risk: RiskDecision): Promise<SubmittedOrder> {
    return { orderId: "noop", mode: "paper" };
  }
}

function fakeLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
