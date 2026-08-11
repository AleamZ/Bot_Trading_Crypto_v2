import type { AppConfig } from "../config/AppConfig.js";
import { TradingEngine, type AvailableBalanceProvider } from "../engine/TradingEngine.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";

export interface WatchlistStatus {
  symbol: string;
  state: string;
  conditions: string;
  rr: number | null;
  position: "None" | "Open";
  status: string;
  lastScanAt: string | null;
}

export class MarketScanner {
  private readonly engines = new Map<string, TradingEngine>();
  private readonly lastCloseTime = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private config: AppConfig,
    private readonly repository: TradingRepository,
    private readonly execution: ExecutionGateway,
    private readonly logger: DecisionLogger,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly availableBalanceProvider: AvailableBalanceProvider | null
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

  getWatchlistStatus(): WatchlistStatus[] {
    return [...this.engines.entries()].map(([symbol, engine]) => {
      const state = engine.getState();
      const pending = state.pendingEntryPlan;
      const passed = conditionsPassed(state.setupState);
      return {
        symbol,
        state: state.setupState,
        conditions: `${passed}/7`,
        rr: pending?.riskReward ?? state.activeRisk?.riskReward ?? null,
        position: state.openPositions > 0 ? "Open" : "None",
        status: statusFromState(state.setupState),
        lastScanAt: this.lastCloseTime.has(symbol) ? new Date(this.lastCloseTime.get(symbol) ?? 0).toISOString() : null
      };
    });
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
        this.lastCloseTime.delete(symbol);
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
    const [h1, m5] = await Promise.all([
      this.marketData.getClosedCandles(symbol, "H1", Math.max(this.config.emaPeriod + 10, 80)),
      this.marketData.getClosedCandles(symbol, "M5", bootstrap ? 300 : 20)
    ]);
    const minCloseTime = bootstrap ? 0 : this.lastCloseTime.get(symbol) ?? 0;
    const candles = [...h1, ...m5].filter((candle) => candle.closeTime > minCloseTime).sort((a, b) => a.closeTime - b.closeTime);

    for (const candle of candles) {
      await engine.onClosedCandle(candle);
      this.lastCloseTime.set(symbol, Math.max(this.lastCloseTime.get(symbol) ?? 0, candle.closeTime));
    }

    this.logger.info(`[SCANNER] ${symbol} -> ${engine.getState().setupState}`);
  }

  private createEngine(symbol: string): TradingEngine {
    const symbolConfig: AppConfig = { ...this.config, symbol };
    const engine = new TradingEngine(symbolConfig, this.repository, this.execution, this.logger, this.availableBalanceProvider);
    this.engines.set(symbol, engine);
    return engine;
  }
}

function conditionsPassed(state: string): number {
  const rank: Record<string, number> = {
    WaitingTrend: 0,
    TrendConfirmed: 1,
    FVGDetected: 2,
    WaitingMitigation: 2,
    MonitoringLTF: 3,
    WaitingCHOCH: 3,
    WaitingLtfFvg: 4,
    WaitingLtfMitigation: 5,
    ReadyToEnter: 7,
    PositionOpened: 7,
    ManagingTrade: 7,
    Closed: 7,
    Archived: 0
  };
  return rank[state] ?? 0;
}

function statusFromState(state: string): string {
  if (state === "ReadyToEnter") return "Ready";
  if (state === "PositionOpened" || state === "ManagingTrade") return "Active";
  if (state === "Archived") return "Invalidated";
  return "Monitoring";
}
