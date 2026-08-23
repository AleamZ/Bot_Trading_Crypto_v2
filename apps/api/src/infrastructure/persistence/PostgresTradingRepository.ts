import pg from "pg";
import { getPostgresPool } from "./PgPoolFactory.js";
import { recordSchemaMigration } from "./SchemaMigrations.js";
import type { TradingRepository } from "../../application/ports/Repositories.js";
import type { DomainEvent } from "../../domain/events/DomainEvent.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import type { TradingSettings } from "../../application/config/AppConfig.js";
import { MemoryTradingRepository } from "./MemoryTradingRepository.js";
import type { RepositoryStatus } from "./RepositoryStatus.js";

export class PostgresTradingRepository implements TradingRepository {
  private readonly pool: pg.Pool;
  private readonly memoryMirror = new MemoryTradingRepository({
    database: "postgres",
    connected: true,
    reason: "Postgres migration succeeded"
  });
  private eventSequence = 0;
  private riskSequence = 0;

  constructor(
    connectionString: string,
    private readonly tradingAccountId: string | null = null
  ) {
    this.pool = getPostgresPool(connectionString);
  }

  async migrate(): Promise<void> {
    await recordSchemaMigration(this.pool, "005_trading_records", "account scoped trading records");
    await this.pool.query(`
      create table if not exists trading_records (
        id text primary key,
        kind text not null,
        symbol text,
        trading_account_id uuid,
        payload jsonb not null,
        created_at timestamptz not null default now()
      )
    `);
    await this.pool.query(`alter table trading_records add column if not exists trading_account_id uuid`);
    await this.pool.query(`create index if not exists trading_records_account_id_idx on trading_records(trading_account_id)`);
  }

  async saveFvg(fvg: Fvg): Promise<void> {
    await this.memoryMirror.saveFvg(fvg);
    await this.upsert(`${this.recordPrefix()}${fvg.id}`, "fvg", fvg.symbol, fvg);
  }

  async updateFvg(fvg: Fvg): Promise<void> {
    await this.saveFvg(fvg);
  }

  async getActiveOrWaitingFvg(symbol: string, timeframe?: Fvg["timeframe"]): Promise<Fvg | null> {
    const result = await this.pool.query(
      `select payload from trading_records
       where kind = 'fvg' and symbol = $1 and ($2::text is null or payload->>'timeframe' = $2)
         and (($3::uuid is null and trading_account_id is null) or trading_account_id = $3::uuid)
       order by (payload->>'createdAt')::numeric desc`,
      [symbol, timeframe ?? null, this.tradingAccountId]
    );
    for (const row of result.rows as Array<{ payload: Fvg }>) {
      if (isUsableFvgStatus(row.payload.status)) {
        return row.payload;
      }
    }
    return null;
  }

  async saveSignal(signal: MarketStructureSignal): Promise<void> {
    await this.memoryMirror.saveSignal(signal);
    await this.upsert(`${this.recordPrefix()}${signal.id}`, "signal", signal.symbol, signal);
  }

  async saveRiskDecision(decision: RiskDecision): Promise<void> {
    await this.memoryMirror.saveRiskDecision(decision);
    this.riskSequence += 1;
    await this.upsert(`${this.recordPrefix()}risk:${this.riskSequence}:${decision.accepted}`, "risk", null, decision);
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.memoryMirror.appendEvent(event);
    this.eventSequence += 1;
    await this.upsert(`${this.recordPrefix()}event:${event.at}:${event.type}:${this.eventSequence}`, "event", "symbol" in event ? event.symbol : null, event);
  }

  async getTradingSettings(): Promise<TradingSettings | null> {
    const result = await this.pool.query(
      `select payload from trading_records where id = $1 and kind = 'settings'
       and (($2::uuid is null and trading_account_id is null) or trading_account_id = $2::uuid)
       limit 1`,
      [`${this.recordPrefix()}settings:active`, this.tradingAccountId]
    );
    const row = result.rows[0] as { payload: TradingSettings } | undefined;
    return row?.payload ?? null;
  }

  async saveTradingSettings(settings: TradingSettings): Promise<void> {
    await this.memoryMirror.saveTradingSettings(settings);
    await this.upsert(`${this.recordPrefix()}settings:active`, "settings", null, settings);
  }

  async getDashboardSnapshot(): Promise<unknown> {
    if (this.tradingAccountId === null) return this.memoryMirror.getDashboardSnapshot();
    const result = await this.pool.query(
      `select kind, payload from trading_records
       where trading_account_id = $1
       order by created_at asc`,
      [this.tradingAccountId]
    );
    const fvgs = result.rows.filter((row: { kind: string }) => row.kind === "fvg").map((row: { payload: Fvg }) => row.payload);
    const signals = result.rows.filter((row: { kind: string }) => row.kind === "signal").map((row: { payload: MarketStructureSignal }) => row.payload);
    const risks = result.rows.filter((row: { kind: string }) => row.kind === "risk").map((row: { payload: RiskDecision }) => row.payload);
    const events = result.rows.filter((row: { kind: string }) => row.kind === "event").map((row: { payload: DomainEvent }) => row.payload);
    return {
      currentFvg: fvgs.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentHtfFvg: fvgs.filter((fvg) => fvg.timeframe === "H1").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentLtfFvg: fvgs.filter((fvg) => fvg.timeframe === "M5").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      currentSignal: signals.at(-1) ?? null,
      riskStatus: risks.at(-1) ?? null,
      tradingSettings: await this.getTradingSettings(),
      events: events.slice(-100),
      connectionStatus: "postgres",
      databaseStatus: { database: "postgres", connected: true, reason: "Postgres migration succeeded" }
    };
  }

  private async upsert(id: string, kind: string, symbol: string | null, payload: unknown): Promise<void> {
    await this.pool.query(
      `insert into trading_records (id, kind, symbol, trading_account_id, payload)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set payload = excluded.payload, trading_account_id = excluded.trading_account_id`,
      [id, kind, symbol, this.tradingAccountId, payload]
    );
  }

  private recordPrefix(): string {
    return this.tradingAccountId ? `account:${this.tradingAccountId}:` : "";
  }
}

function isUsableFvgStatus(status: Fvg["status"]): boolean {
  return status === "untouched" || status === "touched" || status === "active" || status === "waiting-mitigation";
}

export async function createRepository(databaseUrl?: string): Promise<TradingRepository> {
  if (!databaseUrl) {
    return new MemoryTradingRepository();
  }

  try {
    const repository = new PostgresTradingRepository(databaseUrl);
    await repository.migrate();
    return repository;
  } catch (error) {
    return new MemoryTradingRepository({
      database: "memory",
      connected: true,
      reason: `Postgres unavailable; using memory fallback: ${sanitizeDatabaseError(error)}`
    });
  }
}


function sanitizeDatabaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^@]+@/gi, "postgresql://***@");
}
