import pg from "pg";
import crypto from "node:crypto";
import { getPostgresPool } from "../persistence/PgPoolFactory.js";
import { recordSchemaMigration } from "../persistence/SchemaMigrations.js";
import { validateTradingSettings, type TradingSettings } from "../../application/config/AppConfig.js";
import type { AccountProtectionState } from "../../application/risk/AccountProtectionService.js";
import type { TradingRuntimeConfigRepository } from "../../application/trading-account/TradingRuntimeConfigRepository.js";
import { MemoryTradingRuntimeConfigRepository } from "./MemoryTradingRuntimeConfigRepository.js";

export class PostgresTradingRuntimeConfigRepository implements TradingRuntimeConfigRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = getPostgresPool(connectionString);
  }

  async migrate(): Promise<void> {
    await recordSchemaMigration(this.pool, "003_trading_runtime_config", "account scoped settings and watchlists");
    await recordSchemaMigration(this.pool, "004_risk_based_position_sizing", "replace fixed margin sizing with account scoped risk per trade");
    await recordSchemaMigration(this.pool, "005_account_protection_state", "account scoped drawdown protection state");
    await this.pool.query(`
      create table if not exists trading_settings (
        id uuid primary key,
        trading_account_id uuid not null unique references trading_accounts(id) on delete cascade,
        payload jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
    await this.pool.query(`create index if not exists trading_settings_account_id_idx on trading_settings(trading_account_id)`);
    await this.pool.query(`
      create table if not exists trading_watchlist_symbols (
        trading_account_id uuid not null references trading_accounts(id) on delete cascade,
        symbol varchar(20) not null,
        created_at timestamptz not null,
        primary key (trading_account_id, symbol)
      )
    `);
    await this.pool.query(`create index if not exists trading_watchlist_account_id_idx on trading_watchlist_symbols(trading_account_id)`);
    await this.pool.query(`
      create table if not exists account_protection_state (
        trading_account_id uuid primary key references trading_accounts(id) on delete cascade,
        baseline_equity_usdt numeric not null,
        peak_equity_usdt numeric not null,
        max_drawdown_reached_at timestamptz null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
  }

  async ensureDefaults(tradingAccountId: string, defaults: TradingSettings): Promise<void> {
    await this.pool.query("begin");
    try {
      const now = new Date().toISOString();
      await this.pool.query(
        `insert into trading_settings (id, trading_account_id, payload, created_at, updated_at)
         values ($1, $2, $3, $4, $4)
         on conflict (trading_account_id) do nothing`,
        [crypto.randomUUID(), tradingAccountId, defaults, now]
      );
      const watchlist = await this.getWatchlist(tradingAccountId);
      if (watchlist.length === 0) {
        for (const symbol of defaults.watchlist) {
          await this.pool.query(
            `insert into trading_watchlist_symbols (trading_account_id, symbol, created_at)
             values ($1, $2, $3) on conflict do nothing`,
            [tradingAccountId, symbol, now]
          );
        }
      }
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  async getSettings(tradingAccountId: string): Promise<TradingSettings | null> {
    const result = await this.pool.query(`select payload from trading_settings where trading_account_id = $1 limit 1`, [tradingAccountId]);
    const payload = (result.rows[0] as { payload: Record<string, unknown> } | undefined)?.payload;
    if (!payload) return null;
    const {
      marginPerTrade: _legacyMargin,
      leverage: _legacyLeverage,
      minNotional: _legacyMinNotional,
      maxPositionSize: _legacyMaxPositionSize,
      takeProfitMode: _legacyTakeProfitMode,
      fixedRr: _legacyFixedRr,
      priceTickSize: _legacyPriceTickSize,
      fvgMitigation: _legacyFvgMitigation,
      ltfFvgEntryMode: _legacyLtfFvgEntryMode,
      maxTradesPerDay: _legacyMaxTradesPerDay,
      maxDailyLossPercent: _legacyMaxDailyLossPercent,
      maxConsecutiveLosses: _legacyMaxConsecutiveLosses,
      cooldownAfterTradeMinutes: _legacyCooldownAfterTradeMinutes,
      ...stored
    } = payload;
    return validateTradingSettings(stored);
  }

  async saveSettings(tradingAccountId: string, settings: TradingSettings): Promise<void> {
    const now = new Date().toISOString();
    const normalized = validateTradingSettings(settings);
    await this.pool.query(
      `insert into trading_settings (id, trading_account_id, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $4)
       on conflict (trading_account_id) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
      [crypto.randomUUID(), tradingAccountId, normalized, now]
    );
  }

  async getWatchlist(tradingAccountId: string): Promise<string[]> {
    const result = await this.pool.query(
      `select symbol from trading_watchlist_symbols where trading_account_id = $1 order by created_at asc, symbol asc`,
      [tradingAccountId]
    );
    return (result.rows as Array<{ symbol: string }>).map((row) => row.symbol);
  }

  async saveWatchlist(tradingAccountId: string, symbols: string[]): Promise<void> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    await this.pool.query("begin");
    try {
      await this.pool.query(`delete from trading_watchlist_symbols where trading_account_id = $1`, [tradingAccountId]);
      const now = new Date().toISOString();
      for (const symbol of normalized) {
        await this.pool.query(
          `insert into trading_watchlist_symbols (trading_account_id, symbol, created_at) values ($1, $2, $3)`,
          [tradingAccountId, symbol, now]
        );
      }
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  async getAccountProtectionState(tradingAccountId: string): Promise<AccountProtectionState | null> {
    const result = await this.pool.query(
      `select trading_account_id, baseline_equity_usdt, peak_equity_usdt, max_drawdown_reached_at, created_at, updated_at
       from account_protection_state where trading_account_id = $1 limit 1`,
      [tradingAccountId]
    );
    const row = result.rows[0] as
      | {
          trading_account_id: string;
          baseline_equity_usdt: string;
          peak_equity_usdt: string;
          max_drawdown_reached_at: Date | string | null;
          created_at: Date | string;
          updated_at: Date | string;
        }
      | undefined;
    if (!row) return null;
    return {
      tradingAccountId: row.trading_account_id,
      baselineEquityUsdt: Number(row.baseline_equity_usdt),
      peakEquityUsdt: Number(row.peak_equity_usdt),
      maxDrawdownReachedAt: row.max_drawdown_reached_at ? new Date(row.max_drawdown_reached_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  async saveAccountProtectionState(state: AccountProtectionState): Promise<void> {
    await this.pool.query(
      `insert into account_protection_state (
         trading_account_id, baseline_equity_usdt, peak_equity_usdt, max_drawdown_reached_at, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6)
       on conflict (trading_account_id) do update set
         baseline_equity_usdt = excluded.baseline_equity_usdt,
         peak_equity_usdt = excluded.peak_equity_usdt,
         max_drawdown_reached_at = excluded.max_drawdown_reached_at,
         updated_at = excluded.updated_at`,
      [state.tradingAccountId, state.baselineEquityUsdt, state.peakEquityUsdt, state.maxDrawdownReachedAt, state.createdAt, state.updatedAt]
    );
  }
}

export async function createTradingRuntimeConfigRepository(databaseUrl?: string): Promise<TradingRuntimeConfigRepository> {
  if (!databaseUrl) return new MemoryTradingRuntimeConfigRepository();
  const repository = new PostgresTradingRuntimeConfigRepository(databaseUrl);
  await repository.migrate().catch((error: unknown) => {
    console.warn(`[postgres] runtime config migration skipped during startup: ${error instanceof Error ? error.message : String(error)}`);
  });
  return repository;
}
