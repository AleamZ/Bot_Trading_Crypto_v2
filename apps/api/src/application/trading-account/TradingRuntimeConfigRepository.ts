import type { TradingSettings } from "../config/AppConfig.js";

export interface TradingRuntimeConfigRepository {
  migrate?(): Promise<void>;
  ensureDefaults(tradingAccountId: string, defaults: TradingSettings): Promise<void>;
  getSettings(tradingAccountId: string): Promise<TradingSettings | null>;
  saveSettings(tradingAccountId: string, settings: TradingSettings): Promise<void>;
  getWatchlist(tradingAccountId: string): Promise<string[]>;
  saveWatchlist(tradingAccountId: string, symbols: string[]): Promise<void>;
}
