import type { DomainEvent } from "../../domain/events/DomainEvent.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import type { TradingSettings } from "../config/AppConfig.js";

export interface TradingRepository {
  saveFvg(fvg: Fvg): Promise<void>;
  updateFvg(fvg: Fvg): Promise<void>;
  getActiveOrWaitingFvg(symbol: string, timeframe?: Fvg["timeframe"]): Promise<Fvg | null>;
  saveSignal(signal: MarketStructureSignal): Promise<void>;
  saveRiskDecision(decision: RiskDecision): Promise<void>;
  appendEvent(event: DomainEvent): Promise<void>;
  getTradingSettings(): Promise<TradingSettings | null>;
  saveTradingSettings(settings: TradingSettings): Promise<void>;
  getDashboardSnapshot(): Promise<unknown>;
}
