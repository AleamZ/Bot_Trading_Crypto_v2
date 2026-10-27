import type { IncomingMessage, ServerResponse } from "node:http";
import { mentionedSymbols, type AiChatContext, type AiChatService, type AiChatToolbox, type AiChatTurn } from "../../application/ai/AiChatService.js";
import type { ChatOrderProposalResult, ChatOrderRequest } from "../../application/ai/AiChatOrders.js";
import { LlmRequestError } from "../../application/ai/LocalLlmClient.js";
import type { DecisionLogger } from "../../application/ports/Logger.js";
import type { TradingRuntimeManager } from "../../application/runtime/TradingRuntimeManager.js";
import type { Candle, Timeframe } from "../../domain/market-data/Candle.js";

export const AI_CHAT_RATE_WINDOW_MS = 60_000;
export const AI_CHAT_RATE_MAX = 10;
// Same cadence as the live stream: under the 60 s proxy idle limit.
const HEARTBEAT_MS = 30_000;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

const recentChats = new Map<string, number[]>();
const chatsInFlight = new Set<string>();

/**
 * Takes a chat slot for the user: one answer at a time and AI_CHAT_RATE_MAX per minute.
 * Returns a release function, or null when the user has to wait.
 */
export function acquireAiChatSlot(userId: string, now = Date.now()): (() => void) | null {
  if (chatsInFlight.has(userId)) return null;
  const recent = (recentChats.get(userId) ?? []).filter((at) => now - at < AI_CHAT_RATE_WINDOW_MS);
  if (recent.length >= AI_CHAT_RATE_MAX) {
    recentChats.set(userId, recent);
    return null;
  }
  recent.push(now);
  recentChats.set(userId, recent);
  chatsInFlight.add(userId);
  return () => chatsInFlight.delete(userId);
}

export function resetAiChatLimits(): void {
  recentChats.clear();
  chatsInFlight.clear();
}

export interface AiChatRouteParams {
  request: IncomingMessage;
  response: ServerResponse;
  corsHeaders: Record<string, string>;
  account: { id: string; name: string; mode: "DEMO" | "REAL" };
  /** The account's trading settings; only whitelisted fields reach the model. */
  settings: Record<string, unknown>;
  turns: AiChatTurn[];
  aiChat: AiChatService;
  runtimeManager?: TradingRuntimeManager | undefined;
  /** Same analysis as the Analysis tab, for a symbol the question names. */
  analyzeSymbol: (symbol: string) => Promise<unknown>;
  closedCandles: (symbol: string, timeframe: Timeframe, limit: number) => Promise<Candle[]>;
  logger: DecisionLogger;
  heartbeatMs?: number;
  /** Tools the model may call (symbol lookup, news, order proposals); absent = context-only answers. */
  tools?: AiChatToolbox;
}

/** Binds the chat tools to one account: analysis of any symbol, news, and order proposals. */
export function createAiChatToolbox(deps: {
  analyzeSymbol: (symbol: string) => Promise<unknown>;
  closedCandles: (symbol: string, timeframe: Timeframe, limit: number) => Promise<Candle[]>;
  livePrice: (symbol: string) => Promise<number | null>;
  news: AiChatToolbox["news"];
  proposeOrder: (request: ChatOrderRequest) => Promise<ChatOrderProposalResult>;
}): AiChatToolbox {
  return {
    marketAnalysis: async (symbol) => {
      if (!SYMBOL_PATTERN.test(symbol)) return { ok: false, error: "INVALID_SYMBOL", message: `${symbol} is not a USDT-M symbol` };
      const [analysis, h1, m5, livePrice] = await Promise.all([
        deps.analyzeSymbol(symbol),
        deps.closedCandles(symbol, "H1", 24).catch(() => null),
        deps.closedCandles(symbol, "M5", 36).catch(() => null),
        deps.livePrice(symbol).catch(() => null)
      ]);
      return { symbol, checkedAt: new Date().toISOString(), livePrice, analysis, candles: { columns: ["openTime", "open", "high", "low", "close"], h1: compactCandles(h1), m5: compactCandles(m5) } };
    },
    news: deps.news,
    proposeOrder: deps.proposeOrder
  };
}

/**
 * Streams one chat answer as Server-Sent Events: `meta`, then `tool` progress, `proposal` cards and
 * `delta` pieces, then `done` or `error`.
 */
export async function streamAiChatReply(params: AiChatRouteParams): Promise<void> {
  const { request, response, corsHeaders, account, aiChat, logger } = params;
  const context = await buildAiChatContext(params);
  const model = aiChat.modelFor(typeof params.settings.aiModel === "string" ? params.settings.aiModel : null);

  response.writeHead(200, {
    ...corsHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const send = (event: string, data: unknown): void => {
    if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const abort = new AbortController();
  let finished = false;
  const onClose = () => {
    if (!finished) abort.abort();
  };
  request.on("close", onClose);
  response.on("close", onClose);
  // The model can think for a while before the first token; keep proxies from timing out.
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, params.heartbeatMs ?? HEARTBEAT_MS);

  // A proposal becomes a card in the chat as soon as the risk manager accepts it.
  const tools: AiChatToolbox | undefined = params.tools
    ? {
        ...params.tools,
        proposeOrder: async (orderRequest) => {
          const result = await params.tools!.proposeOrder(orderRequest);
          if (result.ok) send("proposal", result.proposal);
          return result;
        }
      }
    : undefined;

  send("meta", { model, symbols: context.symbols.map((item) => item.symbol), unavailable: context.unavailable, tools: Boolean(tools) });
  try {
    const answer = await aiChat.reply({
      context,
      turns: params.turns,
      model,
      signal: abort.signal,
      onDelta: (text) => send("delta", { text }),
      ...(tools ? { tools, onTool: (event) => send("tool", event) } : {})
    });
    send("done", { model: answer.model, latencyMs: answer.latencyMs });
    logger.info("[AI CHAT] answered", { tradingAccountId: account.id, model: answer.model, latencyMs: answer.latencyMs, symbols: context.symbols.map((item) => item.symbol) });
  } catch (error) {
    const code = error instanceof LlmRequestError ? error.code : "AI_CHAT_FAILED";
    if (code !== "LLM_ABORTED") {
      logger.warn("[AI CHAT] answer failed", { tradingAccountId: account.id, code, error: error instanceof Error ? error.message : String(error) });
      send("error", { code, message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    request.off("close", onClose);
    response.off("close", onClose);
    if (!response.writableEnded) response.end();
  }
}

/** Gathers what the assistant may know, best-effort: anything that fails is listed in `unavailable`. */
export async function buildAiChatContext(params: Pick<AiChatRouteParams, "account" | "settings" | "turns" | "runtimeManager" | "analyzeSymbol" | "closedCandles">): Promise<AiChatContext> {
  const { account, settings, runtimeManager } = params;
  const unavailable: string[] = [];
  const attempt = async <T>(label: string, task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task();
    } catch {
      unavailable.push(label);
      return null;
    }
  };
  const watchlist = Array.isArray(settings.watchlist) ? settings.watchlist.filter((item): item is string => typeof item === "string") : [];
  const question = params.turns.at(-1)?.content ?? "";
  const symbols = mentionedSymbols(question, watchlist).filter((symbol) => SYMBOL_PATTERN.test(symbol));

  const [live, decisions, activity, symbolData] = await Promise.all([
    runtimeManager ? attempt("runtime", () => runtimeManager.getLiveState(account.id)) : Promise.resolve(null),
    runtimeManager ? attempt("aiDecisions", () => runtimeManager.listAiDecisions(account.id, 8)) : Promise.resolve(null),
    runtimeManager ? attempt("positions", () => runtimeManager.getAccountActivity(account.id, undefined, 20)) : Promise.resolve(null),
    Promise.all(
      symbols.map(async (symbol) => {
        const [analysis, h1, m5] = await Promise.all([
          attempt(`analysis:${symbol}`, () => params.analyzeSymbol(symbol)),
          attempt(`candles:${symbol}:H1`, () => params.closedCandles(symbol, "H1", 24)),
          attempt(`candles:${symbol}:M5`, () => params.closedCandles(symbol, "M5", 36))
        ]);
        return { symbol, inWatchlist: watchlist.includes(symbol), analysis, candles: { columns: ["openTime", "open", "high", "low", "close"], h1: compactCandles(h1), m5: compactCandles(m5) } };
      })
    )
  ]);
  if (!runtimeManager) unavailable.push("runtime");

  const store = isRecord(live?.store) ? live.store : {};
  return {
    now: new Date().toISOString(),
    account: { name: account.name, mode: account.mode },
    settings: pick(settings, [
      "settingsMode",
      "riskLevel",
      "watchlist",
      "riskPerTradeUsdt",
      "minimumRiskReward",
      "maxLeverage",
      "maxMarginUsagePercent",
      "maxOpenPositions",
      "marginMode",
      "entryMode",
      "dailyProfitLimitR",
      "dailyLossLimitR",
      "maxDrawdownPercent",
      "tradingEnabled",
      "killSwitch",
      "emaPeriod",
      "stopLossBufferMode",
      "requireDisplacement",
      "aiTradingMode",
      "aiMinConfidence"
    ]),
    runtime: live ? { engine: live.engine, scanner: live.scannerProgress, health: live.runtimeHealth, execution: live.execution } : null,
    watchlist: live?.watchlistStatus ?? [],
    recentEvents: (Array.isArray(store.events) ? store.events : []).slice(-15).map(compactEvent),
    aiDecisions: (decisions ?? []).map((decision) =>
      pick(decision, ["createdAt", "symbol", "outcome", "effectiveMode", "setupState", "evidence", "livePrice", "decision", "rejectCode", "rejectReason", "riskReward"])
    ),
    aiSteps: runtimeManager ? runtimeManager.live.recentAiSteps(account.id).slice(-12) : [],
    positions: activity
      ? activity.positions.map((position) =>
          pick(position as unknown as Record<string, unknown>, ["symbol", "side", "quantity", "entryPrice", "notional", "leverage", "margin", "unrealizedProfit", "stopLoss", "takeProfit"])
        )
      : null,
    openOrders: activity
      ? activity.openOrders.map((order) => pick(order as unknown as Record<string, unknown>, ["symbol", "side", "type", "price", "stopPrice", "quantity", "executedQuantity", "status", "reduceOnly"]))
      : null,
    symbols: symbolData,
    unavailable
  };
}

function compactCandles(candles: Candle[] | null): number[][] {
  return (candles ?? []).map((candle) => [candle.openTime, candle.open, candle.high, candle.low, candle.close]);
}

function compactEvent(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) return {};
  const fvg = isRecord(event.fvg) ? pick(event.fvg, ["symbol", "direction", "timeframe", "lower", "upper", "status"]) : undefined;
  const signal = isRecord(event.signal) ? pick(event.signal, ["symbol", "type", "direction", "close"]) : undefined;
  return {
    type: event.type,
    symbol: event.symbol ?? fvg?.symbol ?? signal?.symbol ?? null,
    at: event.at ?? event.timestamp ?? event.createdAt ?? null,
    reason: event.reason ?? (isRecord(event.decision) ? event.decision.reason : undefined) ?? null,
    ...(fvg ? { fvg } : {}),
    ...(signal ? { signal } : {})
  };
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
