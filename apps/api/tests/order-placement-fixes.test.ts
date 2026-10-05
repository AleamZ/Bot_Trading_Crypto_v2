import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesExecutionGateway } from "../src/infrastructure/execution/BinanceFuturesExecutionGateway.js";
import { ExecutionCoordinator } from "../src/application/execution/ExecutionCoordinator.js";
import { TradingReconciliationService } from "../src/application/execution/TradingReconciliationService.js";
import { MarketScanner } from "../src/application/scanner/MarketScanner.js";
import { MemoryExecutionIntentRepository } from "../src/infrastructure/execution/MemoryExecutionIntentRepository.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { defaultTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import type {
  EmergencyCloseRequest,
  ExecutionGateway,
  ExecutionOrderContext,
  ExecutionOrderLookupResult,
  ProtectionOrderRequest,
  RecoverableExecutionGateway,
  SubmittedOrder
} from "../src/application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Binance gateway order protection", () => {
  it("refuses to enter when the live price is already beyond the stop loss", async () => {
    const requests = stubBinance({ price: "1.30" });
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1);

    await expect(gateway.submitBracketOrder(plan(), risk(), context())).rejects.toThrow("ENTRY_PRICE_BEYOND_PROTECTION");
    expect(requests.some((request) => request.path === "/fapi/v1/order" && request.method === "POST")).toBe(false);
  });

  it("closes the new position immediately when the stop loss cannot be placed", async () => {
    const requests = stubBinance({ price: "1.5088", stopError: '{"code":-2021,"msg":"Order would immediately trigger."}' });
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1);

    await expect(gateway.submitBracketOrder(plan(), risk(), context())).rejects.toThrow("PROTECTION_FAILED_POSITION_CLOSED");
    const orders = requests.filter((request) => request.path === "/fapi/v1/order" && request.method === "POST");
    expect(orders).toHaveLength(2);
    expect(orders[1]?.params).toMatchObject({ side: "SELL", type: "MARKET", reduceOnly: "true", newClientOrderId: "smc_intent_C" });
    // -2021 cannot succeed on retry, so exactly one stop attempt is made and no TP is placed.
    expect(requests.filter((request) => request.path === "/fapi/v1/algoOrder" && request.method === "POST")).toHaveLength(1);
  });

  it("does not place SL/TP while a LIMIT entry is still resting", async () => {
    const requests = stubBinance({ price: "1.55", entryStatus: "NEW", executedQty: "0" });
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "limit", 1);

    const submitted = await gateway.submitBracketOrder(plan(), risk(), context());

    expect(submitted.entryFilled).toBe(false);
    expect(submitted.stopLossOrderId).toBeUndefined();
    expect(requests.some((request) => request.path === "/fapi/v1/algoOrder" && request.method === "POST")).toBe(false);
  });

  it("follows entry mode changes without being rebuilt", async () => {
    const requests = stubBinance({ price: "1.5088" });
    let entryMode: "limit" | "market" = "market";
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", () => entryMode, 1);

    entryMode = "limit";
    await gateway.submitBracketOrder(plan(), risk(), context());

    const entry = requests.find((request) => request.path === "/fapi/v1/order" && request.method === "POST");
    expect(entry?.params).toMatchObject({ type: "LIMIT", price: "1.5088", timeInForce: "GTC" });
  });
});

describe("Execution intents for resting LIMIT entries", () => {
  it("keeps an unfilled LIMIT entry as ENTRY_SUBMITTED instead of PROTECTION_INCOMPLETE", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate: ExecutionGateway = {
      async submitBracketOrder(_plan, _risk, ctx?: ExecutionOrderContext): Promise<SubmittedOrder> {
        return { orderId: "entry-1", entryFilled: false, clientEntryOrderId: ctx?.clientEntryOrderId ?? "", mode: "testnet" };
      }
    };
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-a",
      mode: "DEMO",
      entryType: () => "limit",
      repository,
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      runtimeReady: () => true
    });

    await coordinator.submitBracketOrder(plan(), risk());

    const [intent] = await repository.listByAccount("account-a");
    expect(intent).toMatchObject({ status: "ENTRY_SUBMITTED", entryType: "limit" });
  });

  it("cancels a LIMIT entry that did not fill before the timeout", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedLimitIntent(repository);
    const gateway = new RecordingRecoverableGateway();
    const service = new TradingReconciliationService(repository, fakeLogger(), 0);

    await service.reconcile("account-a", async () => ({
      ...activityMeta(),
      connected: true,
      positions: [],
      openOrders: [restingEntry(intent.clientEntryOrderId ?? "")],
      orderHistory: [],
      tradeHistory: []
    }), gateway);

    expect(gateway.cancelled).toEqual([intent.clientEntryOrderId]);
    expect((await repository.listByAccount("account-a"))[0]?.status).toBe("CANCELLED");
  });

  it("cancels a leftover closePosition stop of a finished intent once the symbol is flat", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedLimitIntent(repository);
    await repository.transitionStatus(intent.id, ["ENTRY_SUBMITTED"], "FAILED", { lastError: "PROTECTION_FAILED" });
    const gateway = new RecordingRecoverableGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile("account-a", async () => ({
      ...activityMeta(),
      connected: true,
      positions: [],
      openOrders: [{ ...restingEntry(intent.clientStopOrderId ?? ""), type: "STOP_MARKET", side: "SELL", reduceOnly: true }],
      orderHistory: [],
      tradeHistory: []
    }), gateway);

    expect(gateway.cancelled).toEqual([intent.clientStopOrderId]);
  });

  it("closes immediately when a stop repair fails with an already-crossed trigger (-2021)", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedLimitIntent(repository);
    await repository.transitionStatus(intent.id, ["ENTRY_SUBMITTED"], "ENTRY_FILLED");
    const gateway = new RecordingRecoverableGateway(new Error('Binance STOP_MARKET algo order failed 400: {"code":-2021,"msg":"Order would immediately trigger."}'));
    const service = new TradingReconciliationService(repository, fakeLogger(), 60 * 60 * 1000);

    await service.reconcile("account-a", async () => ({
      ...activityMeta(),
      connected: true,
      positions: [position()],
      openOrders: [],
      orderHistory: [],
      tradeHistory: []
    }), gateway);

    expect(gateway.closed).toHaveLength(1);
    expect((await repository.listByAccount("account-a"))[0]?.status).toBe("CLOSING");
  });
});

describe("Engine setup lifecycle fixes", () => {
  it("activates the H1 context on the M5 candle that first touches it", async () => {
    const scanner = scannerFor([...solH1(false), candle("SOLUSDT", "M5", 5, 84, 84.5, 82.5, 84.2)]);
    await scanner.scan();

    const diagnostic = scanner.getSetupDiagnostic("SOLUSDT");
    expect(diagnostic?.state).toBe("MonitoringLTF");
    expect(diagnostic?.htfFvg?.mitigatedAt).toBe(300_000);
  });

  it("does not activate the H1 context on an M5 candle that closes through the whole zone", async () => {
    const scanner = scannerFor([...solH1(false), candle("SOLUSDT", "M5", 5, 84, 84.5, 79, 80)]);
    await scanner.scan();

    expect(scanner.getSetupDiagnostic("SOLUSDT")?.state).toBe("WaitingMitigation");
  });

  it("keeps an in-progress M5 setup when a newer H1 FVG forms after the touch", async () => {
    const data = new StaticMarketData(solCandles(false));
    const scanner = scannerFor(data);
    await scanner.scan();
    expect(scanner.getSetupDiagnostic("SOLUSDT")?.state).toBe("WaitingLtfMitigation");

    data.setCandles([
      ...solCandles(false),
      candle("SOLUSDT", "H1", 13, 85, 86, 84, 85.5),
      candle("SOLUSDT", "H1", 14, 86, 88, 85.5, 87.5),
      candle("SOLUSDT", "H1", 15, 90, 92, 89, 91)
    ]);
    await scanner.scan();

    const diagnostic = scanner.getSetupDiagnostic("SOLUSDT");
    expect(diagnostic?.state).toBe("WaitingLtfMitigation");
    expect(diagnostic?.ltfFvg?.id).toBe("SOLUSDT:M5:bullish:9:10:11");
  });

  it("archives a blocked ready setup on the next M5 close instead of entering late", async () => {
    const scanner = scannerFor([...solCandles(true), candle("SOLUSDT", "M5", 13, 82.62, 82.7, 82.55, 82.65)]);
    await scanner.scan();

    const status = scanner.getWatchlistStatus()[0];
    expect(status).toMatchObject({ state: "Archived", status: "Invalidated" });
    expect(status?.blockedReason).toContain("TRADING_DISABLED");
  });

  it("skips the entry when the live price is already beyond the stop loss", async () => {
    const gateway = new SpyGateway();
    const scanner = scannerFor(solCandles(true), { gateway, livePrice: 81.9, tradingEnabled: true });
    await scanner.scan();

    expect(gateway.calls).toHaveLength(0);
    expect(scanner.getWatchlistStatus()[0]).toMatchObject({ state: "Archived" });
    expect(scanner.getSetupDiagnostic("SOLUSDT")?.lastRejection?.code).toBe("PRICE_BEYOND_PROTECTION");
  });

  it("sizes a MARKET entry from the live price, not the FVG boundary", async () => {
    const gateway = new SpyGateway();
    const scanner = scannerFor(solCandles(true), { gateway, livePrice: 82.62, tradingEnabled: true });
    await scanner.scan();

    expect(gateway.calls).toHaveLength(1);
    const [call] = gateway.calls;
    expect(call?.plan.entry).toBeCloseTo(82.62);
    expect(call?.risk.entry).toBeCloseTo(82.62);
    expect(call?.risk.actualRiskUsdt).toBeLessThanOrEqual(defaultTradingSettings.riskPerTradeUsdt);
    // The strategy plan shown in diagnostics still records the FVG boundary entry.
    expect(scanner.getSetupDiagnostic("SOLUSDT")?.entryPlan?.entry).toBeCloseTo(82.47);
  });

  it("does not take a new setup on a symbol with a resting bot LIMIT entry", async () => {
    const gateway = new SpyGateway();
    const scanner = scannerFor(solCandles(true), { gateway, livePrice: 82.62, tradingEnabled: true });
    scanner.syncPositions([], ["SOLUSDT"]);
    await scanner.scan();

    expect(gateway.calls).toHaveLength(0);
  });
});

function scannerFor(
  input: Candle[] | StaticMarketData,
  options: { gateway?: ExecutionGateway; livePrice?: number; tradingEnabled?: boolean } = {}
): MarketScanner {
  const data = input instanceof StaticMarketData ? input : new StaticMarketData(input);
  if (options.livePrice !== undefined) data.livePrice = options.livePrice;
  return new MarketScanner(
    config({ tradingEnabled: options.tradingEnabled ?? false }),
    new MemoryTradingRepository(),
    options.gateway ?? new SpyGateway(),
    fakeLogger(),
    data as never,
    null,
    async () => solRules()
  );
}

function config(overrides: Partial<AppConfig>): AppConfig {
  return {
    ...defaultTradingSettings,
    symbol: "SOLUSDT",
    watchlist: ["SOLUSDT"],
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
    binanceRetryMaxAttempts: 1,
    binanceRetryBaseDelayMs: 0,
    postgresPoolMax: 2,
    realLiveExecutionEnabled: false,
    ...overrides
  } as AppConfig;
}

function solH1(includeTouch: boolean): Candle[] {
  return [
    candle("SOLUSDT", "H1", 1, 80, 81, 79, 80),
    candle("SOLUSDT", "H1", 2, 81, 82, 80, 81),
    candle("SOLUSDT", "H1", 3, 84, 86, 83, 85),
    ...(includeTouch ? [candle("SOLUSDT", "H1", 4, 85, 85.5, 81.4, 85)] : [])
  ];
}

// Same fixture as scanner-lifecycle: H1 FVG [81, 83] touched, M5 BOS, M5 FVG [82.45, 82.47], pullback on candle 12.
function solCandles(includePullback: boolean): Candle[] {
  return [
    ...solH1(true),
    candle("SOLUSDT", "M5", 5, 100, 101, 99, 100),
    candle("SOLUSDT", "M5", 6, 105, 110, 104, 108),
    candle("SOLUSDT", "M5", 7, 103, 105, 101, 102),
    candle("SOLUSDT", "M5", 8, 108, 112, 107, 111),
    candle("SOLUSDT", "M5", 9, 82.4, 82.45, 82.38, 82.42),
    candle("SOLUSDT", "M5", 10, 82.43, 82.46, 82.4, 82.44),
    candle("SOLUSDT", "M5", 11, 82.5, 82.7, 82.47, 82.6),
    ...(includePullback ? [candle("SOLUSDT", "M5", 12, 82.62, 82.68, 82.46, 82.62)] : [])
  ];
}

function candle(symbol: string, timeframe: Candle["timeframe"], openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol, timeframe, openTime, closeTime: openTime * 60_000, open, high, low, close, volume: 1, isClosed: true };
}

class StaticMarketData {
  livePrice: number | null = null;
  constructor(private candles: Candle[]) {}
  setCandles(candles: Candle[]): void {
    this.candles = candles;
  }
  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number): Promise<Candle[]> {
    return this.candles.filter((item) => item.symbol === symbol && item.timeframe === timeframe).slice(-limit);
  }
  async getLastPrice(): Promise<number | null> {
    return this.livePrice;
  }
}

class SpyGateway implements ExecutionGateway {
  calls: Array<{ plan: EntryPlan; risk: RiskDecision }> = [];
  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder> {
    this.calls.push({ plan, risk });
    return { orderId: "spy", mode: "testnet" };
  }
}

class RecordingRecoverableGateway implements RecoverableExecutionGateway {
  cancelled: string[] = [];
  closed: EmergencyCloseRequest[] = [];
  constructor(private readonly protectionError: Error | null = null) {}
  async submitBracketOrder(): Promise<SubmittedOrder> {
    throw new Error("not used");
  }
  async findOrderByClientOrderId(): Promise<ExecutionOrderLookupResult | null> {
    return null;
  }
  async submitProtectionOrder(request: ProtectionOrderRequest): Promise<ExecutionOrderLookupResult> {
    if (this.protectionError) throw this.protectionError;
    return { orderId: "p", clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, type: request.type, status: "NEW", reduceOnly: true, originalQuantity: request.quantity, executedQuantity: 0, averagePrice: null };
  }
  async closePosition(request: EmergencyCloseRequest): Promise<ExecutionOrderLookupResult> {
    this.closed.push(request);
    return { orderId: "close", clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, type: "MARKET", status: "FILLED", reduceOnly: true, originalQuantity: request.quantity, executedQuantity: request.quantity, averagePrice: 100 };
  }
  async cancelOrderByClientOrderId(_symbol: string, clientOrderId: string): Promise<void> {
    this.cancelled.push(clientOrderId);
  }
}

async function seedLimitIntent(repository: MemoryExecutionIntentRepository) {
  const { intent } = await repository.createOrGet({
    id: "limit-intent-1",
    tradingAccountId: "account-a",
    symbol: "BTCUSDT",
    side: "long",
    setupKey: "account-a:limit-setup",
    entryType: "limit",
    requestedEntry: 100,
    requestedStopLoss: 95,
    requestedTakeProfit: 110,
    quantity: 10,
    clientEntryOrderId: "smc_limit_E",
    clientStopOrderId: "smc_limit_S",
    clientTakeProfitOrderId: "smc_limit_T"
  });
  await repository.transitionStatus(intent.id, ["CREATED"], "ENTRY_SUBMITTED", { binanceEntryOrderId: "entry-1", lastError: null });
  const saved = (await repository.listByAccount("account-a"))[0];
  if (!saved) throw new Error("Missing intent");
  return saved;
}

function activityMeta() {
  return { source: "BINANCE_SIGNED_ACCOUNT" as const, sourceEnvironment: "TESTNET" as const, tradingAccountId: "account-a" };
}

function restingEntry(clientOrderId: string) {
  return {
    id: "binance:open-order:BTCUSDT:entry-1",
    symbol: "BTCUSDT",
    orderId: "entry-1",
    clientOrderId,
    side: "BUY",
    type: "LIMIT",
    price: 100,
    stopPrice: null,
    quantity: 10,
    executedQuantity: 0,
    status: "NEW",
    reduceOnly: false,
    createdAt: null,
    updatedAt: null
  };
}

function position() {
  return {
    id: "binance:BTCUSDT:long",
    symbol: "BTCUSDT",
    side: "long" as const,
    entryPrice: 100,
    entryTime: null,
    quantity: 10,
    notional: 1000,
    leverage: 5,
    margin: 200,
    unrealizedProfit: 0,
    stopLoss: null,
    takeProfit: null
  };
}

function solRules(): FuturesSymbolRules {
  return {
    symbol: "SOLUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    pricePrecision: 2,
    quantityPrecision: 2,
    tickSize: 0.1,
    minPrice: 0.01,
    maxPrice: null,
    stepSize: 0.01,
    minQty: 0.01,
    maxQty: 100_000,
    minNotional: 5,
    maxLeverage: 75,
    maintenanceMarginBrackets: [{ bracket: 1, notionalFloor: 0, notionalCap: null, maintenanceMarginRatio: 0.005, cumulativeMaintenanceAmount: 0, initialLeverage: 75 }],
    supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
  };
}

function plan(): EntryPlan {
  return { direction: "bullish", entry: 1.5088, stopLoss: 1.3088, takeProfit: 1.9088, structuralStopBoundary: 1.31, stopLossBuffer: 0.0012, riskReward: 2, reason: "test" };
}

function risk(): RiskDecision {
  return {
    accepted: true,
    reason: "Risk passed",
    symbol: "XRPUSDT",
    margin: 150.88,
    leverage: 1,
    requiredLeverage: 1,
    leverageNeededForMargin: 1,
    effectiveMaxLeverage: 75,
    selectedLeverage: 1,
    requiredMargin: 150.88,
    maxLeverage: 75,
    maxMarginUsagePercent: 20,
    marginMode: "ISOLATED",
    liquidationSafetyBufferPercent: 0.5,
    positionSize: 150.88,
    quantity: 100,
    notional: 150.88,
    entry: 1.5088,
    stopLoss: 1.3088,
    takeProfit: 1.9088,
    estimatedLoss: 20,
    estimatedProfit: 40,
    actualRiskUsdt: 20,
    targetRiskUsdt: 20,
    riskPerTradeUsdt: 20,
    availableBalance: 5000,
    maxAllowedMargin: 1000,
    marginUsagePercent: 3,
    maintenanceMarginRate: 0.004,
    maintenanceMarginAmount: 0.6,
    maintenanceMarginBracket: { bracket: 1, notionalFloor: 0, notionalCap: null, cumulativeMaintenanceAmount: 0, initialLeverage: 75 },
    estimatedLiquidationPrice: 0.001,
    distanceSlToLiquidation: 1.3,
    liquidationSafetyStatus: "SAFE",
    riskReward: 2,
    createdAt: 1
  } as RiskDecision;
}

function context(): ExecutionOrderContext {
  return { executionIntentId: "intent", setupKey: "setup", clientEntryOrderId: "smc_intent_E", clientStopOrderId: "smc_intent_S", clientTakeProfitOrderId: "smc_intent_T" };
}

interface CapturedRequest {
  path: string;
  method: string;
  params: Record<string, string>;
}

function stubBinance(options: { price: string; stopError?: string; entryStatus?: string; executedQty?: string }): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const params = { ...Object.fromEntries(url.searchParams.entries()), ...Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams | undefined).entries()) };
    const method = init?.method ?? "GET";
    requests.push({ path: url.pathname, method, params });
    if (url.pathname === "/fapi/v1/exchangeInfo") return json(exchangeInfo());
    if (url.pathname === "/fapi/v1/ticker/price") return json({ symbol: "XRPUSDT", price: options.price });
    if (url.pathname === "/fapi/v2/positionRisk") return json([{ symbol: "XRPUSDT", positionAmt: "0", marginType: "ISOLATED", leverage: "1" }]);
    if (url.pathname === "/fapi/v1/order" && method === "GET") return json({ code: -2013, msg: "Order does not exist." }, 400);
    if (url.pathname === "/fapi/v1/order" && method === "POST") {
      const isClose = params.reduceOnly === "true";
      const status = isClose ? "FILLED" : options.entryStatus ?? "FILLED";
      const executedQty = isClose ? params.quantity : options.executedQty ?? params.quantity;
      return json({ orderId: isClose ? 12 : 11, clientOrderId: params.newClientOrderId, symbol: "XRPUSDT", side: params.side, type: params.type, status, origQty: params.quantity, executedQty, avgPrice: options.price });
    }
    if (url.pathname === "/fapi/v1/algoOrder" && method === "POST") {
      if (params.type === "STOP_MARKET" && options.stopError) return new Response(options.stopError, { status: 400 });
      return json({ algoId: params.type === "STOP_MARKET" ? 21 : 22, clientAlgoId: params.clientAlgoId, symbol: "XRPUSDT", side: params.side, orderType: params.type, algoStatus: "NEW", triggerPrice: params.triggerPrice, closePosition: true });
    }
    return json({}, 404);
  }));
  return requests;
}

function exchangeInfo() {
  return {
    symbols: [
      {
        symbol: "XRPUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 4,
        quantityPrecision: 1,
        orderTypes: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.0143", maxPrice: "100000", tickSize: "0.0001" },
          { filterType: "LOT_SIZE", minQty: "0.1", maxQty: "1000000", stepSize: "0.1" },
          { filterType: "MIN_NOTIONAL", notional: "5" }
        ]
      }
    ]
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeLogger(): DecisionLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}
