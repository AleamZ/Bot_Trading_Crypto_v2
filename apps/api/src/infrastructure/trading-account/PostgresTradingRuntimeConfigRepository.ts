import pg from "pg";
import crypto from "node:crypto";
import { getPostgresPool } from "../persistence/PgPoolFactory.js";
import { recordSchemaMigration } from "../persistence/SchemaMigrations.js";
import type { TradingSettings } from "../../application/config/AppConfig.js";
import type { TradingRuntimeConfigRepository } from "../../application/trading-account/TradingRuntimeConfigRepository.js";
import { MemoryTradingRuntimeConfigRepository } from "./MemoryTradingRuntimeConfigRepository.js";

export class PostgresTradingRuntimeConfigRepository implements TradingRuntimeConfigRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = getPostgresPool(connectionString);
  }

  async migrate(): Promise<void> {
    await recordSchemaMigration(this.pool, "003_trading_runtime_config", "account scoped settings and watchlists");
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
    return (result.rows[0] as { payload: TradingSettings } | undefined)?.payload ?? null;
  }

  async saveSettings(tradingAccountId: string, settings: TradingSettings): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into trading_settings (id, trading_account_id, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $4)
       on conflict (trading_account_id) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
      [crypto.randomUUID(), tradingAccountId, settings, now]
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
}

export async function createTradingRuntimeConfigRepository(databaseUrl?: string): Promise<TradingRuntimeConfigRepository> {
  if (!databaseUrl) return new MemoryTradingRuntimeConfigRepository();
  const repository = new PostgresTradingRuntimeConfigRepository(databaseUrl);
  await repository.migrate();
  return repository;
}
