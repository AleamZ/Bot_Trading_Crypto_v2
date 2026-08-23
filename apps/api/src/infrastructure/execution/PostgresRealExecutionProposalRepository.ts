import pg from "pg";
import type { CreateRealExecutionProposalInput, RealExecutionProposal, RealExecutionProposalStatus } from "../../application/execution/RealExecutionProposal.js";
import type { RealExecutionProposalRepository } from "../../application/execution/RealExecutionProposalRepository.js";
import { getPostgresPool } from "../persistence/PgPoolFactory.js";
import { recordSchemaMigration } from "../persistence/SchemaMigrations.js";
import { MemoryRealExecutionProposalRepository } from "./MemoryRealExecutionProposalRepository.js";

export class PostgresRealExecutionProposalRepository implements RealExecutionProposalRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = getPostgresPool(connectionString);
  }

  async migrate(): Promise<void> {
    await recordSchemaMigration(this.pool, "005_real_execution_proposals", "real execution proposals");
    await this.pool.query(`
      create table if not exists real_execution_proposals (
        id uuid primary key,
        trading_account_id uuid not null references trading_accounts(id) on delete cascade,
        setup_key varchar(512) not null,
        symbol varchar(20) not null,
        direction varchar(12) not null,
        status varchar(40) not null,
        requested_entry_type varchar(20) not null,
        requested_entry_price numeric not null,
        normalized_entry_price numeric,
        requested_quantity numeric not null,
        normalized_quantity numeric not null,
        requested_stop_loss numeric not null,
        normalized_stop_loss numeric not null,
        requested_take_profit numeric not null,
        normalized_take_profit numeric not null,
        estimated_notional numeric not null,
        estimated_margin numeric not null,
        configured_leverage numeric not null,
        configured_margin_mode varchar(20) not null,
        symbol_tick_size numeric not null,
        symbol_step_size numeric not null,
        symbol_min_qty numeric not null,
        symbol_min_notional numeric,
        proposal_hash varchar(128) not null,
        strategy_snapshot jsonb not null,
        risk_snapshot jsonb not null,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        approved_at timestamptz,
        approved_by_user_id uuid,
        executed_at timestamptz,
        rejected_at timestamptz,
        cancelled_at timestamptz,
        execution_intent_id uuid,
        unique (trading_account_id, setup_key)
      )
    `);
    await this.pool.query(`create index if not exists real_execution_proposals_account_created_idx on real_execution_proposals(trading_account_id, created_at desc)`);
  }

  async createOrGet(input: CreateRealExecutionProposalInput): Promise<{ proposal: RealExecutionProposal; created: boolean }> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `insert into real_execution_proposals (
        id, trading_account_id, setup_key, symbol, direction, status, requested_entry_type,
        requested_entry_price, normalized_entry_price, requested_quantity, normalized_quantity,
        requested_stop_loss, normalized_stop_loss, requested_take_profit, normalized_take_profit,
        estimated_notional, estimated_margin, configured_leverage, configured_margin_mode,
        symbol_tick_size, symbol_step_size, symbol_min_qty, symbol_min_notional,
        proposal_hash, strategy_snapshot, risk_snapshot, created_at, expires_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
      ) on conflict (trading_account_id, setup_key) do nothing returning *`,
      [
        input.id,
        input.tradingAccountId,
        input.setupKey,
        input.symbol,
        input.direction,
        input.status,
        input.requestedEntryType,
        input.requestedEntryPrice,
        input.normalizedEntryPrice,
        input.requestedQuantity,
        input.normalizedQuantity,
        input.requestedStopLoss,
        input.normalizedStopLoss,
        input.requestedTakeProfit,
        input.normalizedTakeProfit,
        input.estimatedNotional,
        input.estimatedMargin,
        input.configuredLeverage,
        input.configuredMarginMode,
        input.symbolTickSize,
        input.symbolStepSize,
        input.symbolMinQty,
        input.symbolMinNotional,
        input.proposalHash,
        input.strategySnapshot,
        input.riskSnapshot,
        now,
        input.expiresAt
      ]
    );
    if (result.rows[0]) return { proposal: toProposal(result.rows[0]), created: true };
    const existing = await this.findBySetupKey(input.tradingAccountId, input.setupKey);
    if (!existing) throw new Error("Real execution proposal conflict could not be read");
    return { proposal: existing, created: false };
  }

  async findById(tradingAccountId: string, proposalId: string): Promise<RealExecutionProposal | null> {
    const result = await this.pool.query(`select * from real_execution_proposals where trading_account_id = $1 and id = $2 limit 1`, [tradingAccountId, proposalId]);
    return result.rows[0] ? toProposal(result.rows[0]) : null;
  }

  async findBySetupKey(tradingAccountId: string, setupKey: string): Promise<RealExecutionProposal | null> {
    const result = await this.pool.query(`select * from real_execution_proposals where trading_account_id = $1 and setup_key = $2 limit 1`, [tradingAccountId, setupKey]);
    return result.rows[0] ? toProposal(result.rows[0]) : null;
  }

  async listByAccount(tradingAccountId: string, limit = 100): Promise<RealExecutionProposal[]> {
    const result = await this.pool.query(`select * from real_execution_proposals where trading_account_id = $1 order by created_at desc limit $2`, [tradingAccountId, limit]);
    return result.rows.map(toProposal);
  }

  async transitionStatus(
    tradingAccountId: string,
    proposalId: string,
    expected: RealExecutionProposalStatus[],
    next: RealExecutionProposalStatus,
    patch: Partial<RealExecutionProposal> = {}
  ): Promise<RealExecutionProposal | null> {
    const result = await this.pool.query(
      `update real_execution_proposals set
         status = $4,
         approved_at = coalesce($5, approved_at),
         approved_by_user_id = coalesce($6, approved_by_user_id),
         rejected_at = coalesce($7, rejected_at),
         cancelled_at = coalesce($8, cancelled_at),
         executed_at = coalesce($9, executed_at),
         execution_intent_id = coalesce($10, execution_intent_id)
       where trading_account_id = $1 and id = $2 and status = any($3::text[])
       returning *`,
      [
        tradingAccountId,
        proposalId,
        expected,
        next,
        patch.approvedAt ?? null,
        patch.approvedByUserId ?? null,
        patch.rejectedAt ?? null,
        patch.cancelledAt ?? null,
        patch.executedAt ?? null,
        patch.executionIntentId ?? null
      ]
    );
    return result.rows[0] ? toProposal(result.rows[0]) : null;
  }

  async expireOpen(nowIso: string): Promise<number> {
    const result = await this.pool.query(`update real_execution_proposals set status = 'EXPIRED' where status = 'PENDING' and expires_at <= $1`, [nowIso]);
    return result.rowCount ?? 0;
  }

  async deleteAccountData(tradingAccountId: string): Promise<void> {
    await this.pool.query(`delete from real_execution_proposals where trading_account_id = $1`, [tradingAccountId]);
  }
}

export async function createRealExecutionProposalRepository(databaseUrl?: string): Promise<RealExecutionProposalRepository> {
  if (!databaseUrl) return new MemoryRealExecutionProposalRepository();
  const repository = new PostgresRealExecutionProposalRepository(databaseUrl);
  await repository.migrate().catch((error: unknown) => {
    console.warn(`[postgres] real execution proposal migration skipped during startup: ${error instanceof Error ? error.message : String(error)}`);
  });
  return repository;
}

function toProposal(row: Record<string, unknown>): RealExecutionProposal {
  return {
    id: String(row.id),
    tradingAccountId: String(row.trading_account_id),
    setupKey: String(row.setup_key),
    symbol: String(row.symbol),
    direction: row.direction === "bearish" ? "bearish" : "bullish",
    status: String(row.status) as RealExecutionProposalStatus,
    requestedEntryType: row.requested_entry_type === "limit" ? "limit" : "market",
    requestedEntryPrice: Number(row.requested_entry_price),
    normalizedEntryPrice: numberOrNull(row.normalized_entry_price),
    requestedQuantity: Number(row.requested_quantity),
    normalizedQuantity: Number(row.normalized_quantity),
    requestedStopLoss: Number(row.requested_stop_loss),
    normalizedStopLoss: Number(row.normalized_stop_loss),
    requestedTakeProfit: Number(row.requested_take_profit),
    normalizedTakeProfit: Number(row.normalized_take_profit),
    estimatedNotional: Number(row.estimated_notional),
    estimatedMargin: Number(row.estimated_margin),
    configuredLeverage: Number(row.configured_leverage),
    configuredMarginMode: row.configured_margin_mode === "CROSS" ? "CROSS" : "ISOLATED",
    symbolTickSize: Number(row.symbol_tick_size),
    symbolStepSize: Number(row.symbol_step_size),
    symbolMinQty: Number(row.symbol_min_qty),
    symbolMinNotional: numberOrNull(row.symbol_min_notional),
    proposalHash: String(row.proposal_hash),
    strategySnapshot: objectOrEmpty(row.strategy_snapshot),
    riskSnapshot: objectOrEmpty(row.risk_snapshot),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    approvedAt: stringOrNullIso(row.approved_at),
    approvedByUserId: stringOrNull(row.approved_by_user_id),
    executedAt: stringOrNullIso(row.executed_at),
    rejectedAt: stringOrNullIso(row.rejected_at),
    cancelledAt: stringOrNullIso(row.cancelled_at),
    executionIntentId: stringOrNull(row.execution_intent_id)
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

function stringOrNullIso(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
