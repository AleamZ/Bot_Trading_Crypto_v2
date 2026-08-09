import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { TradingEngine } from "../../application/engine/TradingEngine.js";
import type { TradingRepository } from "../../application/ports/Repositories.js";
import type { DecisionLogger } from "../../application/ports/Logger.js";
import type { AppConfig } from "../../application/config/AppConfig.js";
import {
  BinanceFuturesAccountClient,
  type BinanceFuturesOpenOrderStatus,
  type BinanceFuturesOrderHistoryStatus,
  type BinanceFuturesPositionStatus,
  type BinanceFuturesTradeHistoryStatus,
  type BinanceFuturesWalletStatus
} from "../../infrastructure/execution/BinanceFuturesAccountClient.js";
import { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";
import { ema } from "../../domain/trend/Ema.js";
import { detectH1Trend } from "../../domain/trend/TrendDetector.js";
import { calculateEntryPlan, type EntryPlan } from "../../domain/entry/EntryCalculator.js";
import { evaluateRisk } from "../../domain/risk/RiskManager.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { detectLatestHtfFvg, detectLatestLtfFvg, isFvgInvalidated, isFvgMitigated } from "../../domain/fvg/FvgDetector.js";
import type { Fvg, FvgMitigationMode } from "../../domain/fvg/Fvg.js";
import { buildLiquidityState } from "../../domain/liquidity/LiquidityDetector.js";
import { selectExternalLiquidityTarget } from "../../domain/liquidity/LiquidityDetector.js";
import { detectM5StructureSignal } from "../../domain/market-structure/StructureDetector.js";
import { detectSwings } from "../../domain/market-structure/Swing.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { Candle, Timeframe } from "../../domain/market-data/Candle.js";
import type { Direction } from "../../domain/trade/Direction.js";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

export function startHttpServer(params: {
  port: number;
  config: AppConfig;
  engine: TradingEngine;
  repository: TradingRepository;
  logger: DecisionLogger;
}): void {
  const dashboardDir = join(process.cwd(), "src", "presentation", "dashboard");
  const marketData = new BinanceFuturesMarketData(params.config.binanceTestnet);
  const accountClient =
    params.config.binanceApiKey && params.config.binanceApiSecret
      ? new BinanceFuturesAccountClient(params.config.binanceApiKey, params.config.binanceApiSecret, params.config.binanceTestnet)
      : null;
  let accountCache: BinanceFuturesWalletStatus | null = null;
  let accountCacheAt = 0;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (requestUrl.pathname === "/api/snapshot") {
        const store = await params.repository.getDashboardSnapshot();
        const accountStatus = await getAccountStatus(params.config, accountClient, accountCache, accountCacheAt);
        accountCache = accountStatus.cache;
        accountCacheAt = accountStatus.cacheAt;
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify({ engine: params.engine.getDashboardState(), runtime: getRuntimeStatus(params.config, accountStatus.status), store }));
        return;
      }

      if (requestUrl.pathname === "/api/binance/klines" || requestUrl.pathname === "/binance/klines") {
        const query = parseKlineQuery(requestUrl, params.config.symbol);
        const klines = await marketData.getKlines(query.symbol, query.interval, query.limit);
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify({ symbol: query.symbol, interval: query.interval, limit: query.limit, klines }));
        return;
      }

      if (requestUrl.pathname === "/api/bot/events") {
        const symbol = requestUrl.searchParams.get("symbol") ?? params.config.symbol;
        const limit = clampLimit(requestUrl.searchParams.get("limit"), 200, 500);
        const store = await params.repository.getDashboardSnapshot();
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify({ symbol, limit, events: selectBotEvents(store, symbol, limit) }));
        return;
      }

      if (requestUrl.pathname === "/api/binance/account-activity") {
        const query = parseAccountActivityQuery(requestUrl, params.config.symbol);
        const activity = await getAccountActivity(accountClient, query.symbol, query.limit, params.logger);
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify({ symbol: query.symbol, limit: query.limit, ...activity }));
        return;
      }

      if (requestUrl.pathname === "/api/analysis") {
        const query = parseAccountActivityQuery(requestUrl, params.config.symbol);
        const analysis = await buildSymbolAnalysis(query.symbol, params.config, marketData);
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify(analysis));
        return;
      }

      if (requestUrl.pathname === "/api/chart/overlays") {
        const query = parseKlineQuery(requestUrl, params.config.symbol);
        const store = await params.repository.getDashboardSnapshot();
        const candles = await marketData.getKlines(query.symbol, query.interval, query.limit);
        const overlays = await buildChartOverlays({
          store,
          engineState: params.engine.getDashboardState(),
          symbol: query.symbol,
          timeframe: query.interval,
          candles,
          emaPeriod: params.config.emaPeriod,
          marginPerTrade: params.config.marginPerTrade,
          leverage: params.config.leverage,
          manualPositions: await getManualPositions(accountClient, query.symbol, params.logger)
        });
        response.writeHead(200, noCacheHeaders("application/json"));
        response.end(JSON.stringify(overlays));
        return;
      }

      const path = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      if (path.startsWith("/.well-known/") || path === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const file = join(dashboardDir, path.replace(/^\//, ""));
      const body = await readFile(file);
      response.writeHead(200, noCacheHeaders(contentTypes[extname(file)] ?? "application/octet-stream"));
      response.end(body);
    } catch (error) {
      params.logger.error("HTTP request failed", { error: error instanceof Error ? error.message : String(error) });
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  server.listen(params.port, "127.0.0.1", () => {
    params.logger.info(`Dashboard listening on http://localhost:${params.port}`);
  });
}

function parseKlineQuery(url: URL, defaultSymbol: string): { symbol: string; interval: string; limit: number } {
  const symbol = (url.searchParams.get("symbol") ?? defaultSymbol).toUpperCase();
  const interval = url.searchParams.get("interval") ?? url.searchParams.get("timeframe") ?? "5m";
  const limit = clampLimit(url.searchParams.get("limit"), 300, 1000);
  const validIntervals = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"]);

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }
  if (!validIntervals.has(interval)) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  return { symbol, interval, limit };
}

function parseAccountActivityQuery(url: URL, defaultSymbol: string): { symbol: string; limit: number } {
  const symbol = (url.searchParams.get("symbol") ?? defaultSymbol).toUpperCase();
  const limit = clampLimit(url.searchParams.get("limit"), 100, 500);

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }

  return { symbol, limit };
}

function clampLimit(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function selectBotEvents(store: unknown, symbol: string, limit: number): unknown[] {
  if (!isRecord(store) || !Array.isArray(store.events)) return [];
  return store.events
    .filter((event) => eventMatchesSymbol(event, symbol))
    .slice(-limit);
}

function eventMatchesSymbol(event: unknown, symbol: string): boolean {
  if (!isRecord(event)) return false;
  if (event.symbol === symbol) return true;
  if (isRecord(event.fvg) && event.fvg.symbol === symbol) return true;
  if (isRecord(event.signal) && event.signal.symbol === symbol) return true;
  return !("symbol" in event) && !("fvg" in event) && !("signal" in event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function buildChartOverlays(params: {
  store: unknown;
  engineState: unknown;
  symbol: string;
  timeframe: string;
  candles: Array<{ time: number; openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume?: number }>;
  emaPeriod: number;
  marginPerTrade: number;
  leverage: number;
  manualPositions: BinanceFuturesPositionStatus[];
}): Promise<unknown> {
  const events = selectBotEvents(params.store, params.symbol, 500).filter(isRecord);
  const fvg = new Map<string, Record<string, unknown>>();
  const swings = new Map<string, Record<string, unknown>>();
  const bos = new Map<string, Record<string, unknown>>();
  const choch = new Map<string, Record<string, unknown>>();
  const externalLiquidity = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();

  for (const chartFvg of selectVisibleFvgs(detectChartFvgs(params.symbol, params.timeframe, params.candles), 5)) {
    fvg.set(fvgOverlayKey(chartFvg), chartFvg);
  }

  if (isHighTimeframe(params.timeframe)) {
    for (const level of detectExternalLiquidity(params.symbol, params.timeframe, params.candles)) {
      externalLiquidity.set(String(level.id), level);
    }
  }

  if (isLowTimeframe(params.timeframe)) {
    for (const structure of detectLtfStructureOverlays(params.symbol, params.timeframe, params.candles)) {
      if (structure.kind === "BOS") bos.set(String(structure.id), structure);
      if (structure.kind === "CHOCH") choch.set(String(structure.id), structure);
    }
  }

  for (const event of events) {
    if (isRecord(event.fvg)) {
      const fvgObject = toFvgOverlay(event, event.fvg);
      if (
        fvgObject.status !== "invalidated" &&
        sameTimeframe(String(fvgObject.timeframe), params.timeframe) &&
        isFvgRenderable(fvgObject, params.candles)
      ) {
        fvg.set(fvgOverlayKey(fvgObject), fvgObject);
      }
    }

    if (isLowTimeframe(params.timeframe) && isRecord(event.signal) && isRecord(event.signal.brokenSwing)) {
      const structureObject = toStructureOverlay(event, event.signal, event.signal.brokenSwing, params.symbol);
      if (event.type === "BOSDetected") bos.set(String(structureObject.id), structureObject);
      if (event.type === "CHOCHDetected") choch.set(String(structureObject.id), structureObject);

      const swingObject = toSwingOverlay(event.signal.brokenSwing, params.symbol);
      swings.set(String(swingObject.id), swingObject);
    }
  }

  const emaValues = ema(
    params.candles.map((candle) => candle.close),
    params.emaPeriod
  );
  const emaOverlay = params.candles.map((candle, index) => ({
    ...baseOverlay(`${params.symbol}:${params.timeframe}:EMA:${params.emaPeriod}:${candle.time}`, params.symbol, params.timeframe, candle.time, "active"),
    period: params.emaPeriod,
    value: emaValues[index] ?? candle.close,
    time: candle.time
  }));

  for (const position of buildPositionOverlays({
    engineState: params.engineState,
    manualPositions: params.manualPositions,
    symbol: params.symbol,
    timeframe: params.timeframe,
    candles: params.candles,
    marginPerTrade: params.marginPerTrade,
    leverage: params.leverage
  })) {
    positions.set(String(position.id), position);
  }

  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    total: fvg.size + swings.size + bos.size + choch.size + externalLiquidity.size + positions.size,
    ema: emaOverlay,
    fvg: [...fvg.values()],
    swings: [...swings.values()],
    bos: [...bos.values()],
    choch: [...choch.values()],
    externalLiquidity: [...externalLiquidity.values()],
    internalLiquidity: [],
    trades: [],
    positions: [...positions.values()]
  };
}

type AnalysisStatus = "PASSED" | "WAITING" | "INVALIDATED";
type AnalysisSetupState =
  | "WAITING_HTF_CONTEXT"
  | "WAITING_HTF_FVG"
  | "WAITING_HTF_MITIGATION"
  | "WAITING_M5_BOS"
  | "WAITING_M5_FVG"
  | "WAITING_M5_PULLBACK"
  | "READY_TO_ENTRY"
  | "ORDER_PLACED"
  | "INVALIDATED";

interface AnalysisCondition {
  id: string;
  label: string;
  status: AnalysisStatus;
  detail: string;
}

interface AnalysisRiskCheck {
  id: string;
  label: string;
  status: AnalysisStatus;
  detail: string;
}

interface AnalysisSetupContext {
  id: string;
  state: AnalysisSetupState;
  direction: Direction | null;
  trendReason: string;
  htfFvg: Fvg | null;
  htfMitigatedAt: number | null;
  signal: MarketStructureSignal | null;
  ltfFvg: Fvg | null;
  ltfMitigatedAt: number | null;
  plan: EntryPlan | null;
  entryDetail: string | null;
  invalidatedConditionId: string | null;
  invalidatedReason: string | null;
}

async function buildSymbolAnalysis(symbol: string, config: AppConfig, marketData: BinanceFuturesMarketData): Promise<{
  symbol: string;
  checkedAt: string;
  setupState: AnalysisSetupState;
  setupStatus: string;
  trend: {
    direction: Direction | "neutral";
    ema: number | null;
    close: number | null;
    reason: string;
  };
  summary: string;
  conditions: AnalysisCondition[];
  riskManagement: {
    final: "WAITING_FOR_STRATEGY" | "READY_TO_TRADE" | "BLOCKED";
    reason: string | null;
    checks: AnalysisRiskCheck[];
    decision: RiskDecision | null;
  };
  plan: EntryPlan | null;
}> {
  const [h1Candles, m5Candles] = await Promise.all([
    marketData.getClosedCandles(symbol, "H1", Math.max(config.emaPeriod + 80, 160)),
    marketData.getClosedCandles(symbol, "M5", 360)
  ]);
  const trend = detectH1Trend(h1Candles, config.emaPeriod);
  const setup = buildAnalysisLifecycle(symbol, h1Candles, m5Candles, config);
  const conditions = buildLifecycleConditions(setup, config);
  const riskManagement = buildAnalysisRiskManagement(setup, config);

  return {
    symbol,
    checkedAt: new Date().toISOString(),
    setupState: setup.state,
    setupStatus: setupStateLabel(setup.state),
    trend: {
      direction: trend.direction,
      ema: Number.isFinite(trend.ema) ? trend.ema : null,
      close: Number.isFinite(trend.close) ? trend.close : null,
      reason: trend.reason
    },
    summary: riskManagement.final === "READY_TO_TRADE" ? "READY TO TRADE" : riskManagement.final === "BLOCKED" ? `BLOCKED: ${riskManagement.reason ?? "-"}` : buildLifecycleSummary(setup, conditions),
    conditions,
    riskManagement,
    plan: setup.plan
  };
}

function buildAnalysisLifecycle(
  symbol: string,
  h1Input: readonly Candle[],
  m5Input: readonly Candle[],
  config: AppConfig
): AnalysisSetupContext {
  const h1Candles: Candle[] = [];
  const m5Candles: Candle[] = [];
  let setup = createEmptyAnalysisSetup(symbol);
  let lastInvalidatedSetup: AnalysisSetupContext | null = null;
  const candles = [...h1Input, ...m5Input].sort((a, b) => a.closeTime - b.closeTime);

  for (const candle of candles) {
    if (candle.timeframe === "H1") {
      h1Candles.push(candle);
      const result = processAnalysisH1Candle(setup, candle, h1Candles, config);
      setup = result.setup;
      if (result.invalidated) {
        lastInvalidatedSetup = result.invalidated;
      }
      continue;
    }

    m5Candles.push(candle);
    const result = processAnalysisM5Candle(setup, candle, h1Candles, m5Candles, config);
    setup = result.setup;
    if (result.invalidated) {
      lastInvalidatedSetup = result.invalidated;
    }
  }

  if (setup.state === "WAITING_HTF_CONTEXT" && lastInvalidatedSetup && !setup.direction && !setup.htfFvg) {
    return lastInvalidatedSetup;
  }

  return setup;
}

function processAnalysisH1Candle(
  setup: AnalysisSetupContext,
  candle: Candle,
  h1Candles: readonly Candle[],
  config: AppConfig
): { setup: AnalysisSetupContext; invalidated: AnalysisSetupContext | null } {
  if (setup.htfFvg && ["WAITING_HTF_MITIGATION", "WAITING_M5_BOS", "WAITING_M5_FVG", "WAITING_M5_PULLBACK"].includes(setup.state)) {
    if (isFvgInvalidated(setup.htfFvg, candle)) {
      const invalidated = invalidateAnalysisSetup(setup, "htf-fvg-mitigated", "HTF FVG bị invalidated bởi H1 close phá boundary đối diện");
      return { setup: createEmptyAnalysisSetup(candle.symbol), invalidated };
    }
  }

  if (setup.state === "WAITING_HTF_CONTEXT") {
    const trend = detectH1Trend(h1Candles, config.emaPeriod);
    if (trend.direction === "neutral") {
      setup.trendReason = trend.reason;
      return { setup, invalidated: null };
    }

    setup = {
      ...setup,
      state: "WAITING_HTF_FVG",
      direction: trend.direction,
      trendReason: trend.reason
    };
  }

  if (setup.state === "WAITING_HTF_FVG" && setup.direction) {
    const htfFvg = detectLatestHtfFvg(h1Candles, setup.direction);
    if (htfFvg) {
      setup = {
        ...setup,
        id: htfFvg.id,
        state: "WAITING_HTF_MITIGATION",
        htfFvg
      };
    }
  }

  if (setup.state === "WAITING_HTF_MITIGATION" && setup.htfFvg) {
    if (isFvgInvalidated(setup.htfFvg, candle)) {
      const invalidated = invalidateAnalysisSetup(setup, "htf-fvg-mitigated", "HTF FVG bị invalidated trước khi mitigation");
      return { setup: createEmptyAnalysisSetup(candle.symbol), invalidated };
    }

    if (isFvgMitigated(setup.htfFvg, candle, config.fvgMitigation)) {
      setup = {
        ...setup,
        state: "WAITING_M5_BOS",
        htfMitigatedAt: candle.closeTime
      };
    }
  }

  return { setup, invalidated: null };
}

function processAnalysisM5Candle(
  setup: AnalysisSetupContext,
  candle: Candle,
  h1Candles: readonly Candle[],
  m5Candles: readonly Candle[],
  config: AppConfig
): { setup: AnalysisSetupContext; invalidated: AnalysisSetupContext | null } {
  if (!setup.direction || !setup.htfFvg || setup.htfMitigatedAt === null) {
    return { setup, invalidated: null };
  }
  const direction = setup.direction;
  if (candle.closeTime < setup.htfMitigatedAt) {
    return { setup, invalidated: null };
  }

  if (setup.state === "WAITING_M5_BOS") {
    const signal = detectM5StructureSignal(m5Candles, direction, {
      left: config.swingLeft,
      right: config.swingRight
    });
    if (signal?.direction === direction && (!config.requireDisplacement || isAnalysisDisplacementSignal(m5Candles, signal, config))) {
      setup = {
        ...setup,
        state: "WAITING_M5_FVG",
        signal
      };
    }
  }

  if (setup.state === "WAITING_M5_FVG" && setup.signal) {
    const ltfFvg = detectLatestLtfFvg(m5Candles, direction, setup.signal.candleOpenTime);
    if (ltfFvg) {
      setup = {
        ...setup,
        state: "WAITING_M5_PULLBACK",
        ltfFvg
      };
    }
  }

  if (setup.state === "WAITING_M5_PULLBACK" && setup.ltfFvg) {
    if (isFvgInvalidated(setup.ltfFvg, candle)) {
      const invalidated = invalidateAnalysisSetup(setup, "m5-fvg-pullback", "M5 FVG target bị invalidated trước khi pullback mitigation");
      return { setup: createEmptyAnalysisSetup(candle.symbol), invalidated };
    }

    if (isFvgMitigated(setup.ltfFvg, candle, config.ltfFvgEntryMode)) {
      const planCheck = calculateAnalysisEntryPlan(direction, setup.ltfFvg, h1Candles, m5Candles, config);
      if (!planCheck.plan) {
        const invalidated = invalidateAnalysisSetup(
          { ...setup, ltfMitigatedAt: candle.closeTime, entryDetail: planCheck.detail },
          "entry-plan",
          planCheck.detail
        );
        return { setup: createEmptyAnalysisSetup(candle.symbol), invalidated };
      }

      setup = {
        ...setup,
        state: "READY_TO_ENTRY",
        ltfMitigatedAt: candle.closeTime,
        plan: planCheck.plan,
        entryDetail: planCheck.detail
      };
    }
  }

  return { setup, invalidated: null };
}

function createEmptyAnalysisSetup(symbol: string): AnalysisSetupContext {
  return {
    id: `${symbol}:analysis:${Date.now()}`,
    state: "WAITING_HTF_CONTEXT",
    direction: null,
    trendReason: "Need H1 EMA trend context",
    htfFvg: null,
    htfMitigatedAt: null,
    signal: null,
    ltfFvg: null,
    ltfMitigatedAt: null,
    plan: null,
    entryDetail: null,
    invalidatedConditionId: null,
    invalidatedReason: null
  };
}

function invalidateAnalysisSetup(setup: AnalysisSetupContext, conditionId: string, reason: string): AnalysisSetupContext {
  return {
    ...setup,
    state: "INVALIDATED",
    invalidatedConditionId: conditionId,
    invalidatedReason: reason
  };
}

function buildLifecycleConditions(setup: AnalysisSetupContext, config: AppConfig): AnalysisCondition[] {
  return [
    condition("h1-trend", "EMA Trend H1", setup.direction ? "PASSED" : statusFor(setup, "h1-trend"), setup.direction ? setup.trendReason : "Waiting for H1 EMA trend"),
    condition(
      "htf-fvg",
      "HTF FVG H1 cùng hướng trend",
      setup.htfFvg ? "PASSED" : statusFor(setup, "htf-fvg"),
      setup.htfFvg ? describeFvg(setup.htfFvg) : setup.direction ? `Waiting for ${setup.direction} H1 FVG` : "Waiting for trend first"
    ),
    condition(
      "htf-fvg-mitigated",
      `HTF FVG mitigated (${config.fvgMitigation})`,
      setup.htfMitigatedAt ? "PASSED" : statusFor(setup, "htf-fvg-mitigated"),
      setup.htfMitigatedAt && setup.htfFvg ? `PASSED tại ${formatServerDate(setup.htfMitigatedAt)} · ${describeFvg(setup.htfFvg)}` : "Waiting for HTF FVG mitigation"
    ),
    condition(
      "m5-structure",
      "M5 BOS/CHOCH",
      setup.signal ? "PASSED" : statusFor(setup, "m5-structure"),
      setup.signal ? `${setup.signal.type} ${setup.signal.direction} tại close ${formatServerPrice(setup.signal.close)}` : setup.direction ? `Waiting for ${setup.direction} BOS/CHOCH` : "Waiting for HTF context"
    ),
    condition(
      "m5-fvg",
      "M5 FVG mới sau BOS/CHOCH cùng hướng trend",
      setup.ltfFvg ? "PASSED" : statusFor(setup, "m5-fvg"),
      setup.ltfFvg ? describeFvg(setup.ltfFvg) : "Waiting for FVG after BOS/CHOCH"
    ),
    condition(
      "m5-fvg-pullback",
      `M5 FVG pullback mitigated (${config.ltfFvgEntryMode})`,
      setup.ltfMitigatedAt ? "PASSED" : statusFor(setup, "m5-fvg-pullback"),
      setup.ltfMitigatedAt && setup.ltfFvg ? `PASSED tại ${formatServerDate(setup.ltfMitigatedAt)} · ${describeFvg(setup.ltfFvg)}` : "Waiting for price pullback into stored M5 FVG"
    ),
    condition(
      "entry-plan",
      "Tính Entry / SL / TP",
      setup.plan ? "PASSED" : statusFor(setup, "entry-plan"),
      setup.plan
        ? `Entry ${formatServerPrice(setup.plan.entry)} · SL ${formatServerPrice(setup.plan.stopLoss)} · TP ${formatServerPrice(setup.plan.takeProfit)} · RR ${formatServerPrice(setup.plan.riskReward)}`
        : setup.entryDetail ?? "Waiting for M5 FVG pullback first"
    )
  ];
}

function condition(id: string, label: string, status: AnalysisStatus, detail: string): AnalysisCondition {
  return { id, label, status, detail };
}

function statusFor(setup: AnalysisSetupContext, conditionId: string): AnalysisStatus {
  if (setup.state === "INVALIDATED" && setup.invalidatedConditionId === conditionId) return "INVALIDATED";
  return "WAITING";
}

function buildAnalysisRiskManagement(setup: AnalysisSetupContext, config: AppConfig): {
  final: "WAITING_FOR_STRATEGY" | "READY_TO_TRADE" | "BLOCKED";
  reason: string | null;
  checks: AnalysisRiskCheck[];
  decision: RiskDecision | null;
} {
  const waitingChecks: AnalysisRiskCheck[] = [
    riskCheck("minimum-rr", "Minimum R/R", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("trading-enabled", "Trading Enabled", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("max-open-positions", "Max Open Positions", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("max-trades-per-day", "Max Trades / Day", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("daily-loss-limit", "Daily Loss Limit", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("max-consecutive-losses", "Max Consecutive Losses", "WAITING", "Waiting for strategy entry plan"),
    riskCheck("cooldown", "Cooldown", "WAITING", "Waiting for strategy entry plan")
  ];

  if (!setup.plan) {
    return {
      final: "WAITING_FOR_STRATEGY",
      reason: null,
      checks: waitingChecks,
      decision: null
    };
  }

  const availableBalance = 10_000;
  const decision = evaluateRisk({
    symbol: setup.id,
    direction: setup.plan.direction,
    availableBalance,
    marginPerTrade: config.marginPerTrade,
    leverage: config.leverage,
    maxLeverage: config.maxLeverage,
    entry: setup.plan.entry,
    stopLoss: setup.plan.stopLoss,
    takeProfit: setup.plan.takeProfit,
    minimumRiskReward: config.minimumRiskReward,
    minNotional: config.minNotional,
    maxPositionSize: config.maxPositionSize,
    openPositions: 0,
    maxOpenPositions: config.maxOpenPositions,
    tradesToday: 0,
    maxTradesPerDay: config.maxTradesPerDay,
    dailyRealizedLoss: 0,
    dailyLossLimitPercent: config.maxDailyLossPercent,
    consecutiveLosses: 0,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    lastClosedTradeAt: null,
    cooldownAfterTradeMinutes: config.cooldownAfterTradeMinutes,
    availableAt: Date.now(),
    drawdownPercent: 0,
    maxDrawdownPercent: config.maxDrawdownPercent,
    tradingEnabled: config.tradingEnabled,
    killSwitch: config.killSwitch,
    createdAt: Date.now()
  });

  const checks: AnalysisRiskCheck[] = [
    riskCheck("minimum-rr", "Minimum R/R", setup.plan.riskReward >= config.minimumRiskReward ? "PASSED" : "INVALIDATED", `RR thực tế ${formatServerPrice(setup.plan.riskReward)} · minimum ${formatServerPrice(config.minimumRiskReward)}`),
    riskCheck("trading-enabled", "Trading Enabled", config.tradingEnabled ? "PASSED" : "INVALIDATED", config.tradingEnabled ? "ON" : "OFF"),
    riskCheck("max-open-positions", "Max Open Positions", decision.rejectCode === "MAX_OPEN_POSITIONS" ? "INVALIDATED" : "PASSED", `Max ${config.maxOpenPositions}`),
    riskCheck("max-trades-per-day", "Max Trades / Day", decision.rejectCode === "MAX_TRADES_PER_DAY" ? "INVALIDATED" : "PASSED", `Max ${config.maxTradesPerDay}`),
    riskCheck("daily-loss-limit", "Daily Loss Limit", decision.rejectCode === "DAILY_LOSS_LIMIT" ? "INVALIDATED" : "PASSED", `${formatServerPrice(config.maxDailyLossPercent)}%`),
    riskCheck("max-consecutive-losses", "Max Consecutive Losses", decision.rejectCode === "MAX_CONSECUTIVE_LOSSES" ? "INVALIDATED" : "PASSED", `Max ${config.maxConsecutiveLosses}`),
    riskCheck("cooldown", "Cooldown", decision.rejectCode === "COOLDOWN_ACTIVE" ? "INVALIDATED" : "PASSED", `${config.cooldownAfterTradeMinutes} minutes`)
  ];

  return {
    final: decision.accepted ? "READY_TO_TRADE" : "BLOCKED",
    reason: decision.accepted ? null : decision.rejectCode ?? decision.reason,
    checks,
    decision
  };
}

function riskCheck(id: string, label: string, status: AnalysisStatus, detail: string): AnalysisRiskCheck {
  return { id, label, status, detail };
}

function calculateAnalysisEntryPlan(
  direction: Direction,
  ltfFvg: Fvg,
  h1Candles: readonly Candle[],
  m5Candles: readonly Candle[],
  config: AppConfig
): { plan: EntryPlan | null; detail: string } {
  const h1Swings = detectSwings(h1Candles, { left: config.swingLeft, right: config.swingRight });
  const entry = calculateAnalysisFvgEntry(ltfFvg, config.ltfFvgEntryMode);
  const externalLiquidity = selectExternalLiquidityTarget(h1Swings, direction, entry);
  const plan = calculateEntryPlan({
    direction,
    ltfFvg,
    m5Candles,
    externalLiquidityPrice: externalLiquidity?.price ?? null,
    config: {
      entryFvgMitigation: config.ltfFvgEntryMode,
      takeProfitMode: config.takeProfitMode,
      fixedRr: config.fixedRr,
      stopLossBufferMode: config.stopLossBufferMode,
      stopLossBufferTicks: config.stopLossBufferTicks,
      stopLossBufferPercent: config.stopLossBufferPercent,
      stopLossAtrPeriod: config.stopLossAtrPeriod,
      stopLossAtrMultiplier: config.stopLossAtrMultiplier,
      priceTickSize: config.priceTickSize
    }
  });

  if (plan) {
    return {
      plan,
      detail: `Entry ${formatServerPrice(plan.entry)} · SL ${formatServerPrice(plan.stopLoss)} · TP ${formatServerPrice(plan.takeProfit)} · RR ${formatServerPrice(plan.riskReward)}`
    };
  }

  const stopLoss = calculateAnalysisStopLoss(direction, ltfFvg, m5Candles, config);
  const riskDistance = Math.abs(entry - stopLoss);
  const takeProfit =
    config.takeProfitMode === "external-liquidity" && externalLiquidity
      ? externalLiquidity.price
      : direction === "bullish"
        ? entry + riskDistance * config.fixedRr
        : entry - riskDistance * config.fixedRr;
  const rewardDistance = direction === "bullish" ? takeProfit - entry : entry - takeProfit;
  const diagnostics = [
    `Entry ${formatServerPrice(entry)}`,
    `SL ${formatServerPrice(stopLoss)}`,
    `TP ${formatServerPrice(takeProfit)}`,
    `risk ${formatServerPrice(riskDistance)}`,
    `reward ${formatServerPrice(rewardDistance)}`
  ].join(" · ");

  if (entry <= 0) return { plan: null, detail: `Entry không hợp lệ. ${diagnostics}` };
  if (stopLoss <= 0) return { plan: null, detail: `Stop loss không hợp lệ. ${diagnostics}` };
  if (riskDistance <= 0) return { plan: null, detail: `Risk distance bằng 0, entry và SL trùng/không hợp lệ. ${diagnostics}` };
  if (takeProfit <= 0) return { plan: null, detail: `Take profit không hợp lệ. ${diagnostics}` };
  if (config.takeProfitMode === "external-liquidity" && !externalLiquidity) {
    return { plan: null, detail: `Không tìm thấy HTF external liquidity để đặt TP. ${diagnostics}` };
  }
  if (rewardDistance <= 0) {
    const expected = direction === "bullish" ? "TP phải nằm trên entry" : "TP phải nằm dưới entry";
    return {
      plan: null,
      detail: `${expected}, nhưng TP đang không tạo reward dương. ${diagnostics}`
    };
  }

  return { plan: null, detail: `Entry plan không hợp lệ. ${diagnostics}` };
}

function calculateAnalysisFvgEntry(fvg: Fvg, mode: FvgMitigationMode): number {
  if (mode === "ce") return fvg.midpoint;
  if (fvg.direction === "bullish") return mode === "edge" ? fvg.upper : fvg.lower;
  return mode === "edge" ? fvg.lower : fvg.upper;
}

function calculateAnalysisStopLoss(direction: Direction, fvg: Fvg, candles: readonly Candle[], config: AppConfig): number {
  const buffer = calculateAnalysisStopLossBuffer(fvg, candles, config);
  return direction === "bullish" ? fvg.lower - buffer : fvg.upper + buffer;
}

function calculateAnalysisStopLossBuffer(fvg: Fvg, candles: readonly Candle[], config: AppConfig): number {
  if (config.stopLossBufferMode === "percentage") return fvg.midpoint * (config.stopLossBufferPercent / 100);
  if (config.stopLossBufferMode === "atr") return calculateAnalysisAtr(candles, config.stopLossAtrPeriod) * config.stopLossAtrMultiplier;
  return config.stopLossBufferTicks * config.priceTickSize;
}

function calculateAnalysisAtr(candles: readonly Candle[], period: number): number {
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

function describeFvg(fvg: Fvg): string {
  return `${fvg.direction} ${fvg.timeframe} · ${formatServerPrice(fvg.lower)} - ${formatServerPrice(fvg.upper)} · CE ${formatServerPrice(fvg.midpoint)}`;
}

function setupStateLabel(state: AnalysisSetupState): string {
  const labels: Record<AnalysisSetupState, string> = {
    WAITING_HTF_CONTEXT: "WAITING FOR HTF CONTEXT",
    WAITING_HTF_FVG: "WAITING FOR HTF FVG",
    WAITING_HTF_MITIGATION: "WAITING FOR HTF FVG MITIGATION",
    WAITING_M5_BOS: "WAITING FOR M5 BOS",
    WAITING_M5_FVG: "WAITING FOR M5 FVG",
    WAITING_M5_PULLBACK: "WAITING FOR M5 PULLBACK",
    READY_TO_ENTRY: "READY TO ENTER",
    ORDER_PLACED: "ORDER PLACED",
    INVALIDATED: "SETUP INVALIDATED"
  };
  return labels[state];
}

function buildLifecycleSummary(setup: AnalysisSetupContext, conditions: readonly AnalysisCondition[]): string {
  if (setup.state === "INVALIDATED") {
    return `SETUP INVALIDATED: ${setup.invalidatedReason ?? "Setup hiện tại đã mất hiệu lực"}`;
  }

  if (setup.state === "READY_TO_ENTRY") {
    return `READY TO ENTER: ${setup.direction ?? "-"} setup đã đạt đủ điều kiện.`;
  }

  const waiting = conditions.find((item) => item.status === "WAITING");
  return `${setupStateLabel(setup.state)}${waiting ? ` · ${waiting.detail}` : ""}`;
}

function isAnalysisDisplacementSignal(candles: readonly Candle[], signal: MarketStructureSignal, config: AppConfig): boolean {
  const closed = candles.filter((candle) => candle.timeframe === "M5" && candle.isClosed);
  const signalCandle = closed.find((candle) => candle.openTime === signal.candleOpenTime);
  if (!signalCandle) return false;

  const prior = closed.filter((candle) => candle.openTime < signal.candleOpenTime).slice(-config.displacementLookback);
  const averageBody = prior.length > 0 ? prior.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / prior.length : 0;
  const body = Math.abs(signalCandle.close - signalCandle.open);
  const strongClose = signal.direction === "bullish" ? signalCandle.close > signalCandle.open : signalCandle.close < signalCandle.open;
  return strongClose && body >= averageBody * config.displacementBodyMultiplier;
}

function formatServerPrice(value: number): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatServerDate(value: number | undefined): string {
  if (!value) return "-";
  return new Date(value).toISOString();
}

function buildPositionOverlays(params: {
  engineState: unknown;
  manualPositions: BinanceFuturesPositionStatus[];
  symbol: string;
  timeframe: string;
  candles: Array<{ time: number }>;
  marginPerTrade: number;
  leverage: number;
}): Record<string, unknown>[] {
  const overlays: Record<string, unknown>[] = [];
  const latestTime = params.candles.at(-1)?.time ?? Math.floor(Date.now() / 1000);

  if (isRecord(params.engineState) && isRecord(params.engineState.pendingSetup) && isRecord(params.engineState.pendingSetup.plan) && isRecord(params.engineState.pendingSetup.fvg)) {
    const plan = params.engineState.pendingSetup.plan;
    const fvg = params.engineState.pendingSetup.fvg;
    overlays.push(
      createPositionOverlay({
        id: `${params.symbol}:${params.timeframe}:pending:${String(fvg.id)}`,
        symbol: params.symbol,
        timeframe: params.timeframe,
        state: "pending",
        source: "bot",
        side: String(plan.direction) === "bearish" ? "short" : "long",
        entry: Number(plan.entry),
        stopLoss: Number(plan.stopLoss),
        takeProfit: Number(plan.takeProfit),
        quantity: (params.marginPerTrade * params.leverage) / Number(plan.entry),
        margin: params.marginPerTrade,
        leverage: params.leverage,
        positionSize: params.marginPerTrade * params.leverage,
        createdAt: toSeconds(fvg.createdAt ?? latestTime),
        bars: 36
      })
    );
  }

  if (isRecord(params.engineState) && isRecord(params.engineState.activeRisk)) {
    const risk = params.engineState.activeRisk;
    overlays.push(
      createPositionOverlay({
        id: `${params.symbol}:${params.timeframe}:active:${String(risk.createdAt ?? latestTime)}`,
        symbol: params.symbol,
        timeframe: params.timeframe,
        state: "active",
        source: "bot",
        side: Number(risk.takeProfit) > Number(risk.entry) ? "long" : "short",
        entry: Number(risk.entry),
        stopLoss: Number(risk.stopLoss),
        takeProfit: Number(risk.takeProfit),
        quantity: Number(risk.quantity),
        margin: Number(risk.margin),
        leverage: Number(risk.leverage),
        positionSize: Number(risk.positionSize),
        estimatedLoss: Number(risk.estimatedLoss),
        estimatedProfit: Number(risk.estimatedProfit),
        riskReward: Number(risk.riskReward),
        createdAt: toSeconds(risk.createdAt ?? latestTime),
        bars: 48
      })
    );
  }

  for (const position of params.manualPositions) {
    overlays.push(
      createPositionOverlay({
        id: `${params.symbol}:${params.timeframe}:${position.id}`,
        symbol: position.symbol,
        timeframe: params.timeframe,
        state: "active",
        source: "manual",
        side: position.side,
        entry: position.entryPrice,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        quantity: position.quantity,
        margin: position.margin,
        leverage: position.leverage,
        positionSize: position.notional,
        pnl: position.unrealizedProfit,
        createdAt: snapToCandleTime(position.entryTime ?? latestTime, params.candles),
        bars: 48
      })
    );
  }

  return overlays;
}

function snapToCandleTime(time: number, candles: Array<{ time: number }>): number {
  let snapped = candles[0]?.time ?? time;
  for (const candle of candles) {
    if (candle.time > time) return snapped;
    snapped = candle.time;
  }
  return snapped;
}

function createPositionOverlay(input: {
  id: string;
  symbol: string;
  timeframe: string;
  state: "pending" | "active" | "closed";
  source: "bot" | "manual";
  side: "long" | "short";
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  quantity: number;
  margin: number | null;
  leverage: number;
  positionSize: number;
  estimatedLoss?: number;
  estimatedProfit?: number;
  riskReward?: number;
  pnl?: number;
  createdAt: number;
  bars: number;
}): Record<string, unknown> {
  const hasBracket = input.stopLoss !== null && input.takeProfit !== null;
  const estimatedLoss = input.estimatedLoss ?? (input.stopLoss !== null ? Math.abs(input.entry - input.stopLoss) * input.quantity : null);
  const estimatedProfit = input.estimatedProfit ?? (input.takeProfit !== null ? Math.abs(input.takeProfit - input.entry) * input.quantity : null);
  const riskReward = input.riskReward ?? (estimatedLoss && estimatedProfit ? estimatedProfit / estimatedLoss : null);

  return {
    ...baseOverlay(input.id, input.symbol, input.timeframe, input.createdAt, input.state),
    state: input.state,
    side: input.side,
    source: input.source,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    quantity: input.quantity,
    margin: input.margin,
    leverage: input.leverage,
    positionSize: input.positionSize,
    estimatedLoss,
    estimatedProfit,
    riskReward,
    pnl: input.pnl ?? null,
    hasBracket,
    bars: input.bars
  };
}

function toFvgOverlay(event: Record<string, unknown>, fvg: Record<string, unknown>): Record<string, unknown> {
  const createdAt = fvg.thirdCandleOpenTime ?? fvg.createdAt ?? event.at;
  const timeframe = String(fvg.timeframe);
  const createdAtSeconds = toSeconds(createdAt);
  return {
    ...baseOverlay(String(fvg.id), String(fvg.symbol), timeframe, createdAtSeconds, String(fvg.status ?? "created")),
    type: fvg.direction,
    top: fvg.upper,
    bottom: fvg.lower,
    midpoint: fvg.midpoint,
    startAt: createdAtSeconds - intervalToSeconds(timeframe) * 2,
    endAt: createdAtSeconds + intervalToSeconds(timeframe) * 18,
    bars: 18
  };
}

function detectChartFvgs(
  symbol: string,
  timeframe: string,
  candles: Array<{ time: number; openTime: number; closeTime: number; high: number; low: number; close: number }>
): Array<Record<string, unknown>> {
  const fvgs: Array<Record<string, unknown>> = [];

  for (let i = 2; i < candles.length; i += 1) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (!c1 || !c3) continue;

    if (c3.low > c1.high) {
      const bottom = c1.high;
      const top = c3.low;
      fvgs.push(createChartFvg(symbol, timeframe, "bullish", c1.openTime, c3.openTime, c3.time, top, bottom, candles.slice(i + 1)));
    }

    if (c3.high < c1.low) {
      const bottom = c3.high;
      const top = c1.low;
      fvgs.push(createChartFvg(symbol, timeframe, "bearish", c1.openTime, c3.openTime, c3.time, top, bottom, candles.slice(i + 1)));
    }
  }

  return fvgs.filter((fvg) => fvg.status !== "invalidated");
}

function selectVisibleFvgs(fvgs: Array<Record<string, unknown>>, maxCount: number): Array<Record<string, unknown>> {
  return fvgs
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .slice(0, maxCount)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

function detectExternalLiquidity(
  symbol: string,
  timeframe: string,
  candles: Array<{ time: number; openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume?: number }>
): Array<Record<string, unknown>> {
  const normalized = normalizeTimeframe(timeframe);
  if (!isHighTimeframe(normalized)) return [];

  const state = buildLiquidityState(
    symbol,
    toDomainTimeframe(normalized),
    candles.map((candle): Candle => ({
      symbol,
      timeframe: toDomainTimeframe(normalized),
      openTime: candle.time,
      closeTime: Math.floor(toSeconds(candle.closeTime)),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Number(candle.volume ?? 0),
      isClosed: true
    })),
    { left: 2, right: 2 }
  );

  return [
    ...state.levels.map((level) => toLiquidityOverlay(symbol, timeframe, level)),
    ...state.sweeps.map((sweep) => ({
      ...baseOverlay(sweep.id, symbol, timeframe, sweep.createdAt, "active"),
      kind: "sweep",
      type: sweep.type,
      price: sweep.price,
      candleIndex: sweep.candleIndex,
      direction: sweep.direction,
      levelId: sweep.levelId
    }))
  ];
}

function toLiquidityOverlay(
  symbol: string,
  timeframe: string,
  level: {
    id: string;
    type: "BSL" | "SSL";
    price: number;
    candleIndex: number;
    createdAt: number;
    swept: boolean;
    sweptBy?: number;
    parentId?: string;
    isPrimary: boolean;
    isInternal: boolean;
    children: string[];
  }
): Record<string, unknown> {
  return {
    ...baseOverlay(level.id, symbol, timeframe, level.createdAt, level.swept ? "swept" : "active"),
    type: level.type,
    side: level.type === "BSL" ? "buy-side" : "sell-side",
    price: level.price,
    candleIndex: level.candleIndex,
    swept: level.swept,
    sweptBy: level.sweptBy,
    parentId: level.parentId,
    isPrimary: level.isPrimary,
    isInternal: level.isInternal,
    children: level.children,
    bars: level.isPrimary ? 64 : 24,
    source: level.type === "BSL" ? "swing-high" : "swing-low"
  };
}

function detectLtfStructureOverlays(
  symbol: string,
  timeframe: string,
  candles: Array<{ time: number; high: number; low: number; close: number }>
): Array<Record<string, unknown>> {
  const left = 2;
  const right = 2;
  const swings: Array<{ id: string; index: number; time: number; kind: "high" | "low"; price: number }> = [];

  for (let index = left; index < candles.length - right; index += 1) {
    const current = candles[index];
    if (!current) continue;
    const before = candles.slice(index - left, index);
    const after = candles.slice(index + 1, index + 1 + right);

    if (before.every((candle) => candle.high < current.high) && after.every((candle) => candle.high < current.high)) {
      swings.push({
        id: `${symbol}:${timeframe}:swing:high:${current.time}`,
        index,
        time: current.time,
        kind: "high",
        price: current.high
      });
    }

    if (before.every((candle) => candle.low > current.low) && after.every((candle) => candle.low > current.low)) {
      swings.push({
        id: `${symbol}:${timeframe}:swing:low:${current.time}`,
        index,
        time: current.time,
        kind: "low",
        price: current.low
      });
    }
  }

  const brokenSwings = new Set<string>();
  const structures: Array<Record<string, unknown>> = [];
  let lastBreakDirection: "bullish" | "bearish" | null = null;

  for (let index = left + right + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const priorSwings = swings.filter((swing) => swing.index < index - right && !brokenSwings.has(swing.id));
    const swingHigh = priorSwings.filter((swing) => swing.kind === "high").at(-1);
    const swingLow = priorSwings.filter((swing) => swing.kind === "low").at(-1);

    if (swingHigh && candle.close > swingHigh.price) {
      const kind = lastBreakDirection === "bearish" ? "CHOCH" : "BOS";
      structures.push(toChartStructureOverlay(symbol, timeframe, kind, "bullish", swingHigh, candle));
      brokenSwings.add(swingHigh.id);
      lastBreakDirection = "bullish";
      continue;
    }

    if (swingLow && candle.close < swingLow.price) {
      const kind = lastBreakDirection === "bullish" ? "CHOCH" : "BOS";
      structures.push(toChartStructureOverlay(symbol, timeframe, kind, "bearish", swingLow, candle));
      brokenSwings.add(swingLow.id);
      lastBreakDirection = "bearish";
    }
  }

  return structures.slice(-12);
}

function toChartStructureOverlay(
  symbol: string,
  timeframe: string,
  kind: "BOS" | "CHOCH",
  direction: "bullish" | "bearish",
  swing: { id: string; time: number; price: number },
  candle: { time: number }
): Record<string, unknown> {
  return {
    ...baseOverlay(`${symbol}:${timeframe}:${kind}:${direction}:${swing.time}:${candle.time}`, symbol, timeframe, candle.time, "active"),
    kind,
    price: swing.price,
    direction,
    startAt: swing.time,
    endAt: candle.time,
    brokenSwingId: swing.id
  };
}

function createChartFvg(
  symbol: string,
  timeframe: string,
  type: "bullish" | "bearish",
  firstCandleOpenTime: number,
  thirdCandleOpenTime: number,
  createdAt: number,
  top: number,
  bottom: number,
  futureCandles: Array<{ time: number; closeTime: number; close: number; high: number; low: number }>
): Record<string, unknown> {
  const invalidation = findFvgInvalidation({ type, top, bottom, createdAt }, futureCandles);
  const status = invalidation ? "invalidated" : "active";

  return {
    ...baseOverlay(`${symbol}:${timeframe}:fvg:${type}:${firstCandleOpenTime}:${thirdCandleOpenTime}`, symbol, timeframe, createdAt, status),
    type,
    top,
    bottom,
    midpoint: (top + bottom) / 2,
    startAt: Math.floor(firstCandleOpenTime / 1000),
    endAt: invalidation ? invalidation.time : createdAt + intervalToSeconds(timeframe) * 18,
    bars: 18
  };
}

function isFvgRenderable(
  fvg: Record<string, unknown>,
  candles: Array<{ time: number; closeTime: number; close: number }>
): boolean {
  const type = String(fvg.type);
  if (type !== "bullish" && type !== "bearish") return false;

  const invalidation = findFvgInvalidation(
    {
      type,
      top: Number(fvg.top),
      bottom: Number(fvg.bottom),
      createdAt: Number(fvg.createdAt)
    },
    candles
  );

  return !invalidation;
}

function findFvgInvalidation(
  fvg: { type: "bullish" | "bearish"; top: number; bottom: number; createdAt: number },
  candles: Array<{ time: number; closeTime: number; close: number }>
): { time: number } | null {
  const now = Date.now();
  const latest = candles.at(-1);
  const candlesAfterFvg = candles.filter((candle) => candle.time > fvg.createdAt);
  const closedInvalidation = candlesAfterFvg.find(
    (candle) => candle.closeTime <= now && fvgClosePierced(fvg, candle.close)
  );
  if (closedInvalidation) return closedInvalidation;

  if (latest && latest.closeTime > now && latest.time > fvg.createdAt && fvgClosePierced(fvg, latest.close)) {
    return latest;
  }

  return null;
}

function fvgClosePierced(fvg: { type: "bullish" | "bearish"; top: number; bottom: number }, close: number): boolean {
  return fvg.type === "bullish" ? close < fvg.bottom : close > fvg.top;
}

function sameTimeframe(left: string, right: string): boolean {
  return normalizeTimeframe(left) === normalizeTimeframe(right);
}

function fvgOverlayKey(fvg: Record<string, unknown>): string {
  return [
    String(fvg.symbol),
    normalizeTimeframe(String(fvg.timeframe)),
    String(fvg.type),
    String(fvg.startAt ?? fvg.createdAt),
    String(fvg.top),
    String(fvg.bottom)
  ].join(":");
}

function normalizeTimeframe(timeframe: string): string {
  const normalized = timeframe.toLowerCase();
  if (normalized === "h1") return "1h";
  if (normalized === "h4") return "4h";
  if (normalized === "d1") return "1d";
  if (normalized === "m5") return "5m";
  return normalized;
}

function toDomainTimeframe(timeframe: string): Timeframe {
  const normalized = normalizeTimeframe(timeframe);
  if (normalized === "1m") return "M1";
  if (normalized === "5m") return "M5";
  if (normalized === "15m") return "M15";
  if (normalized === "1h") return "H1";
  if (normalized === "4h") return "H4";
  if (normalized === "1d") return "D1";
  return "H1";
}

function isHighTimeframe(timeframe: string): boolean {
  return new Set(["1h", "4h", "1d"]).has(normalizeTimeframe(timeframe));
}

function isLowTimeframe(timeframe: string): boolean {
  return new Set(["1m", "5m", "15m"]).has(normalizeTimeframe(timeframe));
}

function intervalToSeconds(interval: string): number {
  const normalized = interval.toLowerCase();
  const amount = Number(normalized.slice(0, -1));
  const unit = normalized.at(-1);
  if (!Number.isFinite(amount) || amount <= 0) return 3600;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 60 * 60;
  if (unit === "d") return amount * 24 * 60 * 60;
  return 3600;
}

function toStructureOverlay(
  event: Record<string, unknown>,
  signal: Record<string, unknown>,
  swing: Record<string, unknown>,
  symbol: string
): Record<string, unknown> {
  return {
    ...baseOverlay(String(signal.id), symbol, String(signal.timeframe ?? "M5"), toSeconds(event.at), "active"),
    price: swing.price,
    direction: signal.direction,
    startAt: toSeconds(swing.candleOpenTime),
    endAt: toSeconds(signal.candleOpenTime ?? event.at),
    brokenSwingId: `${symbol}:${String(signal.timeframe ?? "M5")}:swing:${String(swing.kind)}:${String(swing.candleOpenTime)}`
  };
}

function toSwingOverlay(swing: Record<string, unknown>, symbol: string): Record<string, unknown> {
  return {
    ...baseOverlay(
      `${symbol}:${String(swing.timeframe ?? "M5")}:swing:${String(swing.kind)}:${String(swing.candleOpenTime)}`,
      symbol,
      String(swing.timeframe ?? "M5"),
      toSeconds(swing.candleOpenTime),
      "active"
    ),
    type: swing.kind,
    price: swing.price
  };
}

function baseOverlay(id: string, symbol: string, timeframe: string, createdAt: number, status: string): Record<string, unknown> {
  return {
    id,
    symbol,
    timeframe,
    createdAt,
    updatedAt: createdAt,
    status
  };
}

function toSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.floor(Date.now() / 1000);
  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
}

function getRuntimeStatus(config: AppConfig, account: BinanceFuturesWalletStatus): unknown {
  return {
    symbol: config.symbol,
    executionMode: config.executionMode,
    account,
    marketData: {
      connected: true,
      label: config.binanceTestnet ? "Binance Futures Testnet market data" : "Binance Futures Live market data"
    },
    risk: {
      positionSizingMode: config.positionSizingMode,
      marginPerTrade: config.marginPerTrade,
      leverage: config.leverage
    },
    execution: {
      entryMode: config.entryMode
    },
    strategy: {
      emaPeriod: config.emaPeriod,
      fvgMitigation: config.fvgMitigation,
      ltfFvgEntryMode: config.ltfFvgEntryMode,
      stopLossBufferMode: config.stopLossBufferMode,
      takeProfitMode: config.takeProfitMode
    }
  };
}

async function getAccountStatus(
  config: AppConfig,
  accountClient: BinanceFuturesAccountClient | null,
  cache: BinanceFuturesWalletStatus | null,
  cacheAt: number
): Promise<{ status: BinanceFuturesWalletStatus; cache: BinanceFuturesWalletStatus | null; cacheAt: number }> {
  if (!accountClient) {
    const status: BinanceFuturesWalletStatus = {
      connected: false,
      environment: config.binanceTestnet ? "testnet" : "live",
      label: "BINANCE_API_KEY and BINANCE_API_SECRET are not configured",
      walletBalance: null,
      availableBalance: null,
      asset: "USDT",
      checkedAt: new Date().toISOString()
    };
    return { status, cache: null, cacheAt: 0 };
  }

  if (cache && Date.now() - cacheAt < 15_000) {
    return { status: cache, cache, cacheAt };
  }

  const status = await accountClient.getWalletStatus();
  return { status, cache: status, cacheAt: Date.now() };
}

async function getManualPositions(
  accountClient: BinanceFuturesAccountClient | null,
  symbol: string,
  logger: DecisionLogger
): Promise<BinanceFuturesPositionStatus[]> {
  if (!accountClient) return [];

  try {
    return await accountClient.getOpenPositions(symbol);
  } catch (error) {
    logger.warn("Binance position overlay check failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

async function getAccountActivity(
  accountClient: BinanceFuturesAccountClient | null,
  symbol: string,
  limit: number,
  logger: DecisionLogger
): Promise<{
  connected: boolean;
  positions: BinanceFuturesPositionStatus[];
  openOrders: BinanceFuturesOpenOrderStatus[];
  orderHistory: BinanceFuturesOrderHistoryStatus[];
  tradeHistory: BinanceFuturesTradeHistoryStatus[];
}> {
  if (!accountClient) {
    return {
      connected: false,
      positions: [],
      openOrders: [],
      orderHistory: [],
      tradeHistory: []
    };
  }

  const [positions, openOrders, orderHistory, tradeHistory] = await Promise.all([
    readAccountActivity("positions", () => accountClient.getOpenPositions(symbol), logger),
    readAccountActivity("open orders", () => accountClient.getOpenOrders(symbol), logger),
    readAccountActivity("order history", () => accountClient.getOrderHistory(symbol, limit), logger),
    readAccountActivity("trade history", () => accountClient.getTradeHistory(symbol, limit), logger)
  ]);

  return {
    connected: true,
    positions,
    openOrders,
    orderHistory,
    tradeHistory
  };
}

async function readAccountActivity<T>(label: string, read: () => Promise<T[]>, logger: DecisionLogger): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    logger.warn(`Binance ${label} check failed`, {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

function noCacheHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0"
  };
}
