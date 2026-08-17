import pg from "pg";
import type { CreateTradingAccountInput, TradingAccountRepository } from "../../application/trading-account/TradingAccountRepository.js";
import type { BinanceConnection, TradingAccount, TradingAccountStatus } from "../../domain/trading-account/TradingAccount.js";
import { MemoryTradingAccountRepository } from "./MemoryTradingAccountRepository.js";

export class PostgresTradingAccountRepository implements TradingAccountRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined;
    this.pool = ssl ? new pg.Pool({ connectionString, ssl }) : new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.ensureCompatibleTable("trading_accounts", ["id", "user_id", "name", "mode", "status", "created_at", "updated_at"]);
    await this.pool.query(`
      create table if not exists trading_accounts (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        name varchar(120) not null,
        mode varchar(12) not null,
        status varchar(20) not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
    await this.pool.query(`create index if not exists trading_accounts_user_id_idx on trading_accounts(user_id)`);

    await this.ensureCompatibleTable("binance_connections", [
      "id",
      "trading_account_id",
      "api_key_encrypted",
      "api_secret_encrypted",
      "credential_version",
      "status",
      "last_verified_at",
      "last_error",
      "created_at",
      "updated_at"
    ]);
    await this.pool.query(`
      create table if not exists binance_connections (
        id uuid primary key,
        trading_account_id uuid not null unique references trading_accounts(id) on delete cascade,
        api_key_encrypted text not null,
        api_secret_encrypted text not null,
        credential_version integer not null default 1,
        status varchar(20) not null,
        last_verified_at timestamptz,
        last_error text,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
    await this.pool.query(`create index if not exists binance_connections_status_idx on binance_connections(status)`);
  }

  async createTradingAccount(input: CreateTradingAccountInput): Promise<TradingAccount> {
    const result = await this.pool.query(
      `insert into trading_accounts (id, user_id, name, mode, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, user_id, name, mode, status, created_at, updated_at`,
      [input.id, input.userId, input.name, input.mode, input.status, input.createdAt, input.updatedAt]
    );
    const account = toTradingAccount(result.rows[0]);
    if (!account) throw new Error("Failed to create trading account");
    return account;
  }

  async listTradingAccounts(userId: string): Promise<TradingAccount[]> {
    const result = await this.pool.query(
      `select id, user_id, name, mode, status, created_at, updated_at
       from trading_accounts where user_id = $1 order by created_at asc`,
      [userId]
    );
    return result.rows.map(toTradingAccount).filter((account): account is TradingAccount => account !== null);
  }

  async findTradingAccountById(id: string): Promise<TradingAccount | null> {
    const result = await this.pool.query(
      `select id, user_id, name, mode, status, created_at, updated_at from trading_accounts where id = $1 limit 1`,
      [id]
    );
    return toTradingAccount(result.rows[0]);
  }

  async updateTradingAccountStatus(id: string, status: TradingAccountStatus, updatedAt: string): Promise<void> {
    await this.pool.query(`update trading_accounts set status = $2, updated_at = $3 where id = $1`, [id, status, updatedAt]);
  }

  async upsertBinanceConnection(connection: BinanceConnection): Promise<BinanceConnection> {
    const result = await this.pool.query(
      `insert into binance_connections (
         id, trading_account_id, api_key_encrypted, api_secret_encrypted, credential_version,
         status, last_verified_at, last_error, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (trading_account_id) do update set
         api_key_encrypted = excluded.api_key_encrypted,
         api_secret_encrypted = excluded.api_secret_encrypted,
         credential_version = excluded.credential_version,
         status = excluded.status,
         last_verified_at = excluded.last_verified_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at
       returning id, trading_account_id, api_key_encrypted, api_secret_encrypted, credential_version,
         status, last_verified_at, last_error, created_at, updated_at`,
      [
        connection.id,
        connection.tradingAccountId,
        connection.apiKeyEncrypted,
        connection.apiSecretEncrypted,
        connection.credentialVersion,
        connection.status,
        connection.lastVerifiedAt,
        connection.lastError,
        connection.createdAt,
        connection.updatedAt
      ]
    );
    const saved = toBinanceConnection(result.rows[0]);
    if (!saved) throw new Error("Failed to save Binance connection");
    return saved;
  }

  async findBinanceConnection(tradingAccountId: string): Promise<BinanceConnection | null> {
    const result = await this.pool.query(
      `select id, trading_account_id, api_key_encrypted, api_secret_encrypted, credential_version,
        status, last_verified_at, last_error, created_at, updated_at
       from binance_connections where trading_account_id = $1 limit 1`,
      [tradingAccountId]
    );
    return toBinanceConnection(result.rows[0]);
  }

  async deleteBinanceConnection(tradingAccountId: string): Promise<void> {
    await this.pool.query(`delete from binance_connections where trading_account_id = $1`, [tradingAccountId]);
  }

  private async ensureCompatibleTable(tableName: string, requiredColumns: string[]): Promise<void> {
    const result = await this.pool.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tableName]
    );
    if (result.rows.length === 0) return;

    const columns = new Set((result.rows as Array<{ column_name: string }>).map((row) => row.column_name));
    if (requiredColumns.every((column) => columns.has(column))) return;

    const legacyName = `${tableName}_legacy_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    await this.pool.query(`alter table ${tableName} rename to ${legacyName}`);
  }
}

export async function createTradingAccountRepository(databaseUrl?: string): Promise<TradingAccountRepository> {
  if (!databaseUrl) return new MemoryTradingAccountRepository();
  const repository = new PostgresTradingAccountRepository(databaseUrl);
  await repository.migrate();
  return repository;
}

function toTradingAccount(row: unknown): TradingAccount | null {
  if (!isRecord(row)) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    mode: row.mode === "REAL" ? "REAL" : "DEMO",
    status: toAccountStatus(row.status),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toBinanceConnection(row: unknown): BinanceConnection | null {
  if (!isRecord(row)) return null;
  return {
    id: String(row.id),
    tradingAccountId: String(row.trading_account_id),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiSecretEncrypted: String(row.api_secret_encrypted),
    credentialVersion: Number(row.credential_version ?? 1),
    status: row.status === "CONNECTED" || row.status === "ERROR" ? row.status : "NOT_CONFIGURED",
    lastVerifiedAt: row.last_verified_at ? toIso(row.last_verified_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toAccountStatus(value: unknown): TradingAccountStatus {
  if (value === "CONNECTED" || value === "DISCONNECTED" || value === "ERROR") return value;
  return "PENDING";
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}
