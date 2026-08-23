import type { TradingSettings } from "../config/AppConfig.js";
import type { AccountProtectionState } from "../risk/AccountProtectionService.js";

export interface TradingRuntimeConfigRepository {
  migrate?(): Promise<void>;
  ensureDefaults(tradingAccountId: string, defaults: TradingSettings): Promise<void>;
  getSettings(tradingAccountId: string): Promise<TradingSettings | null>;
  saveSettings(tradingAccountId: string, settings: TradingSettings): Promise<void>;
  getWatchlist(tradingAccountId: string): Promise<string[]>;
  saveWatchlist(tradingAccountId: string, symbols: string[]): Promise<void>;
  getAccountProtectionState?(tradingAccountId: string): Promise<AccountProtectionState | null>;
  saveAccountProtectionState?(state: AccountProtectionState): Promise<void>;
  deleteAccountData?(tradingAccountId: string): Promise<void>;
}
