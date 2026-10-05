import type { AppConfig } from "../config/AppConfig.js";
import { countSetupEvidence, TradingEngine, type AvailableBalanceProvider, type CurrentUsedMarginProvider, type FunnelMetrics, type FunnelTelemetryContext, type SetupDiagnostic, type SymbolRulesProvider } from "../engine/TradingEngine.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";
import type { BinanceFuturesPositionStatus } from "../../infrastructure/execution/BinanceFuturesAccountClient.js";
import type { AiScanHook } from "../ai/AiTradeAdvisor.js";

export interface WatchlistStatus {
  symbol: string;
  state: string;
  conditions: string;
  rr: number | null;
  position: "None" | "Open" | "Paper" | "LONG" | "SHORT";
  status: string;
  /** Rejection code when the setup was ready but no order was placed. */
  blockedReason: string | null;
  lastScanAt: string | null;
  positionSource?: "binance" | "paper" | "engine";
}

export class MarketScanner {
  private readonly engines = new Map<string, TradingEngine>();
  private readonly lastCloseTime = new Map<string, number>();
  private readonly lastScanTime = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private alignTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private activePositions = new Map<string, BinanceFuturesPositionStatus>();
  private pendingEntrySymbols = new Set<string>();

  constructor(
    private config: AppConfig,
    private readonly repository: TradingRepository,
    private readonly execution: ExecutionGateway,
    private readonly logger: DecisionLogger,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly availableBalanceProvider: AvailableBalanceProvider | null,
    private readonly symbolRulesProvider: SymbolRulesProvider | null = null,
    private readonly currentUsedMarginProvider: CurrentUsedMarginProvider | null = null,
    private readonly funnelContext: FunnelTelemetryContext = { accountId: "unknown" },
    private readonly aiAdvisor: AiScanHook | null = null
  ) {
    for (const symbol of config.watchlist) {
      this.engines.set(symbol, this.createEngine(symbol));
    }
  }

  getPrimaryEngine(): TradingEngine {
    const primarySymbol = this.config.watchlist[0] ?? this.config.symbol;
    return this.engines.get(primarySymbol) ?? this.createEngine(primarySymbol);
  }

  getEngine(symbol: string): TradingEngine | null {
    return this.engines.get(symbol) ?? null;
  }

  getSetupDiagnostic(symbol: string): SetupDiagnostic | null {
    return this.engines.get(symbol)?.getSetupDiagnostic() ?? null;
  }

  getFunnelMetrics(symbol?: string): Record<string, FunnelMetrics> {
    const entries = symbol ? [[symbol, this.engines.get(symbol)] as const] : [...this.engines.entries()];
    return Object.fromEntries(entries.filter((entry): entry is [string, TradingEngine] => entry[1] !== undefined).map(([key, engine]) => [key, engine.getFunnelMetrics()]));
  }

  getWatchlistStatus(): WatchlistStatus[] {
    return [...this.engines.entries()].map(([symbol, engine]) => {
      const state = engine.getState();
      const pending = state.pendingEntryPlan;
      const diagnostic = engine.getSetupDiagnostic();
      const passed = state.setupState === "Archived" ? 0 : countSetupEvidence(state.setupEvidence);
      return {
        symbol,
        state: state.setupState,
        conditions: `${passed}/7`,
        rr: pending?.riskReward ?? state.activeRisk?.riskReward ?? null,
        position: positionFromState(state.openPositions, this.config.executionMode),
        status: statusFromState(state.setupState, this.config.executionMode, diagnostic.invariantOk, state.lastRejection?.code ?? null),
        blockedReason: state.lastRejection ? `${state.lastRejection.code}: ${state.lastRejection.reason}` : null,
        lastScanAt: this.lastScanTime.has(symbol) ? new Date(this.lastScanTime.get(symbol) ?? 0).toISOString() : null
      };
    });
  }

  syncPositions(positions: readonly BinanceFuturesPositionStatus[], pendingEntrySymbols: Iterable<string> = []): void {
    this.activePositions.clear();
    for (const position of positions) {
      if (position.quantity > 0) this.activePositions.set(position.symbol, position);
    }
    // Resting bot LIMIT entries count as positions: they become one the moment they fill.
    this.pendingEntrySymbols = new Set([...pendingEntrySymbols].filter((symbol) => !this.activePositions.has(symbol)));
    const accountOpenPositions = this.activePositions.size + this.pendingEntrySymbols.size;
    for (const [symbol, engine] of this.engines) {
      engine.syncActivePosition(this.activePositions.get(symbol) ?? null, accountOpenPositions, this.pendingEntrySymbols.has(symbol));
    }
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
    for (const symbol of config.watchlist) {
      const engine = this.engines.get(symbol) ?? this.createEngine(symbol);
      engine.updateConfig({ ...config, symbol });
    }
    for (const symbol of [...this.engines.keys()]) {
      const engine = this.engines.get(symbol);
      if (!config.watchlist.includes(symbol) && engine?.getState().openPositions === 0) {
        this.engines.delete(symbol);
        this.lastCloseTime.delete(closeTimeKey(symbol, "H1"));
        this.lastCloseTime.delete(closeTimeKey(symbol, "M5"));
        this.lastScanTime.delete(symbol);
      }
    }
  }

  async bootstrap(): Promise<void> {
    for (const symbol of this.config.watchlist) {
      await this.scanSymbol(symbol, true);
    }
  }

  // Scans are aligned a few seconds after each minute boundary so a closed M5 candle is
  // evaluated within seconds instead of up to a full interval later.
  start(intervalMs = 60_000, offsetMs = 2_000): void {
    if (this.timer || this.alignTimer) return;
    const run = () => {
      this.scan().catch((error: unknown) => {
        this.logger.error("[SCANNER] scan failed", { error: error instanceof Error ? error.message : String(error) });
      });
    };
    const delay = intervalMs - (Date.now() % intervalMs) + offsetMs;
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null;
      run();
      this.timer = setInterval(run, intervalMs);
    }, delay);
  }

  stop(): void {
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.timer) clearInterval(this.timer);
    this.alignTimer = null;
    this.timer = null;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const symbol of this.config.watchlist) {
        // One failing symbol (bad data, API hiccup) must not stop the rest of the watchlist.
        try {
          await this.scanSymbol(symbol, false);
        } catch (error) {
          this.logger.error("[SCANNER] symbol scan failed", { symbol, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async scanSymbol(symbol: string, bootstrap: boolean): Promise<void> {
    const engine = this.engines.get(symbol) ?? this.createEngine(symbol);
    engine.recordScan(bootstrap ? "BOOTSTRAP_REPLAY" : "LIVE_SCAN");
    const activePosition = this.activePositions.get(symbol);
    if (activePosition || this.pendingEntrySymbols.has(symbol)) {
      engine.syncActivePosition(activePosition ?? null, this.activePositions.size + this.pendingEntrySymbols.size, this.pendingEntrySymbols.has(symbol));
      this.lastScanTime.set(symbol, Date.now());
      this.logger.info(`[SCANNER] ${symbol} -> ${engine.getState().setupState} (active position)`);
      return;
    }
    this.lastScanTime.set(symbol, Date.now());
    const [h1, m5] = await Promise.all([
      this.marketData.getClosedCandles(symbol, "H1", Math.max(this.config.emaPeriod + 10, 80)),
      this.marketData.getClosedCandles(symbol, "M5", bootstrap ? 300 : 20)
    ]);
    const h1MinCloseTime = bootstrap ? 0 : this.lastCloseTime.get(closeTimeKey(symbol, "H1")) ?? 0;
    const m5MinCloseTime = bootstrap ? 0 : this.lastCloseTime.get(closeTimeKey(symbol, "M5")) ?? 0;
    const candles = [
      ...h1.filter((candle) => candle.closeTime > h1MinCloseTime),
      ...m5.filter((candle) => candle.closeTime > m5MinCloseTime)
    ].sort((a, b) => a.closeTime - b.closeTime);

    for (const candle of candles) {
      await engine.onClosedCandle(candle, { historical: bootstrap });
      const key = closeTimeKey(symbol, candle.timeframe);
      this.lastCloseTime.set(key, Math.max(this.lastCloseTime.get(key) ?? 0, candle.closeTime));
    }

    this.logger.info(`[SCANNER] ${symbol} -> ${engine.getState().setupState}`);
    // AI hook: runs after the engine has handled this scan's candles (so an engine entry on the
    // same candle wins), in the background so the model never delays the next symbol.
    if (!bootstrap) this.notifyAiAdvisor(symbol, engine);
  }

  /** Resolves when every background AI consultation has finished (tests, shutdown). */
  async whenAiIdle(): Promise<void> {
    await this.aiAdvisor?.whenIdle();
  }

  /**
   * Marks a symbol as owned by an entry placed outside the engine (the AI advisor) until the next
   * reconciliation sees the real position or resting order.
   */
  markEntryPlaced(symbol: string): void {
    if (!this.activePositions.has(symbol)) this.pendingEntrySymbols.add(symbol);
    const accountOpenPositions = this.activePositions.size + this.pendingEntrySymbols.size;
    for (const [engineSymbol, engine] of this.engines) {
      const position = this.activePositions.get(engineSymbol) ?? null;
      const pending = this.pendingEntrySymbols.has(engineSymbol);
      // An engine that just submitted its own order is not yet known here; leave it to reconciliation.
      if (!position && !pending && engine.getState().openPositions > 0) continue;
      engine.syncActivePosition(position, accountOpenPositions, pending);
    }
  }

  private notifyAiAdvisor(symbol: string, engine: TradingEngine): void {
    const m5CloseTime = this.lastCloseTime.get(closeTimeKey(symbol, "M5"));
    if (!this.aiAdvisor || m5CloseTime === undefined) return;
    this.aiAdvisor.onScan({
      symbol,
      engine,
      m5CloseTime,
      config: () => ({ ...this.config, symbol }),
      livePrice: async () => (this.marketData.getLastPrice ? this.marketData.getLastPrice(symbol) : null),
      hasActiveEntry: () => this.activePositions.has(symbol) || this.pendingEntrySymbols.has(symbol),
      accountOpenPositions: () => this.activePositions.size + this.pendingEntrySymbols.size,
      markEntryPlaced: () => this.markEntryPlaced(symbol)
    });
  }

  private createEngine(symbol: string): TradingEngine {
    const symbolConfig: AppConfig = { ...this.config, symbol };
    const engine = new TradingEngine(
      symbolConfig,
      this.repository,
      this.execution,
      this.logger,
      this.availableBalanceProvider,
      this.symbolRulesProvider,
      this.currentUsedMarginProvider,
      10_000,
      this.funnelContext,
      async (priceSymbol) => (this.marketData.getLastPrice ? this.marketData.getLastPrice(priceSymbol) : null)
    );
    this.engines.set(symbol, engine);
    return engine;
  }
}

function closeTimeKey(symbol: string, timeframe: Candle["timeframe"]): string {
  return `${symbol}:${timeframe}`;
}

function positionFromState(openPositions: number, executionMode: string): "None" | "Open" | "Paper" {
  if (openPositions <= 0) return "None";
  return executionMode === "paper" ? "Paper" : "Open";
}

function statusFromState(state: string, executionMode: string, invariantOk: boolean, blockedCode: string | null): string {
  if (state === "ReadyToEnter" && blockedCode) return `Blocked: ${blockedCode}`;
  if (state === "ReadyToEnter") return invariantOk ? "Ready" : "Monitoring";
  if (state === "PositionOpened" || state === "ManagingTrade") return executionMode === "paper" ? "Simulated" : "Active";
  if (state === "Archived") return "Invalidated";
  return "Monitoring";
}
