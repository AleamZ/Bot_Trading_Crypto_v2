import type { AppConfig } from "../config/AppConfig.js";
import { countSetupEvidence, TradingEngine, type AvailableBalanceProvider, type SetupDiagnostic, type SymbolRulesProvider } from "../engine/TradingEngine.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";
import type { BinanceFuturesPositionStatus } from "../../infrastructure/execution/BinanceFuturesAccountClient.js";

export interface WatchlistStatus {
  symbol: string;
  state: string;
  conditions: string;
  rr: number | null;
  position: "None" | "Open" | "Paper" | "LONG" | "SHORT";
  status: string;
  lastScanAt: string | null;
  positionSource?: "binance" | "paper" | "engine";
}

export class MarketScanner {
  private readonly engines = new Map<string, TradingEngine>();
  private readonly lastCloseTime = new Map<string, number>();
  private readonly lastScanTime = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private activePositions = new Map<string, BinanceFuturesPositionStatus>();

  constructor(
    private config: AppConfig,
    private readonly repository: TradingRepository,
    private readonly execution: ExecutionGateway,
    private readonly logger: DecisionLogger,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly availableBalanceProvider: AvailableBalanceProvider | null,
    private readonly symbolRulesProvider: SymbolRulesProvider | null = null
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
        status: statusFromState(state.setupState, this.config.executionMode, diagnostic.invariantOk),
        lastScanAt: this.lastScanTime.has(symbol) ? new Date(this.lastScanTime.get(symbol) ?? 0).toISOString() : null
      };
    });
  }

  syncPositions(positions: readonly BinanceFuturesPositionStatus[]): void {
    this.activePositions.clear();
    for (const position of positions) {
      if (position.quantity > 0) this.activePositions.set(position.symbol, position);
    }
    for (const [symbol, engine] of this.engines) {
      engine.syncActivePosition(this.activePositions.get(symbol) ?? null, this.activePositions.size);
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

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scan().catch((error: unknown) => {
        this.logger.error("[SCANNER] scan failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const symbol of this.config.watchlist) {
        await this.scanSymbol(symbol, false);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async scanSymbol(symbol: string, bootstrap: boolean): Promise<void> {
    const engine = this.engines.get(symbol) ?? this.createEngine(symbol);
    const activePosition = this.activePositions.get(symbol);
    if (activePosition) {
      engine.syncActivePosition(activePosition, this.activePositions.size);
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
  }

  private createEngine(symbol: string): TradingEngine {
    const symbolConfig: AppConfig = { ...this.config, symbol };
    const engine = new TradingEngine(symbolConfig, this.repository, this.execution, this.logger, this.availableBalanceProvider, this.symbolRulesProvider);
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

function statusFromState(state: string, executionMode: string, invariantOk: boolean): string {
  if (state === "ReadyToEnter") return invariantOk ? "Ready" : "Monitoring";
  if (state === "PositionOpened" || state === "ManagingTrade") return executionMode === "paper" ? "Simulated" : "Active";
  if (state === "Archived") return "Invalidated";
  return "Monitoring";
}
