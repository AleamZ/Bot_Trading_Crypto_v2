import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_CONCURRENCY, MarketScanner, type ScannerProgress } from "../src/application/scanner/MarketScanner.js";
import type { ExecutionGateway, SubmittedOrder } from "../src/application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { Fvg } from "../src/domain/fvg/Fvg.js";
import type { AppConfig } from "../src/application/config/AppConfig.js";
import { defaultTradingSettings } from "../src/application/config/AppConfig.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { PostgresTradingRepository } from "../src/infrastructure/persistence/PostgresTradingRepository.js";

const WATCHLIST = ["ADAUSDT", "AVAXUSDT", "BNBUSDT", "BTCUSDT", "ETHUSDT", "LINKUSDT", "NEARUSDT"];

describe("scanner bootstrap", () => {
  it("replays at most BOOTSTRAP_CONCURRENCY symbols at once and every symbol exactly once", async () => {
    const marketData = new TrackingMarketData();
    const scanner = createScanner(marketData);

    await scanner.bootstrap();

    expect(BOOTSTRAP_CONCURRENCY).toBe(3);
    expect(marketData.maxActiveSymbols).toBe(3);
    expect(marketData.m5Requests.sort()).toEqual([...WATCHLIST].sort());
    // Bootstrap still replays the long M5 history, unlike live scans.
    expect(new Set(marketData.m5Limits)).toEqual(new Set([300]));
  });

  it("runs one symbol at a time in watchlist order when concurrency is 1", async () => {
    const marketData = new TrackingMarketData();
    const scanner = createScanner(marketData);

    await scanner.bootstrap(1);

    expect(marketData.maxActiveSymbols).toBe(1);
    expect(marketData.m5Requests).toEqual(WATCHLIST);
  });

  it("reports progress per symbol, then waits for the first live scan before going LIVE", async () => {
    const scanner = createScanner(new TrackingMarketData());
    const seen: ScannerProgress[] = [];
    scanner.onSymbolScanned(() => seen.push(scanner.getProgress()));

    expect(scanner.getProgress()).toEqual({ phase: "NOT_STARTED", bootstrapped: 0, total: 0, startedAt: null, liveSince: null });
    const running = scanner.bootstrap();
    expect(scanner.getProgress()).toMatchObject({ phase: "BOOTSTRAPPING", bootstrapped: 0, total: WATCHLIST.length });
    await running;

    expect(seen.map((progress) => progress.bootstrapped)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen.every((progress) => progress.phase === "BOOTSTRAPPING" && progress.total === WATCHLIST.length)).toBe(true);
    expect(scanner.getProgress()).toMatchObject({ phase: "WAITING_FIRST_SCAN", bootstrapped: 7, total: 7, liveSince: null });
    expect(scanner.getProgress().startedAt).toEqual(expect.any(String));

    seen.length = 0;
    await scanner.scan();

    expect(scanner.getProgress()).toMatchObject({ phase: "LIVE", bootstrapped: 7, total: 7 });
    expect(scanner.getProgress().liveSince).toEqual(expect.any(String));
    // Listeners already see LIVE on the first live scan's first symbol.
    expect(seen[0]?.phase).toBe("LIVE");
  });

  it("finishes the other symbols when one fails, then rejects with that error so the runtime retries", async () => {
    const marketData = new TrackingMarketData(new Set(["BNBUSDT"]));
    const logger = fakeLogger();
    const scanner = createScanner(marketData, logger);

    await expect(scanner.bootstrap()).rejects.toThrow("BNBUSDT candles unavailable");

    expect(marketData.m5Requests.sort()).toEqual([...WATCHLIST].sort());
    expect(scanner.getProgress()).toMatchObject({ phase: "BOOTSTRAP_FAILED", bootstrapped: 7, total: 7 });
    expect(logger.error).toHaveBeenCalledWith("[SCANNER] symbol bootstrap failed", { symbol: "BNBUSDT", error: "BNBUSDT candles unavailable" });

    marketData.failing.clear();
    await scanner.bootstrap();
    expect(scanner.getProgress()).toMatchObject({ phase: "WAITING_FIRST_SCAN", bootstrapped: 7, total: 7 });
  });

  it("returns the same engine states as a one-at-a-time replay", async () => {
    const candles = WATCHLIST.flatMap((symbol, index) => trendCandles(symbol, index % 2 === 0 ? "up" : "down"));
    const sequential = createScanner(new TrackingMarketData(new Set(), candles));
    const parallel = createScanner(new TrackingMarketData(new Set(), candles));

    await sequential.bootstrap(1);
    await parallel.bootstrap();

    const states = (scanner: MarketScanner) => scanner.getWatchlistStatus().map(({ lastScanAt: _lastScanAt, ...row }) => row);
    expect(states(parallel)).toEqual(states(sequential));
    expect(new Set(WATCHLIST.map((symbol) => parallel.getEngine(symbol)?.getState().trend))).toEqual(new Set(["bullish", "bearish"]));
  });
});

describe("PostgresTradingRepository.getActiveOrWaitingFvg", () => {
  it("lets the database pick the newest usable FVG and fetches a single row", async () => {
    const fvg = { id: "fvg-1", symbol: "BTCUSDT", timeframe: "H1", status: "touched", createdAt: 3 } as unknown as Fvg;
    const { repository, query } = postgresRepository([{ payload: fvg }]);

    await expect(repository.getActiveOrWaitingFvg("BTCUSDT", "H1")).resolves.toEqual(fvg);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/payload->>'status' = any\(\$4::text\[\]\)/);
    expect(sql).toMatch(/order by \(payload->>'createdAt'\)::numeric desc\s+limit 1/);
    expect(params).toEqual(["BTCUSDT", "H1", "11111111-1111-4111-8111-111111111111", ["untouched", "touched", "active", "waiting-mitigation"]]);
  });

  it("returns null when no usable FVG exists and passes a null timeframe through", async () => {
    const { repository, query } = postgresRepository([]);

    await expect(repository.getActiveOrWaitingFvg("ETHUSDT")).resolves.toBeNull();
    expect((query.mock.calls[0] as [string, unknown[]])[1]?.[1]).toBeNull();
  });
});

function postgresRepository(rows: Array<{ payload: Fvg }>) {
  const repository = new PostgresTradingRepository("postgres://user:pass@127.0.0.1:1/unused", "11111111-1111-4111-8111-111111111111");
  const query = vi.fn(async () => ({ rows }));
  // The pool never connects: queries go to the stub.
  (repository as unknown as { pool: { query: typeof query } }).pool = { query };
  return { repository, query };
}

function createScanner(marketData: TrackingMarketData, logger = fakeLogger()): MarketScanner {
  return new MarketScanner(config(), new MemoryTradingRepository(), new NoopExecutionGateway(), logger, marketData as never, null);
}

/** Answers after a short delay and records how many symbols were being fetched at the same time. */
class TrackingMarketData {
  readonly m5Requests: string[] = [];
  readonly m5Limits: number[] = [];
  maxActiveSymbols = 0;
  private readonly active = new Map<string, number>();

  constructor(
    readonly failing = new Set<string>(),
    private readonly candles: Candle[] = []
  ) {}

  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number): Promise<Candle[]> {
    if (timeframe === "M5") {
      this.m5Requests.push(symbol);
      this.m5Limits.push(limit);
    }
    this.active.set(symbol, (this.active.get(symbol) ?? 0) + 1);
    this.maxActiveSymbols = Math.max(this.maxActiveSymbols, this.active.size);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.failing.has(symbol)) throw new Error(`${symbol} candles unavailable`);
      return this.candles.filter((candle) => candle.symbol === symbol && candle.timeframe === timeframe).slice(-limit);
    } finally {
      const left = (this.active.get(symbol) ?? 1) - 1;
      if (left === 0) this.active.delete(symbol);
      else this.active.set(symbol, left);
    }
  }
}

function trendCandles(symbol: string, direction: "up" | "down"): Candle[] {
  const step = direction === "up" ? 10 : -10;
  return Array.from({ length: 12 }, (_, index) => {
    const close = 1000 + step * index;
    return candle(symbol, "H1", (index + 1) * 60, close - step / 2, close + 3, close - 3, close);
  });
}

function candle(symbol: string, timeframe: Candle["timeframe"], openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol, timeframe, openTime, closeTime: openTime * 60_000, open, high, low, close, volume: 1, isClosed: true };
}

class NoopExecutionGateway implements ExecutionGateway {
  async submitBracketOrder(_plan: EntryPlan, _risk: RiskDecision): Promise<SubmittedOrder> {
    return { orderId: "noop", mode: "paper" };
  }
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(): AppConfig {
  return {
    ...defaultTradingSettings,
    symbol: WATCHLIST[0]!,
    watchlist: WATCHLIST,
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
