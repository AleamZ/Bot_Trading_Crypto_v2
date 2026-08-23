import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthService } from "../../application/auth/AuthService.js";
import { InvalidAuthInputError, InvalidCredentialsError, isDuplicateEmailError } from "../../application/auth/AuthService.js";
import type { TradingAccountService } from "../../application/trading-account/TradingAccountService.js";
import { InvalidTradingAccountInputError, TradingAccountNotFoundError, UnsafeTradingAccountDeletionError } from "../../application/trading-account/TradingAccountService.js";
import { BinanceVerificationError } from "../../application/trading-account/BinanceAccountVerifier.js";
import type { TradingRuntimeManager } from "../../application/runtime/TradingRuntimeManager.js";
import type { TradingEngine } from "../../application/engine/TradingEngine.js";
import type { SetupDiagnostic } from "../../application/engine/TradingEngine.js";
import type { MarketScanner } from "../../application/scanner/MarketScanner.js";
import type { TradingRepository } from "../../application/ports/Repositories.js";
import type { DecisionLogger } from "../../application/ports/Logger.js";
import type { AppConfig, TradingSettings } from "../../application/config/AppConfig.js";
import { applyTradingSettings, validateTradingSettings } from "../../application/config/AppConfig.js";
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
import { detectLatestHtfFvg, detectLatestLtfFvg, isFvgInvalidated, isFvgTouched } from "../../domain/fvg/FvgDetector.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import { buildLiquidityState } from "../../domain/liquidity/LiquidityDetector.js";
import { selectExternalLiquidityTarget } from "../../domain/liquidity/LiquidityDetector.js";
import { detectM5StructureSignal } from "../../domain/market-structure/StructureDetector.js";
import { detectSwings } from "../../domain/market-structure/Swing.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { Candle, Timeframe } from "../../domain/market-data/Candle.js";
import type { Direction } from "../../domain/trade/Direction.js";

export interface HttpServerParams {
  port: number;
  config: AppConfig;
  engine: TradingEngine;
  repository: TradingRepository;
  logger: DecisionLogger;
  scanner?: MarketScanner;
  auth: AuthService;
  tradingAccounts?: TradingAccountService;
  runtimeManager?: TradingRuntimeManager;
  marketData?: BinanceFuturesMarketData;
  appState?: OperationalAppState;
  readinessCheck?: () => Promise<boolean>;
  buildInfo?: BuildInfo;
}

export interface OperationalAppState {
  shuttingDown: boolean;
  bootstrapComplete: boolean;
  startedAt: number;
}

export interface BuildInfo {
  version: string;
  gitSha: string | null;
  buildTime: string | null;
}

const metrics = {
  requests: 0,
  errors: 0,
  startedAt: Date.now()
};

export function createHttpHandler(params: HttpServerParams): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  authLimiters.clear();
  let runtimeConfig = params.config;
  const marketData = params.marketData ?? new BinanceFuturesMarketData(runtimeConfig.binanceTestnet);
  const accountClient =
    runtimeConfig.binanceApiKey && runtimeConfig.binanceApiSecret
      ? new BinanceFuturesAccountClient(runtimeConfig.binanceApiKey, runtimeConfig.binanceApiSecret, runtimeConfig.binanceTestnet)
      : null;
  let accountCache: BinanceFuturesWalletStatus | null = null;
  let accountCacheAt = 0;
  let openPositionsCache: BinanceFuturesPositionStatus[] | null = null;
  let openPositionsCacheAt = 0;

  return async (request, response) => {
    let requestCorsHeaders: Record<string, string> = {};
    const requestId = requestIdFor(request);
    const startedAt = Date.now();
    try {
      requestCorsHeaders = corsHeadersFor(request, runtimeConfig);
      requestCorsHeaders["x-request-id"] = requestId;
      if (runtimeConfig.nodeEnv === "production" && request.headers.origin && !requestCorsHeaders["access-control-allow-origin"]) {
        sendJson(response, 403, { error: "CORS_ORIGIN_NOT_ALLOWED", message: "Origin is not allowed.", requestId }, requestCorsHeaders);
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, requestCorsHeaders);
        response.end();
        return;
      }

      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      metrics.requests += 1;
      params.logger.info("HTTP request", { requestId, method: request.method, path: requestUrl.pathname });

      if (requestUrl.pathname === "/health/live" && request.method === "GET") {
        sendJson(response, params.appState?.shuttingDown ? 503 : 200, healthLive(params), requestCorsHeaders);
        return;
      }

      if (requestUrl.pathname === "/health/ready" && request.method === "GET") {
        const dbReady = params.readinessCheck ? await params.readinessCheck() : true;
        const ready = Boolean(dbReady && params.appState?.bootstrapComplete && !params.appState.shuttingDown);
        sendJson(response, ready ? 200 : 503, healthReady(params, dbReady, ready), requestCorsHeaders);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/auth/")) {
        await handleAuthRoute({ request, response, requestUrl, corsHeaders: requestCorsHeaders, auth: params.auth, config: runtimeConfig });
        return;
      }

      const authenticatedUser = await params.auth.currentUser(readCookie(request, sessionCookieName));
      if (!authenticatedUser) {
        sendJson(response, 401, { error: "UNAUTHORIZED", message: "Unauthorized", requestId }, requestCorsHeaders);
        return;
      }

      if (requestUrl.pathname === "/api/system/status" && request.method === "GET") {
        sendJson(response, 200, systemStatus(params), requestCorsHeaders);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/trading-accounts")) {
        if (!params.tradingAccounts) {
          sendJson(response, 503, { error: "Trading account service is unavailable" }, requestCorsHeaders);
          return;
        }
        await handleTradingAccountRoute({
          request,
          response,
          requestUrl,
          corsHeaders: requestCorsHeaders,
          userId: authenticatedUser.id,
          service: params.tradingAccounts,
          config: runtimeConfig,
          marketData,
          ...(params.runtimeManager ? { runtimeManager: params.runtimeManager } : {})
        });
        return;
      }
      // TODO Phase 3: Scope trading resources by authenticated tradingAccountId.

      if (requestUrl.pathname === "/api/snapshot") {
        const store = await params.repository.getDashboardSnapshot();
        const accountStatus = await getAccountStatus(runtimeConfig, accountClient, accountCache, accountCacheAt);
        accountCache = accountStatus.cache;
        accountCacheAt = accountStatus.cacheAt;
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify({ engine: params.engine.getDashboardState(), runtime: getRuntimeStatus(runtimeConfig, accountStatus.status), store }));
        return;
      }

      if (requestUrl.pathname === "/api/binance/klines" || requestUrl.pathname === "/binance/klines") {
        const query = parseKlineQuery(requestUrl, runtimeConfig.symbol);
        const klines = await marketData.getKlines(query.symbol, query.interval, query.limit);
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify({ symbol: query.symbol, interval: query.interval, limit: query.limit, klines }));
        return;
      }

      if (requestUrl.pathname === "/api/bot/events") {
        const symbol = requestUrl.searchParams.get("symbol") ?? runtimeConfig.symbol;
        const limit = clampLimit(requestUrl.searchParams.get("limit"), 200, 500);
        const store = await params.repository.getDashboardSnapshot();
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify({ symbol, limit, events: selectBotEvents(store, symbol, limit) }));
        return;
      }

      if (requestUrl.pathname === "/api/binance/account-activity") {
        const query = parseAccountActivityQuery(requestUrl, runtimeConfig.symbol);
        const activity = await getAccountActivity(accountClient, query.symbol ?? runtimeConfig.symbol, query.limit, params.logger);
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify({ symbol: query.symbol, limit: query.limit, ...activity }));
        return;
      }

      if (requestUrl.pathname === "/api/watchlist") {
        if (request.method === "GET") {
          response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
          response.end(JSON.stringify({ watchlist: runtimeConfig.watchlist }));
          return;
        }

        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const nextWatchlist = Array.isArray(body) ? body : isRecord(body) ? body.watchlist : [];
          const settings = validateTradingSettings({ ...toTradingSettings(runtimeConfig), watchlist: nextWatchlist });
          await assertValidWatchlistSymbols(settings.watchlist, marketData);
          await params.repository.saveTradingSettings(settings);
          runtimeConfig = applyTradingSettings(runtimeConfig, settings);
          params.scanner?.updateConfig(runtimeConfig);
          response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
          response.end(JSON.stringify({ watchlist: runtimeConfig.watchlist }));
          return;
        }
      }

      if (requestUrl.pathname === "/api/watchlist/status") {
        const positionsStatus = await getCachedOpenPositions(accountClient, openPositionsCache, openPositionsCacheAt, params.logger);
        openPositionsCache = positionsStatus.positions;
        openPositionsCacheAt = positionsStatus.cacheAt;
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(
          JSON.stringify({
            watchlist: runtimeConfig.watchlist,
            rows: reconcileWatchlistRows(params.scanner?.getWatchlistStatus() ?? [], positionsStatus.positions, runtimeConfig.executionMode)
          })
        );
        return;
      }

      if (requestUrl.pathname === "/api/market/symbols") {
        const accountId = requestUrl.searchParams.get("accountId");
        const account = accountId && params.tradingAccounts ? await params.tradingAccounts.getOwnedAccount(authenticatedUser.id, accountId) : null;
        const symbols = await marketDataForAccount(account, marketData).getFuturesSymbols();
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify(symbols));
        return;
      }

      if (requestUrl.pathname === "/api/settings") {
        if (request.method === "GET") {
          response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
          response.end(JSON.stringify(toTradingSettings(runtimeConfig)));
          return;
        }

        if (request.method === "PUT") {
          const settings = validateTradingSettings(await readJsonBody(request));
          await assertValidWatchlistSymbols(settings.watchlist, marketData);
          await params.repository.saveTradingSettings(settings);
          runtimeConfig = applyTradingSettings(runtimeConfig, settings);
          params.scanner?.updateConfig(runtimeConfig);
          response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
          response.end(JSON.stringify(settings));
          return;
        }
      }

      if (requestUrl.pathname === "/api/analysis") {
        const query = parseAccountActivityQuery(requestUrl, runtimeConfig.symbol);
        const symbol = query.symbol ?? runtimeConfig.symbol;
        const analysis = await buildSymbolAnalysis(symbol, runtimeConfig, marketData);
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify(analysis));
        return;
      }

      if (requestUrl.pathname === "/api/chart/overlays") {
        const query = parseKlineQuery(requestUrl, runtimeConfig.symbol);
        const store = await params.repository.getDashboardSnapshot();
        const candles = await marketData.getKlines(query.symbol, query.interval, query.limit);
        const overlays = await buildChartOverlays({
          store,
          engineState: params.engine.getDashboardState(),
          symbol: query.symbol,
          timeframe: query.interval,
          candles,
          emaPeriod: runtimeConfig.emaPeriod,
      riskPerTradeUsdt: runtimeConfig.riskPerTradeUsdt,
      maxLeverage: runtimeConfig.maxLeverage,
      maxMarginUsagePercent: runtimeConfig.maxMarginUsagePercent,
          manualPositions: await getManualPositions(accountClient, query.symbol, params.logger)
        });
        response.writeHead(200, noCacheHeaders("application/json", requestCorsHeaders));
        response.end(JSON.stringify(overlays));
        return;
      }

      response.writeHead(404, noCacheHeaders("application/json", requestCorsHeaders));
      response.end(JSON.stringify({ error: "NOT_FOUND", message: "API route not found", requestId }));
    } catch (error) {
      metrics.errors += 1;
      const duplicateEmail = isDuplicateEmailError(error);
      const status =
        error instanceof PayloadTooLargeError
          ? 413
          : error instanceof InvalidAuthInputError || error instanceof InvalidTradingAccountInputError
          ? 400
          : duplicateEmail
            ? 409
            : error instanceof InvalidCredentialsError
              ? 401
              : error instanceof TradingAccountNotFoundError
                ? 404
                : error instanceof UnsafeTradingAccountDeletionError
                  ? 409
                  : error instanceof BinanceVerificationError
                    ? binanceErrorStatus(error)
                    : 400;
      const message =
        error instanceof InvalidAuthInputError ||
        error instanceof InvalidTradingAccountInputError ||
        error instanceof PayloadTooLargeError ||
        duplicateEmail ||
        error instanceof InvalidCredentialsError ||
        error instanceof TradingAccountNotFoundError ||
        error instanceof UnsafeTradingAccountDeletionError ||
        error instanceof BinanceVerificationError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      params.logger.error("HTTP request failed", {
        requestId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: runtimeConfig.nodeEnv === "production" ? undefined : error instanceof Error ? error.stack : undefined
      });
      sendJson(response, status, errorBody(errorCodeForStatus(status, error), message, requestId, runtimeConfig), requestCorsHeaders);
    }
  };
}

export function startHttpServer(params: HttpServerParams): ReturnType<typeof createServer> {
  const server = createServer(createHttpHandler(params));
  server.listen(params.port, "0.0.0.0", () => {
    params.logger.info(`API listening on http://localhost:${params.port}`);
  });
  return server;
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new PayloadTooLargeError("Request body is too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? JSON.parse(body) : {};
}

function toTradingSettings(config: AppConfig): TradingSettings {
  const {
    port: _port,
    nodeEnv: _nodeEnv,
    executionMode: _executionMode,
    logLevel: _logLevel,
    corsOrigins: _corsOrigins,
    databaseUrl: _databaseUrl,
    sessionSecret: _sessionSecret,
    binanceCredentialEncryptionKey: _binanceCredentialEncryptionKey,
    binanceApiKey: _binanceApiKey,
    binanceApiSecret: _binanceApiSecret,
    binanceTestnet: _binanceTestnet,
    reconciliationIntervalMs: _reconciliationIntervalMs,
    binanceRetryMaxAttempts: _binanceRetryMaxAttempts,
    binanceRetryBaseDelayMs: _binanceRetryBaseDelayMs,
    postgresPoolMax: _postgresPoolMax,
    ...settings
  } = config;
  return settings;
}

function corsHeadersFor(request: IncomingMessage, config: AppConfig): Record<string, string> {
  const origin = request.headers.origin;
  const headers: Record<string, string> = {
    "vary": "Origin"
  };
  if (typeof origin === "string" && config.corsOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    headers["access-control-allow-headers"] = "content-type,x-request-id";
    headers["access-control-allow-credentials"] = "true";
  }
  return headers;
}

const sessionCookieName = "smc_session";
const authLimiters = new Map<string, { count: number; resetAt: number }>();

class PayloadTooLargeError extends Error {}

function requestIdFor(request: IncomingMessage): string {
  const incoming = request.headers["x-request-id"];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{8,96}$/.test(value)) return value;
  return crypto.randomUUID();
}

function healthLive(params: HttpServerParams): Record<string, unknown> {
  return {
    status: params.appState?.shuttingDown ? "shutting_down" : "ok",
    service: "smc-futures-api",
    uptimeSeconds: Math.floor(process.uptime()),
    version: params.buildInfo?.version ?? "0.0.0",
    gitSha: params.buildInfo?.gitSha ?? null
  };
}

function healthReady(params: HttpServerParams, dbReady: boolean, ready: boolean): Record<string, unknown> {
  return {
    status: ready ? "ok" : "not_ready",
    service: "smc-futures-api",
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: {
      database: dbReady ? "ok" : "unavailable",
      bootstrap: params.appState?.bootstrapComplete ? "complete" : "pending",
      shutdown: params.appState?.shuttingDown ? "active" : "inactive"
    }
  };
}

function systemStatus(params: HttpServerParams): Record<string, unknown> {
  const runtime = params.runtimeManager?.getOperationalStatus();
  return {
    status: params.appState?.shuttingDown ? "shutting_down" : "ok",
    service: "smc-futures-api",
    uptimeSeconds: Math.floor(process.uptime()),
    version: params.buildInfo?.version ?? "0.0.0",
    gitSha: params.buildInfo?.gitSha ?? null,
    buildTime: params.buildInfo?.buildTime ?? null,
    http: {
      requests: metrics.requests,
      errors: metrics.errors,
      startedAt: new Date(metrics.startedAt).toISOString()
    },
    runtime: runtime ?? {
      runtimeCount: 0,
      readyAccounts: 0,
      degradedAccounts: 0,
      disconnectedAccounts: 0,
      recoveringAccounts: 0,
      shuttingDown: Boolean(params.appState?.shuttingDown),
      reconciliationSuccess: 0,
      reconciliationFailure: 0
    }
  };
}

function errorCodeForStatus(status: number, error: unknown): string {
  if (error instanceof PayloadTooLargeError) return "PAYLOAD_TOO_LARGE";
  if (error instanceof UnsafeTradingAccountDeletionError) return error.code;
  if (status === 401) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status >= 500) return "INTERNAL_ERROR";
  return "BAD_REQUEST";
}

function errorBody(code: string, message: string, requestId: string, config: AppConfig): Record<string, unknown> {
  if (config.nodeEnv !== "production") {
    return { error: message, code, message, requestId };
  }
  return {
    error: code,
    message: code === "INTERNAL_ERROR" ? "Internal server error" : message,
    requestId
  };
}

async function handleAuthRoute(params: {
  request: IncomingMessage;
  response: ServerResponse;
  requestUrl: URL;
  corsHeaders: Record<string, string>;
  auth: AuthService;
  config: AppConfig;
}): Promise<void> {
  const { request, response, requestUrl, corsHeaders, auth, config } = params;

  if (requestUrl.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await auth.currentUser(readCookie(request, sessionCookieName));
    if (!user) {
      sendJson(response, 401, { user: null }, corsHeaders);
      return;
    }
    sendJson(response, 200, { user }, corsHeaders);
    return;
  }

  if (requestUrl.pathname === "/api/auth/logout" && request.method === "POST") {
    await auth.logout(readCookie(request, sessionCookieName));
    sendJson(response, 200, { ok: true }, corsHeaders, [clearSessionCookie(config)]);
    return;
  }

  if (requestUrl.pathname === "/api/auth/register" && request.method === "POST") {
    assertAuthRateLimit(request, "register");
    const result = await auth.register(await readJsonBody(request));
    sendJson(response, 201, { user: result.user }, corsHeaders, [setSessionCookie(result.sessionToken, result.expiresAt, config)]);
    return;
  }

  if (requestUrl.pathname === "/api/auth/login" && request.method === "POST") {
    assertAuthRateLimit(request, "login");
    const result = await auth.login(await readJsonBody(request));
    sendJson(response, 200, { user: result.user }, corsHeaders, [setSessionCookie(result.sessionToken, result.expiresAt, config)]);
    return;
  }

  sendJson(response, 404, { error: "Auth route not found" }, corsHeaders);
}

async function handleTradingAccountRoute(params: {
  request: IncomingMessage;
  response: ServerResponse;
  requestUrl: URL;
  corsHeaders: Record<string, string>;
  userId: string;
  service: TradingAccountService;
  runtimeManager?: TradingRuntimeManager;
  config: AppConfig;
  marketData: BinanceFuturesMarketData;
}): Promise<void> {
  const { request, response, requestUrl, corsHeaders, userId, service, runtimeManager, config, marketData } = params;
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  const accountId = parts[2] ?? null;
  const child = parts[3] ?? null;

  if (parts.length === 2 && request.method === "GET") {
    sendJson(response, 200, { accounts: await service.listAccounts(userId) }, corsHeaders);
    return;
  }

  if (parts.length === 2 && request.method === "POST") {
    sendJson(response, 201, { account: await service.createAccount(userId, await readJsonBody(request)) }, corsHeaders);
    return;
  }

  if (!accountId) {
    sendJson(response, 404, { error: "Trading account route not found" }, corsHeaders);
    return;
  }

  if (parts.length === 3 && request.method === "GET") {
    sendJson(response, 200, { account: await service.getAccount(userId, accountId) }, corsHeaders);
    return;
  }

  if (parts.length === 3 && request.method === "DELETE") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    await runtimeManager.prepareAccountDeletion(accountId);
    try {
      await service.hardDeleteAccount(userId, accountId);
      await runtimeManager.completeAccountDeletion(accountId);
      response.writeHead(204, noCacheHeaders("application/json", corsHeaders));
      response.end();
    } catch (error) {
      runtimeManager.cancelAccountDeletion(accountId);
      throw error;
    }
    return;
  }

  if (child === "settings" && parts.length === 4 && request.method === "GET") {
    sendJson(response, 200, await service.getSettings(userId, accountId), corsHeaders);
    return;
  }

  if (child === "settings" && parts.length === 4 && request.method === "PUT") {
    const settings = await service.saveSettings(userId, accountId, await readJsonBody(request));
    await runtimeManager?.refreshRuntime(accountId);
    sendJson(response, 200, settings, corsHeaders);
    return;
  }

  if (child === "real-execution-mode" && parts.length === 4 && request.method === "GET") {
    const account = await service.getOwnedAccount(userId, accountId);
    if (account.mode !== "REAL") throw new InvalidTradingAccountInputError("REAL execution mode is only available for REAL accounts");
    const settings = await service.getSettings(userId, accountId);
    sendJson(
      response,
      200,
      {
        mode: settings.realExecutionMode ?? "LOCKED",
        masterLiveExecutionEnabled: Boolean(config.realLiveExecutionEnabled),
        liveExecutionLocked: !config.realLiveExecutionEnabled
      },
      corsHeaders
    );
    return;
  }

  if (child === "real-execution-mode" && parts.length === 4 && request.method === "PUT") {
    const account = await service.getOwnedAccount(userId, accountId);
    if (account.mode !== "REAL") throw new InvalidTradingAccountInputError("REAL execution mode is only available for REAL accounts");
    const body = await readJsonBody(request);
    const mode = isRecord(body) ? body.mode : null;
    if (mode !== "LOCKED" && mode !== "DRY_RUN" && mode !== "APPROVAL_REQUIRED") throw new InvalidTradingAccountInputError("Invalid REAL execution mode");
    const current = await service.getSettings(userId, accountId);
    await service.saveSettings(userId, accountId, { ...current, realExecutionMode: mode });
    await runtimeManager?.refreshRuntime(accountId);
    sendJson(
      response,
      200,
      {
        mode,
        masterLiveExecutionEnabled: Boolean(config.realLiveExecutionEnabled),
        liveExecutionLocked: !config.realLiveExecutionEnabled
      },
      corsHeaders
    );
    return;
  }

  if (child === "watchlist" && parts.length === 4 && request.method === "GET") {
    sendJson(response, 200, { watchlist: await service.getWatchlist(userId, accountId) }, corsHeaders);
    return;
  }

  if (child === "watchlist" && parts.length === 4 && request.method === "PUT") {
    const watchlist = await service.saveWatchlist(userId, accountId, await readJsonBody(request));
    await runtimeManager?.refreshRuntime(accountId);
    sendJson(response, 200, { watchlist }, corsHeaders);
    return;
  }

  if (child === "snapshot" && parts.length === 4 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    const account = await service.getAccount(userId, accountId);
    const [connection, binanceAccount, snapshot] = await Promise.all([
      service.getConnection(userId, accountId),
      service.getBinanceAccount(userId, accountId),
      runtimeManager.getSnapshot(accountId)
    ]);
    sendJson(
      response,
      200,
      {
        account,
        connection,
        binanceAccount,
        engine: snapshot?.engine ?? null,
        runtime: getRuntimeStatus({ ...config, executionMode: account.mode === "DEMO" ? "testnet" : "live" }, {
          connected: binanceAccount.connected,
          environment: binanceAccount.environment === "TESTNET" ? "testnet" : "live",
          label: connection.status,
          walletBalance: binanceAccount.walletBalance,
          availableBalance: binanceAccount.availableBalance,
          asset: "USDT",
          checkedAt: binanceAccount.checkedAt
        }),
        store: snapshot.store,
        watchlistRows: snapshot.watchlistStatus,
        runtimeHealth: snapshot.runtimeHealth,
        execution: snapshot.execution,
        realReadiness: snapshot.realReadiness,
        dailyRisk: snapshot.dailyRisk,
        accountProtection: snapshot.accountProtection
      },
      corsHeaders
    );
    return;
  }

  if (child === "readiness" && parts.length === 4 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    const symbol = requestUrl.searchParams.get("symbol") ?? (await service.getSettings(userId, accountId)).symbol;
    sendJson(response, 200, { readiness: await runtimeManager.getRealReadiness(accountId, symbol) }, corsHeaders);
    return;
  }

  if (child === "symbol-rules" && parts.length === 4 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    const symbol = requestUrl.searchParams.get("symbol") ?? (await service.getSettings(userId, accountId)).symbol;
    sendJson(response, 200, { symbolRules: await runtimeManager.getSymbolRules(accountId, symbol) }, corsHeaders);
    return;
  }

  if (child === "watchlist" && parts[4] === "status" && parts.length === 5 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    sendJson(response, 200, { rows: (await runtimeManager.getSnapshot(accountId)).watchlistStatus }, corsHeaders);
    return;
  }

  if (child === "analysis" && parts.length === 4 && request.method === "GET") {
    const account = await service.getOwnedAccount(userId, accountId);
    const query = parseAccountActivityQuery(requestUrl, config.symbol);
    const symbol = query.symbol ?? config.symbol;
    const settings = await service.getSettings(userId, accountId);
    const activePosition = runtimeManager ? (await runtimeManager.getAccountActivity(accountId, symbol, 20)).positions.find((position) => position.symbol === symbol && position.quantity > 0) : null;
    if (activePosition) {
      sendJson(response, 200, buildActivePositionAnalysis(symbol, activePosition), corsHeaders);
      return;
    }
    const diagnostic = runtimeManager ? await runtimeManager.getSetupDiagnostic(accountId, symbol) : null;
    const symbolRules = runtimeManager ? await runtimeManager.getSymbolRules(accountId, symbol).catch(() => null) : null;
    const analysis = await buildSymbolAnalysis(symbol, { ...config, ...settings, symbol }, marketDataForAccount(account, marketData), diagnostic, {
      symbolTickSize: symbolRules?.tickSize ?? 0.1
    });
    const dailyRisk = runtimeManager ? await runtimeManager.getDailyRiskStatus(accountId) : null;
    const accountProtection = runtimeManager ? await runtimeManager.getAccountProtectionStatus(accountId) : null;
    sendJson(response, 200, { ...analysis, dailyRisk, accountProtection }, corsHeaders);
    return;
  }

  if (child === "chart" && parts[4] === "overlays" && parts.length === 5 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    const account = await service.getOwnedAccount(userId, accountId);
    const query = parseKlineQuery(requestUrl, config.symbol);
    const accountMarketData = marketDataForAccount(account, marketData);
    const [settings, snapshot, candles, manualPositions] = await Promise.all([
      service.getSettings(userId, accountId),
      runtimeManager.getSnapshot(accountId),
      accountMarketData.getKlines(query.symbol, query.interval, query.limit),
      runtimeManager.getManualPositions(accountId, query.symbol)
    ]);
    sendJson(
      response,
      200,
      await buildChartOverlays({
        store: snapshot.store,
        engineState: snapshot.engine,
        symbol: query.symbol,
        timeframe: query.interval,
        candles,
        emaPeriod: settings.emaPeriod,
        riskPerTradeUsdt: settings.riskPerTradeUsdt,
        maxLeverage: settings.maxLeverage,
        maxMarginUsagePercent: settings.maxMarginUsagePercent,
        manualPositions,
        includeBotPositionOverlays: account.mode === "DEMO"
      }),
      corsHeaders
    );
    return;
  }

  if (child === "chart" && parts[4] === "account-activity" && parts.length === 5 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    const query = parseAccountActivityQuery(requestUrl);
    sendJson(response, 200, { symbol: query.symbol, limit: query.limit, ...(await runtimeManager.getAccountActivity(accountId, query.symbol, query.limit)) }, corsHeaders);
    return;
  }

  if (child === "executions" && parts.length === 4 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    const limit = clampLimit(requestUrl.searchParams.get("limit"), 100, 500);
    sendJson(response, 200, { executions: await runtimeManager.listExecutions(accountId, limit) }, corsHeaders);
    return;
  }

  if (child === "executions" && parts[4] && parts.length === 5 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    await service.getOwnedAccount(userId, accountId);
    sendJson(response, 200, { events: await runtimeManager.listExecutionAuditEvents(accountId, parts[4], 200) }, corsHeaders);
    return;
  }

  if ((child === "execution-proposals" || child === "real-execution-proposals") && parts.length === 4 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    const account = await service.getOwnedAccount(userId, accountId);
    if (account.mode !== "REAL") throw new InvalidTradingAccountInputError("REAL execution proposals are only available for REAL accounts");
    const limit = clampLimit(requestUrl.searchParams.get("limit"), 100, 500);
    const status = requestUrl.searchParams.get("status");
    const proposals = await runtimeManager.listRealExecutionProposals(accountId, limit);
    sendJson(response, 200, { proposals: status ? proposals.filter((proposal) => proposal.status === status) : proposals }, corsHeaders);
    return;
  }

  if ((child === "execution-proposals" || child === "real-execution-proposals") && parts[4] && parts.length === 5 && request.method === "GET") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    const account = await service.getOwnedAccount(userId, accountId);
    if (account.mode !== "REAL") throw new InvalidTradingAccountInputError("REAL execution proposals are only available for REAL accounts");
    const proposal = await runtimeManager.getRealExecutionProposal(accountId, parts[4]);
    sendJson(response, proposal ? 200 : 404, proposal ? { proposal } : { error: "PROPOSAL_NOT_FOUND" }, corsHeaders);
    return;
  }

  if ((child === "execution-proposals" || child === "real-execution-proposals") && parts[4] && parts[5] && parts.length === 6 && request.method === "POST") {
    if (!runtimeManager) {
      sendJson(response, 503, { error: "Trading runtime manager is unavailable" }, corsHeaders);
      return;
    }
    const account = await service.getOwnedAccount(userId, accountId);
    if (account.mode !== "REAL") throw new InvalidTradingAccountInputError("REAL execution proposals are only available for REAL accounts");
    const action = parts[5];
    const proposal =
      action === "approve"
        ? await runtimeManager.approveRealExecutionProposal(accountId, parts[4], userId)
        : action === "reject"
          ? await runtimeManager.rejectRealExecutionProposal(accountId, parts[4])
          : action === "cancel"
            ? await runtimeManager.cancelRealExecutionProposal(accountId, parts[4])
            : null;
    if (!proposal) {
      sendJson(response, 404, { error: "Proposal action not found" }, corsHeaders);
      return;
    }
    sendJson(response, 200, { proposal }, corsHeaders);
    return;
  }

  if (child === "binance-connection" && parts.length === 4 && request.method === "GET") {
    sendJson(response, 200, { connection: await service.getConnection(userId, accountId) }, corsHeaders);
    return;
  }

  if (child === "binance-connection" && parts.length === 4 && request.method === "PUT") {
    sendJson(response, 200, await service.saveConnection(userId, accountId, await readJsonBody(request)), corsHeaders);
    await runtimeManager?.disableExecution(accountId);
    await runtimeManager?.ensureRuntime(accountId);
    return;
  }

  if (child === "binance-connection" && parts.length === 4 && request.method === "DELETE") {
    sendJson(response, 200, { connection: await service.disconnect(userId, accountId) }, corsHeaders);
    await runtimeManager?.disableExecution(accountId);
    return;
  }

  if (child === "binance-connection" && parts[4] === "test" && parts.length === 5 && request.method === "POST") {
    sendJson(response, 200, await service.testConnection(userId, accountId, await readJsonBody(request)), corsHeaders);
    return;
  }

  if (child === "binance-account" && parts.length === 4 && request.method === "GET") {
    sendJson(response, 200, { account: await service.getBinanceAccount(userId, accountId) }, corsHeaders);
    return;
  }

  sendJson(response, 404, { error: "Trading account route not found" }, corsHeaders);
}

function binanceErrorStatus(error: BinanceVerificationError): number {
  if (error.code === "BINANCE_UNAVAILABLE") return 503;
  if (error.code === "INVALID_ACCOUNT_MODE") return 400;
  return 422;
}

function marketDataForAccount(account: { mode: "DEMO" | "REAL" } | null, fallback: BinanceFuturesMarketData): BinanceFuturesMarketData {
  if (!account) return fallback;
  return new BinanceFuturesMarketData(account.mode === "DEMO");
}

function assertAuthRateLimit(request: IncomingMessage, action: string): void {
  const key = `${action}:${request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "unknown"}`;
  const now = Date.now();
  const current = authLimiters.get(key);
  if (!current || current.resetAt <= now) {
    authLimiters.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }

  current.count += 1;
  if (current.count > 20) {
    throw new InvalidAuthInputError("Too many authentication attempts. Please try again later.");
  }
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function setSessionCookie(token: string, expiresAt: string, config: AppConfig): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    sameSiteAttribute(),
    secureCookieAttribute(config),
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`
  ]
    .filter(Boolean)
    .join("; ");
}

function clearSessionCookie(config: AppConfig): string {
  return [`${sessionCookieName}=`, "Path=/", "HttpOnly", sameSiteAttribute(), secureCookieAttribute(config), "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"]
    .filter(Boolean)
    .join("; ");
}

function sameSiteAttribute(): string {
  if (process.env.NODE_ENV === "production") return "SameSite=None";
  return "SameSite=Lax";
}

function secureCookieAttribute(config: AppConfig): string {
  return process.env.NODE_ENV === "production" || config.corsOrigins.some((origin) => origin.startsWith("https://")) ? "Secure" : "";
}

function sendJson(response: ServerResponse, status: number, body: unknown, corsHeaders: Record<string, string>, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = noCacheHeaders("application/json", corsHeaders);
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

async function assertValidWatchlistSymbols(watchlist: string[], marketData: BinanceFuturesMarketData): Promise<void> {
  const symbols = await marketData.getFuturesSymbols();
  const valid = new Set(symbols.map((item) => item.symbol));
  const invalid = watchlist.filter((symbol) => !valid.has(symbol));
  if (invalid.length > 0) {
    throw new Error(`Invalid futures symbols: ${invalid.join(", ")}`);
  }
}

function parseAccountActivityQuery(url: URL, defaultSymbol?: string): { symbol: string | undefined; limit: number } {
  const rawSymbol = url.searchParams.get("symbol") ?? defaultSymbol;
  const symbol = rawSymbol ? rawSymbol.toUpperCase() : undefined;
  const limit = clampLimit(url.searchParams.get("limit"), 100, 500);

  if (symbol && !/^[A-Z0-9]{5,20}$/.test(symbol)) {
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
  riskPerTradeUsdt: number;
  maxLeverage: number;
  maxMarginUsagePercent: number;
  manualPositions: BinanceFuturesPositionStatus[];
  includeBotPositionOverlays?: boolean;
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
    riskPerTradeUsdt: params.riskPerTradeUsdt,
    maxLeverage: params.maxLeverage,
    includeBotPositionOverlays: params.includeBotPositionOverlays ?? true
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

function buildActivePositionAnalysis(symbol: string, position: BinanceFuturesPositionStatus) {
  return {
    symbol,
    checkedAt: new Date().toISOString(),
    analysisSource: "active-position",
    setupState: "ORDER_PLACED",
    setupStatus: "MANAGING_TRADE",
    trend: { direction: position.side === "long" ? "bullish" : "bearish", ema: null, close: null, reason: "Active Binance Futures position" },
    summary: "Position Open",
    conditions: [],
    riskManagement: { final: "BLOCKED", reason: "Active position; entry scanning paused", checks: [], decision: null },
    plan: null,
    position: {
      side: position.side === "long" ? "LONG" : "SHORT",
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      unrealizedProfit: position.unrealizedProfit,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit
    }
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
  activeLtfFvgCluster: Fvg[];
  frozenProtectiveCluster: Fvg[];
  plan: EntryPlan | null;
  entryDetail: string | null;
  invalidatedConditionId: string | null;
  invalidatedReason: string | null;
}

export async function buildSymbolAnalysis(
  symbol: string,
  config: AppConfig,
  marketData: BinanceFuturesMarketData,
  canonicalSetup: SetupDiagnostic | null = null,
  options: { symbolTickSize?: number } = {}
): Promise<{
  symbol: string;
  checkedAt: string;
  analysisSource: "runtime" | "diagnostic-fallback";
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
  fvgLifecycle: unknown;
}> {
  const [h1Candles, m5Candles] = await Promise.all([
    marketData.getClosedCandles(symbol, "H1", Math.max(config.emaPeriod + 80, 160)),
    marketData.getClosedCandles(symbol, "M5", 360)
  ]);
  const trend = detectH1Trend(h1Candles, config.emaPeriod);
  const setup =
    canonicalSetup?.symbol === symbol && canonicalSetup.setupKey
      ? setupFromDiagnostic(symbol, canonicalSetup)
      : buildAnalysisLifecycle(symbol, h1Candles, m5Candles, config, options.symbolTickSize ?? 0.1);
  const analysisSource = canonicalSetup?.symbol === symbol && canonicalSetup.setupKey ? "runtime" : "diagnostic-fallback";
  const conditions = buildLifecycleConditions(setup, config);
  const riskManagement = buildAnalysisRiskManagement(setup, config);

  return {
    symbol,
    checkedAt: new Date().toISOString(),
    analysisSource,
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
    plan: setup.plan,
    fvgLifecycle: {
      htf: {
        fvg: setup.htfFvg,
        firstTouchedAt: setup.htfMitigatedAt,
        lifecycleState: setup.htfFvg?.status ?? null
      },
      ltf: {
        activeClusterId: setup.signal ? `${symbol}:${setup.signal.id}` : null,
        activeCluster: setup.activeLtfFvgCluster,
        frozenProtectiveCluster: setup.frozenProtectiveCluster,
        triggeringFvg: setup.ltfFvg,
        firstTouchedAt: setup.ltfMitigatedAt
      },
      entryPlan: {
        structuralStopBoundary: setup.plan?.structuralStopBoundary ?? null,
        appliedBuffer: setup.plan?.stopLossBuffer ?? null,
        targetRiskUsdt: config.riskPerTradeUsdt
      }
    }
  };
}

function setupFromDiagnostic(symbol: string, diagnostic: SetupDiagnostic): AnalysisSetupContext {
  const htfFvg = diagnostic.htfFvg;
  const ltfFvg = diagnostic.ltfFvg;
  const htfMitigatedAt = htfFvg?.mitigatedAt ?? null;
  const ltfMitigatedAt = ltfFvg?.mitigatedAt ?? null;
  const state = analysisStateFromDiagnostic(diagnostic);
  return {
    id: diagnostic.setupKey ?? `${symbol}:runtime`,
    state,
    direction: diagnostic.trend === "neutral" ? htfFvg?.direction ?? null : diagnostic.trend,
    trendReason: diagnostic.trend === "neutral" ? "Runtime has no active EMA trend" : `Runtime scanner trend is ${diagnostic.trend}`,
    htfFvg,
    htfMitigatedAt,
    signal: diagnostic.ltfSignal,
    ltfFvg,
    ltfMitigatedAt,
    activeLtfFvgCluster: diagnostic.activeLtfFvgCluster,
    frozenProtectiveCluster: diagnostic.frozenProtectiveCluster,
    plan: diagnostic.invariantOk ? diagnostic.entryPlan : null,
    entryDetail: diagnostic.invariantOk ? null : "Runtime setup is missing required ReadyToEnter evidence",
    invalidatedConditionId: diagnostic.state === "Archived" ? invalidatedConditionFromDiagnostic(diagnostic) : null,
    invalidatedReason: diagnostic.state === "Archived" ? "Runtime scanner archived the previous setup" : null
  };
}

function analysisStateFromDiagnostic(diagnostic: SetupDiagnostic): AnalysisSetupState {
  if (diagnostic.state === "Archived") return "INVALIDATED";
  if (!diagnostic.htfFvg) return diagnostic.trend === "neutral" ? "WAITING_HTF_CONTEXT" : "WAITING_HTF_FVG";
  if (!diagnostic.htfFvg.mitigatedAt) return "WAITING_HTF_MITIGATION";
  if (!diagnostic.ltfSignal) return "WAITING_M5_BOS";
  if (!diagnostic.ltfFvg) return "WAITING_M5_FVG";
  if (!diagnostic.ltfFvg.mitigatedAt) return "WAITING_M5_PULLBACK";
  if (diagnostic.entryPlan && diagnostic.invariantOk) return "READY_TO_ENTRY";
  return "WAITING_M5_PULLBACK";
}

function invalidatedConditionFromDiagnostic(diagnostic: SetupDiagnostic): string {
  if (diagnostic.ltfFvg?.status === "invalidated") return "m5-fvg-pullback";
  if (diagnostic.htfFvg?.status === "invalidated") return "htf-fvg-first-touch";
  return "entry-plan";
}

function buildAnalysisLifecycle(
  symbol: string,
  h1Input: readonly Candle[],
  m5Input: readonly Candle[],
  config: AppConfig,
  symbolTickSize: number
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
    const result = processAnalysisM5Candle(setup, candle, h1Candles, m5Candles, config, symbolTickSize);
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
  const trend = detectH1Trend(h1Candles, config.emaPeriod);
  let invalidatedSetup: AnalysisSetupContext | null = null;
  let invalidatedHtfFvgId: string | null = null;
  if (trend.direction !== "neutral" && setup.direction && setup.direction !== trend.direction) {
    setup = {
      ...createEmptyAnalysisSetup(candle.symbol),
      state: "WAITING_HTF_FVG",
      direction: trend.direction,
      trendReason: trend.reason
    };
  }

  if (setup.htfFvg && ["WAITING_HTF_MITIGATION", "WAITING_M5_BOS", "WAITING_M5_FVG", "WAITING_M5_PULLBACK"].includes(setup.state)) {
    if (isFvgInvalidated(setup.htfFvg, candle)) {
      invalidatedHtfFvgId = setup.htfFvg.id;
      invalidatedSetup = invalidateAnalysisSetup(setup, "htf-fvg-first-touch", "HTF FVG bị invalidated bởi H1 close phá boundary đối diện");
      setup = createEmptyAnalysisSetup(candle.symbol);
    }
  }

  if (setup.state === "WAITING_HTF_CONTEXT") {
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
    if (htfFvg && htfFvg.id !== invalidatedHtfFvgId) {
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
      invalidatedHtfFvgId = setup.htfFvg.id;
      invalidatedSetup = invalidateAnalysisSetup(setup, "htf-fvg-first-touch", "HTF FVG bị invalidated trước first touch");
      setup = createEmptyAnalysisSetup(candle.symbol);
      if (trend.direction !== "neutral") {
        setup = {
          ...setup,
          state: "WAITING_HTF_FVG",
          direction: trend.direction,
          trendReason: trend.reason
        };
        const htfFvg = detectLatestHtfFvg(h1Candles, trend.direction);
        if (htfFvg && htfFvg.id !== invalidatedHtfFvgId) {
          setup = {
            ...setup,
            id: htfFvg.id,
            state: "WAITING_HTF_MITIGATION",
            htfFvg
          };
        }
      }
      return { setup, invalidated: invalidatedSetup };
    }

    if (isFvgTouched(setup.htfFvg, candle)) {
      setup = {
        ...setup,
        state: "WAITING_M5_BOS",
        htfMitigatedAt: candle.closeTime
      };
    }
  }

  return { setup, invalidated: invalidatedSetup };
}

function processAnalysisM5Candle(
  setup: AnalysisSetupContext,
  candle: Candle,
  h1Candles: readonly Candle[],
  m5Candles: readonly Candle[],
  config: AppConfig,
  symbolTickSize: number
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
    if (ltfFvg && !setup.activeLtfFvgCluster.some((fvg) => fvg.id === ltfFvg.id)) {
      setup = {
        ...setup,
        state: "WAITING_M5_PULLBACK",
        ltfFvg,
        activeLtfFvgCluster: [...setup.activeLtfFvgCluster, ltfFvg]
      };
    }
  }

  if (setup.state === "WAITING_M5_PULLBACK" && setup.signal) {
    const ltfFvg = detectLatestLtfFvg(m5Candles, direction, setup.signal.candleOpenTime);
    if (ltfFvg && !setup.activeLtfFvgCluster.some((fvg) => fvg.id === ltfFvg.id)) {
      setup = {
        ...setup,
        ltfFvg,
        activeLtfFvgCluster: [...setup.activeLtfFvgCluster, ltfFvg]
      };
    }

    const triggeringFvg = setup.activeLtfFvgCluster.find((fvg) => fvg.status === "untouched" && isFvgTouched(fvg, candle));
    if (triggeringFvg) {
      const touched = { ...triggeringFvg, status: "touched" as const, firstTouchedAt: candle.closeTime, activatedAt: candle.closeTime };
      const frozenCluster = setup.activeLtfFvgCluster.map((fvg) => (fvg.id === touched.id ? touched : fvg));
      const planCheck = calculateAnalysisEntryPlan(direction, touched, frozenCluster, h1Candles, m5Candles, config, symbolTickSize);
      if (!planCheck.plan) {
        const invalidated = invalidateAnalysisSetup(
          { ...setup, ltfFvg: touched, ltfMitigatedAt: candle.closeTime, frozenProtectiveCluster: frozenCluster, entryDetail: planCheck.detail },
          "entry-plan",
          planCheck.detail
        );
        return { setup: createEmptyAnalysisSetup(candle.symbol), invalidated };
      }

      setup = {
        ...setup,
        state: "READY_TO_ENTRY",
        ltfFvg: touched,
        ltfMitigatedAt: candle.closeTime,
        frozenProtectiveCluster: frozenCluster,
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
    activeLtfFvgCluster: [],
    frozenProtectiveCluster: [],
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
      "htf-fvg-first-touch",
      "HTF FVG first touch",
      setup.htfMitigatedAt ? "PASSED" : statusFor(setup, "htf-fvg-first-touch"),
      setup.htfMitigatedAt && setup.htfFvg ? `PASSED tại ${formatServerDate(setup.htfMitigatedAt)} · ${describeFvg(setup.htfFvg)}` : "Waiting for first wick touch of nearest FVG boundary"
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
      "M5 FVG first touch",
      setup.ltfMitigatedAt ? "PASSED" : statusFor(setup, "m5-fvg-pullback"),
      setup.ltfMitigatedAt && setup.ltfFvg ? `PASSED tại ${formatServerDate(setup.ltfMitigatedAt)} · ${describeFvg(setup.ltfFvg)}` : "Waiting for first wick touch of an active-cluster M5 FVG"
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
    riskCheck("max-open-positions", "Max Open Positions", "WAITING", "Waiting for strategy entry plan")
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
    symbolRules: {
      symbol: setup.id,
      status: "TRADING",
      contractType: null,
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: null,
      quantityPrecision: null,
      tickSize: 0.1,
      minPrice: null,
      maxPrice: null,
      stepSize: 0.001,
      minQty: 0,
      maxQty: null,
      minNotional: null,
      maxLeverage: config.maxLeverage,
      supportedOrderTypes: ["MARKET", "LIMIT"]
    },
    riskPerTradeUsdt: config.riskPerTradeUsdt,
    maxLeverage: config.maxLeverage,
    maxMarginUsagePercent: config.maxMarginUsagePercent,
    entry: setup.plan.entry,
    stopLoss: setup.plan.stopLoss,
    takeProfit: setup.plan.takeProfit,
    minimumRiskReward: config.minimumRiskReward,
    openPositions: 0,
    maxOpenPositions: config.maxOpenPositions,
    symbolOpenPositions: 0,
    maxPositionPerSymbol: config.maxPositionPerSymbol,
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
    riskCheck("max-open-positions", "Max Open Positions", decision.rejectCode === "MAX_OPEN_POSITIONS" ? "INVALIDATED" : "PASSED", `Max ${config.maxOpenPositions}`)
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
  protectiveCluster: readonly Fvg[],
  h1Candles: readonly Candle[],
  m5Candles: readonly Candle[],
  config: AppConfig,
  symbolTickSize: number
): { plan: EntryPlan | null; detail: string } {
  const h1Swings = detectSwings(h1Candles, { left: config.swingLeft, right: config.swingRight });
  const entry = ltfFvg.direction === "bullish" ? ltfFvg.upper : ltfFvg.lower;
  const externalLiquidity = selectExternalLiquidityTarget(h1Swings, direction, entry);
  const plan = calculateEntryPlan({
    direction,
    triggeringFvg: ltfFvg,
    protectiveCluster,
    m5Candles,
    externalLiquidityPrice: externalLiquidity?.price ?? null,
    config: {
      stopLossBufferMode: config.stopLossBufferMode,
      stopLossBufferTicks: config.stopLossBufferTicks,
      stopLossBufferPercent: config.stopLossBufferPercent,
      stopLossAtrPeriod: config.stopLossAtrPeriod,
      stopLossAtrMultiplier: config.stopLossAtrMultiplier,
      symbolTickSize
    }
  });

  if (plan) {
    return {
      plan,
      detail: `Entry ${formatServerPrice(plan.entry)} · SL ${formatServerPrice(plan.stopLoss)} · TP ${formatServerPrice(plan.takeProfit)} · RR ${formatServerPrice(plan.riskReward)}`
    };
  }

  const stopLoss = calculateAnalysisStopLoss(direction, protectiveCluster, m5Candles, config, symbolTickSize);
  const riskDistance = Math.abs(entry - stopLoss);
  const takeProfit = externalLiquidity?.price ?? 0;
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
  if (!externalLiquidity) {
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

function calculateAnalysisStopLoss(direction: Direction, protectiveCluster: readonly Fvg[], candles: readonly Candle[], config: AppConfig, symbolTickSize: number): number {
  const boundary =
    direction === "bullish"
      ? Math.min(...protectiveCluster.map((fvg) => fvg.lower))
      : Math.max(...protectiveCluster.map((fvg) => fvg.upper));
  const buffer = calculateAnalysisStopLossBuffer(boundary, candles, config, symbolTickSize);
  return direction === "bullish" ? boundary - buffer : boundary + buffer;
}

function calculateAnalysisStopLossBuffer(boundary: number, candles: readonly Candle[], config: AppConfig, symbolTickSize: number): number {
  if (config.stopLossBufferMode === "percentage") return boundary * (config.stopLossBufferPercent / 100);
  if (config.stopLossBufferMode === "atr") return calculateAnalysisAtr(candles, config.stopLossAtrPeriod) * config.stopLossAtrMultiplier;
  return config.stopLossBufferTicks * symbolTickSize;
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
  return `${fvg.direction} ${fvg.timeframe} · ${formatServerPrice(fvg.lower)} - ${formatServerPrice(fvg.upper)} · ${fvg.status.toUpperCase()}`;
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
  riskPerTradeUsdt: number;
  maxLeverage: number;
  includeBotPositionOverlays?: boolean;
}): Record<string, unknown>[] {
  const overlays: Record<string, unknown>[] = [];
  const latestTime = params.candles.at(-1)?.time ?? Math.floor(Date.now() / 1000);

  if (params.includeBotPositionOverlays !== false && isRecord(params.engineState) && isRecord(params.engineState.pendingSetup) && isRecord(params.engineState.pendingSetup.plan) && isRecord(params.engineState.pendingSetup.fvg)) {
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
        quantity: params.riskPerTradeUsdt / Math.abs(Number(plan.entry) - Number(plan.stopLoss)),
        margin: 0,
        leverage: params.maxLeverage,
        positionSize: (params.riskPerTradeUsdt / Math.abs(Number(plan.entry) - Number(plan.stopLoss))) * Number(plan.entry),
        createdAt: toSeconds(fvg.createdAt ?? latestTime),
        bars: 36
      })
    );
  }

  if (params.includeBotPositionOverlays !== false && isRecord(params.engineState) && isRecord(params.engineState.activeRisk)) {
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
      riskPerTradeUsdt: config.riskPerTradeUsdt,
      maxLeverage: config.maxLeverage
    },
    execution: {
      entryMode: config.entryMode
    },
    strategy: {
      emaPeriod: config.emaPeriod,
      fvgLifecycle: "UNTOUCHED_FIRST_TOUCH",
      stopLossRule: "ACTIVE_LTF_FVG_CLUSTER",
      stopLossBufferMode: config.stopLossBufferMode,
      takeProfitRule: "HTF_LIQUIDITY"
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

async function getCachedOpenPositions(
  accountClient: BinanceFuturesAccountClient | null,
  cache: BinanceFuturesPositionStatus[] | null,
  cacheAt: number,
  logger: DecisionLogger
): Promise<{ positions: BinanceFuturesPositionStatus[]; cacheAt: number }> {
  if (!accountClient) return { positions: [], cacheAt: 0 };
  if (cache && Date.now() - cacheAt < 5_000) return { positions: cache, cacheAt };

  try {
    return { positions: await accountClient.getOpenPositions(), cacheAt: Date.now() };
  } catch (error) {
    logger.warn("Binance watchlist position sync failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return { positions: cache ?? [], cacheAt };
  }
}

function reconcileWatchlistRows(
  rows: unknown[],
  positions: readonly BinanceFuturesPositionStatus[],
  executionMode: AppConfig["executionMode"]
): unknown[] {
  const openSymbols = new Set(positions.map((position) => position.symbol));
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") return row;

    const hasRealPosition = openSymbols.has(row.symbol);
    if (hasRealPosition) {
      const position = positions.find((item) => item.symbol === row.symbol);
      return {
        ...row,
        state: "ManagingTrade",
        conditions: "—",
        rr: null,
        position: position?.side === "short" ? "SHORT" : "LONG",
        status: "Position Open",
        positionSource: "binance"
      };
    }

    const enginePosition = row.position === "Open" || row.position === "Paper";
    if (!enginePosition) {
      return { ...row, position: "None", positionSource: "binance" };
    }

    if (executionMode === "paper") {
      return { ...row, rr: null, position: "Paper", status: "Simulated", positionSource: "paper" };
    }

    return { ...row, rr: null, position: "None", status: "Unsynced", positionSource: "engine" };
  });
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

function noCacheHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY"
  };
}
