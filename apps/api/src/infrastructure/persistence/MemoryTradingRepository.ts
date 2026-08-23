import type { DomainEvent } from "../../domain/events/DomainEvent.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import type { TradingRepository } from "../../application/ports/Repositories.js";
import type { TradingSettings } from "../../application/config/AppConfig.js";
import type { RepositoryStatus } from "./RepositoryStatus.js";

export class MemoryTradingRepository implements TradingRepository {
  private readonly fvgs = new Map<string, Fvg>();
  private readonly signals: MarketStructureSignal[] = [];
  private readonly risks: RiskDecision[] = [];
  private readonly events: DomainEvent[] = [];
  private settings: TradingSettings | null = null;

  async saveFvg(fvg: Fvg): Promise<void> {
    this.fvgs.set(fvg.id, fvg);
  }

  async updateFvg(fvg: Fvg): Promise<void> {
    this.fvgs.set(fvg.id, fvg);
  }

  async getActiveOrWaitingFvg(symbol: string, timeframe?: Fvg["timeframe"]): Promise<Fvg | null> {
    return (
      [...this.fvgs.values()]
        .filter((fvg) => fvg.symbol === symbol && (!timeframe || fvg.timeframe === timeframe) && isUsableFvgStatus(fvg.status))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }

  async saveSignal(signal: MarketStructureSignal): Promise<void> {
    this.signals.push(signal);
  }

  async saveRiskDecision(decision: RiskDecision): Promise<void> {
    this.risks.push(decision);
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }

  async getTradingSettings(): Promise<TradingSettings | null> {
    return this.settings;
  }

  async saveTradingSettings(settings: TradingSettings): Promise<void> {
    this.settings = settings;
  }

  constructor(private readonly status: RepositoryStatus = {
    database: "memory",
    connected: true,
    reason: "DATABASE_URL is not configured; using in-memory fallback"
  }) {}

  async getDashboardSnapshot(): Promise<unknown> {
    return {
      currentFvg: [...this.fvgs.values()].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentHtfFvg: [...this.fvgs.values()].filter((fvg) => fvg.timeframe === "H1").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentLtfFvg: [...this.fvgs.values()].filter((fvg) => fvg.timeframe === "M5").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentSignal: this.signals.at(-1) ?? null,
      riskStatus: this.risks.at(-1) ?? null,
      tradingSettings: this.settings,
      events: this.events.slice(-100),
      connectionStatus: this.status.database,
      databaseStatus: this.status
    };
  }
}

function isUsableFvgStatus(status: Fvg["status"]): boolean {
  return status === "untouched" || status === "touched" || status === "active" || status === "waiting-mitigation";
}
