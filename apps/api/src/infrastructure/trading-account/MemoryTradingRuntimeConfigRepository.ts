import type { TradingSettings } from "../../application/config/AppConfig.js";
import type { TradingRuntimeConfigRepository } from "../../application/trading-account/TradingRuntimeConfigRepository.js";

export class MemoryTradingRuntimeConfigRepository implements TradingRuntimeConfigRepository {
  private readonly settings = new Map<string, TradingSettings>();
  private readonly watchlists = new Map<string, string[]>();

  async ensureDefaults(tradingAccountId: string, defaults: TradingSettings): Promise<void> {
    if (!this.settings.has(tradingAccountId)) this.settings.set(tradingAccountId, defaults);
    if (!this.watchlists.has(tradingAccountId)) this.watchlists.set(tradingAccountId, defaults.watchlist);
  }

  async getSettings(tradingAccountId: string): Promise<TradingSettings | null> {
    return this.settings.get(tradingAccountId) ?? null;
  }

  async saveSettings(tradingAccountId: string, settings: TradingSettings): Promise<void> {
    this.settings.set(tradingAccountId, settings);
  }

  async getWatchlist(tradingAccountId: string): Promise<string[]> {
    return this.watchlists.get(tradingAccountId) ?? [];
  }

  async saveWatchlist(tradingAccountId: string, symbols: string[]): Promise<void> {
    this.watchlists.set(tradingAccountId, [...new Set(symbols)]);
  }
}
