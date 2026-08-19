import pg from "pg";
import { getPostgresPool } from "../persistence/PgPoolFactory.js";
import { recordSchemaMigration } from "../persistence/SchemaMigrations.js";
import type { CreateExecutionIntentInput, ExecutionAuditEvent, ExecutionIntent, ExecutionIntentStatus } from "../../application/execution/ExecutionIntent.js";
import type { ExecutionIntentRepository } from "../../application/execution/ExecutionIntentRepository.js";
import { MemoryExecutionIntentRepository } from "./MemoryExecutionIntentRepository.js";

export class PostgresExecutionIntentRepository implements ExecutionIntentRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = getPostgresPool(connectionString);
  }

  async migrate(): Promise<void> {
    await recordSchemaMigration(this.pool, "004_execution_intents", "execution intents and audit events");
    await this.pool.query(`
      create table if not exists execution_intents (
        id uuid primary key,
        trading_account_id uuid not null references trading_accounts(id) on delete cascade,
        symbol varchar(20) not null,
        side varchar(12) not null,
        setup_key varchar(512) not null,
        status varchar(40) not null,
        entry_type varchar(20),
        requested_entry numeric,
        requested_stop_loss numeric,
        requested_take_profit numeric,
        quantity numeric,
        binance_entry_order_id varchar(120),
        binance_stop_order_id varchar(120),
        binance_take_profit_order_id varchar(120),
        client_entry_order_id varchar(120),
        client_stop_order_id varchar(120),
        client_take_profit_order_id varchar(120),
        source varchar(20) not null default 'BOT',
        version integer not null default 0,
        last_error text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (trading_account_id, setup_key)
      )
    `);
    await this.pool.query(`create index if not exists execution_intents_account_status_idx on execution_intents(trading_account_id, status)`);
    await this.pool.query(`
      create table if not exists execution_audit_events (
        id uuid primary key,
        trading_account_id uuid not null references trading_accounts(id) on delete cascade,
        execution_intent_id uuid,
        symbol varchar(20),
        type varchar(80) not null,
        metadata jsonb not null,
        created_at timestamptz not null
      )
    `);
    await this.pool.query(`create index if not exists execution_audit_account_created_idx on execution_audit_events(trading_account_id, created_at desc)`);
  }

  async createOrGet(input: CreateExecutionIntentInput): Promise<{ intent: ExecutionIntent; created: boolean }> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `insert into execution_intents (
         id, trading_account_id, symbol, side, setup_key, status, entry_type,
         requested_entry, requested_stop_loss, requested_take_profit, quantity,
         client_entry_order_id, client_stop_order_id, client_take_profit_order_id,
         source, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, 'CREATED', $6, $7, $8, $9, $10, $11, $12, $13, 'BOT', $14, $14)
       on conflict (trading_account_id, setup_key) do nothing
       returning *`,
      [
        input.id,
        input.tradingAccountId,
        input.symbol,
        input.side,
        input.setupKey,
        input.entryType,
        input.requestedEntry,
        input.requestedStopLoss,
        input.requestedTakeProfit,
        input.quantity,
        input.clientEntryOrderId,
        input.clientStopOrderId,
        input.clientTakeProfitOrderId,
        now
      ]
    );
    if (result.rows[0]) return { intent: toExecutionIntent(result.rows[0]), created: true };
    const existing = await this.findBySetupKey(input.tradingAccountId, input.setupKey);
    if (!existing) throw new Error("Execution intent conflict could not be read");
    return { intent: existing, created: false };
  }

  async findBySetupKey(tradingAccountId: string, setupKey: string): Promise<ExecutionIntent | null> {
    const result = await this.pool.query(`select * from execution_intents where trading_account_id = $1 and setup_key = $2 limit 1`, [tradingAccountId, setupKey]);
    return result.rows[0] ? toExecutionIntent(result.rows[0]) : null;
  }

  async listByAccount(tradingAccountId: string, limit = 100): Promise<ExecutionIntent[]> {
    const result = await this.pool.query(`select * from execution_intents where trading_account_id = $1 order by updated_at desc limit $2`, [tradingAccountId, limit]);
    return result.rows.map(toExecutionIntent);
  }

  async listOpenByAccount(tradingAccountId: string): Promise<ExecutionIntent[]> {
    const result = await this.pool.query(
      `select * from execution_intents
       where trading_account_id = $1 and status not in ('CLOSED', 'CANCELLED', 'FAILED')
       order by updated_at desc`,
      [tradingAccountId]
    );
    return result.rows.map(toExecutionIntent);
  }

  async transitionStatus(id: string, expected: ExecutionIntentStatus[], next: ExecutionIntentStatus, patch: Partial<ExecutionIntent> = {}): Promise<ExecutionIntent | null> {
    const result = await this.pool.query(
      `update execution_intents set
         status = $3,
         binance_entry_order_id = coalesce($4, binance_entry_order_id),
         binance_stop_order_id = coalesce($5, binance_stop_order_id),
         binance_take_profit_order_id = coalesce($6, binance_take_profit_order_id),
         client_entry_order_id = coalesce($7, client_entry_order_id),
         client_stop_order_id = coalesce($8, client_stop_order_id),
         client_take_profit_order_id = coalesce($9, client_take_profit_order_id),
         source = coalesce($10, source),
         last_error = $11,
         version = version + 1,
         updated_at = $12
       where id = $1 and status = any($2::text[])
       returning *`,
      [
        id,
        expected,
        next,
        patch.binanceEntryOrderId ?? null,
        patch.binanceStopOrderId ?? null,
        patch.binanceTakeProfitOrderId ?? null,
        patch.clientEntryOrderId ?? null,
        patch.clientStopOrderId ?? null,
        patch.clientTakeProfitOrderId ?? null,
        patch.source ?? null,
        patch.lastError ?? null,
        new Date().toISOString()
      ]
    );
    return result.rows[0] ? toExecutionIntent(result.rows[0]) : null;
  }

  async saveAuditEvent(event: ExecutionAuditEvent): Promise<void> {
    await this.pool.query(
      `insert into execution_audit_events (id, trading_account_id, execution_intent_id, symbol, type, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, event.tradingAccountId, event.executionIntentId, event.symbol, event.type, event.metadata, event.createdAt]
    );
  }

  async listAuditEvents(tradingAccountId: string, executionIntentId?: string, limit = 100): Promise<ExecutionAuditEvent[]> {
    const result = await this.pool.query(
      `select * from execution_audit_events
       where trading_account_id = $1 and ($2::uuid is null or execution_intent_id = $2::uuid)
       order by created_at desc limit $3`,
      [tradingAccountId, executionIntentId ?? null, limit]
    );
    return result.rows.map(toAuditEvent);
  }

  async deleteAccountData(tradingAccountId: string): Promise<void> {
    await this.pool.query("begin");
    try {
      await this.pool.query(`delete from execution_audit_events where trading_account_id = $1`, [tradingAccountId]);
      await this.pool.query(`delete from execution_intents where trading_account_id = $1`, [tradingAccountId]);
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }
}

export async function createExecutionIntentRepository(databaseUrl?: string): Promise<ExecutionIntentRepository> {
  if (!databaseUrl) return new MemoryExecutionIntentRepository();
  const repository = new PostgresExecutionIntentRepository(databaseUrl);
  await repository.migrate();
  return repository;
}

function toExecutionIntent(row: Record<string, unknown>): ExecutionIntent {
  return {
    id: String(row.id),
    tradingAccountId: String(row.trading_account_id),
    symbol: String(row.symbol),
    side: row.side === "short" ? "short" : "long",
    setupKey: String(row.setup_key),
    status: String(row.status) as ExecutionIntentStatus,
    entryType: row.entry_type === "limit" || row.entry_type === "market" ? row.entry_type : null,
    requestedEntry: numberOrNull(row.requested_entry),
    requestedStopLoss: numberOrNull(row.requested_stop_loss),
    requestedTakeProfit: numberOrNull(row.requested_take_profit),
    quantity: numberOrNull(row.quantity),
    binanceEntryOrderId: stringOrNull(row.binance_entry_order_id),
    binanceStopOrderId: stringOrNull(row.binance_stop_order_id),
    binanceTakeProfitOrderId: stringOrNull(row.binance_take_profit_order_id),
    clientEntryOrderId: stringOrNull(row.client_entry_order_id),
    clientStopOrderId: stringOrNull(row.client_stop_order_id),
    clientTakeProfitOrderId: stringOrNull(row.client_take_profit_order_id),
    source: row.source === "EXTERNAL" || row.source === "UNKNOWN" ? row.source : "BOT",
    version: Number(row.version ?? 0),
    lastError: stringOrNull(row.last_error),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toAuditEvent(row: Record<string, unknown>): ExecutionAuditEvent {
  return {
    id: String(row.id),
    tradingAccountId: String(row.trading_account_id),
    executionIntentId: stringOrNull(row.execution_intent_id),
    symbol: stringOrNull(row.symbol),
    type: String(row.type),
    metadata: typeof row.metadata === "object" && row.metadata !== null ? (row.metadata as Record<string, unknown>) : {},
    createdAt: toIso(row.created_at)
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
