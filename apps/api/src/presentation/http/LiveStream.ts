import type { IncomingMessage, ServerResponse } from "node:http";
import type { DecisionLogger } from "../../application/ports/Logger.js";
import type { LiveMonitorState, TradingRuntimeManager } from "../../application/runtime/TradingRuntimeManager.js";

/** Below Cloudflare's 100 s and nginx's 60 s idle limits. */
export const LIVE_HEARTBEAT_MS = 15_000;
/** Scans of a watchlist arrive in bursts; one push per burst is enough. */
export const LIVE_FLUSH_DELAY_MS = 250;
const AI_DECISION_LIMIT = 20;

/**
 * Server-Sent Events feed of one trading account for the dashboard:
 * - `monitor`: watchlist rows, engine state, runtime health and execution gate (after scans and reconciliation)
 * - `store`: recent bot events and current FVG/signal (only when they changed)
 * - `ai-decisions`: the latest AI decisions (after the AI recorded one)
 * - `ai-steps` (on connect) / `ai-step`: what the AI advisor is checking, asking and deciding, as it happens
 * - `scanned`: symbols that were just scanned, so an open Analysis view can refresh
 * Nothing here calls Binance; balances and daily risk stay on the regular snapshot endpoint.
 * The caller must already have checked that the user owns the account.
 */
export async function streamAccountLiveUpdates(params: {
  request: IncomingMessage;
  response: ServerResponse;
  corsHeaders: Record<string, string>;
  accountId: string;
  runtimeManager: TradingRuntimeManager;
  logger: DecisionLogger;
  heartbeatMs?: number;
  flushDelayMs?: number;
}): Promise<void> {
  const { request, response, corsHeaders, accountId, runtimeManager, logger } = params;
  // Read before writing headers so a missing runtime still gets the regular JSON error response.
  const [monitor, decisions] = await Promise.all([runtimeManager.getLiveState(accountId), runtimeManager.listAiDecisions(accountId, AI_DECISION_LIMIT)]);

  response.writeHead(200, {
    ...corsHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx would otherwise buffer the stream.
    "x-accel-buffering": "no"
  });

  let closed = false;
  const lastPayload = new Map<string, string>();
  const send = (event: string, data: unknown, onlyIfChanged: boolean): void => {
    if (closed || response.writableEnded) return;
    const payload = JSON.stringify(data);
    if (onlyIfChanged) {
      if (lastPayload.get(event) === payload) return;
      lastPayload.set(event, payload);
    }
    response.write(`event: ${event}\ndata: ${payload}\n\n`);
  };
  const sendMonitor = (state: LiveMonitorState): void => {
    send("monitor", { engine: state.engine, watchlistRows: state.watchlistStatus, runtimeHealth: state.runtimeHealth, execution: state.execution }, true);
    send("store", { store: state.store }, true);
  };

  response.write("retry: 5000\n\n");
  sendMonitor(monitor);
  send("ai-decisions", { decisions }, true);
  send("ai-steps", { steps: runtimeManager.live.recentAiSteps(accountId) }, false);

  const pending = { monitor: false, decisions: false, scanned: new Set<string>() };
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();
  const flush = async (): Promise<void> => {
    const wantMonitor = pending.monitor;
    const wantDecisions = pending.decisions;
    const scanned = [...pending.scanned];
    pending.monitor = false;
    pending.decisions = false;
    pending.scanned.clear();
    try {
      if (wantMonitor) sendMonitor(await runtimeManager.getLiveState(accountId));
      if (wantDecisions) send("ai-decisions", { decisions: await runtimeManager.listAiDecisions(accountId, AI_DECISION_LIMIT) }, true);
      if (scanned.length > 0) send("scanned", { symbols: scanned, at: Date.now() }, false);
    } catch (error) {
      // The runtime is gone or unreadable: end the stream; the browser reconnects and gets the JSON error.
      logger.warn("[LIVE] stream update failed", { accountId, error: error instanceof Error ? error.message : String(error) });
      close();
    }
  };
  const schedule = (): void => {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      // Chained so two bursts never write out of order.
      flushing = flushing.then(flush);
    }, params.flushDelayMs ?? LIVE_FLUSH_DELAY_MS);
  };

  const unsubscribe = runtimeManager.live.subscribe(accountId, (change) => {
    if (change.topic === "closed") {
      close();
      return;
    }
    if (change.topic === "ai-step") {
      send("ai-step", change.step, false);
      if (change.step.stage !== "result") return;
      pending.decisions = true;
    }
    if (change.topic === "scan") pending.scanned.add(change.symbol);
    pending.monitor = true;
    schedule();
  });
  const heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) response.write(": ping\n\n");
  }, params.heartbeatMs ?? LIVE_HEARTBEAT_MS);

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribe();
    if (!response.writableEnded) response.end();
  }
  request.on("close", close);
  response.on("close", close);
}
