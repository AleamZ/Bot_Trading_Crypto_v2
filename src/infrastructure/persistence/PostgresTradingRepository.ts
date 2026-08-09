import pg from "pg";
import type { TradingRepository } from "../../application/ports/Repositories.js";
import type { DomainEvent } from "../../domain/events/DomainEvent.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
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

  constructor(connectionString: string) {
    const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined;
    this.pool = ssl ? new pg.Pool({ connectionString, ssl }) : new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      create table if not exists trading_records (
        id text primary key,
        kind text not null,
        symbol text,
        payload jsonb not null,
        created_at timestamptz not null default now()
      )
    `);
  }

  async saveFvg(fvg: Fvg): Promise<void> {
    await this.memoryMirror.saveFvg(fvg);
    await this.upsert(fvg.id, "fvg", fvg.symbol, fvg);
  }

  async updateFvg(fvg: Fvg): Promise<void> {
    await this.saveFvg(fvg);
  }

  async getActiveOrWaitingFvg(symbol: string, timeframe?: Fvg["timeframe"]): Promise<Fvg | null> {
    const result = await this.pool.query(
      `select payload from trading_records
       where kind = 'fvg' and symbol = $1 and ($2::text is null or payload->>'timeframe' = $2)
       order by (payload->>'createdAt')::numeric desc`,
      [symbol, timeframe ?? null]
    );
    for (const row of result.rows as Array<{ payload: Fvg }>) {
      if (row.payload.status === "active" || row.payload.status === "waiting-mitigation") {
        return row.payload;
      }
    }
    return null;
  }

  async saveSignal(signal: MarketStructureSignal): Promise<void> {
    await this.memoryMirror.saveSignal(signal);
    await this.upsert(signal.id, "signal", signal.symbol, signal);
  }

  async saveRiskDecision(decision: RiskDecision): Promise<void> {
    await this.memoryMirror.saveRiskDecision(decision);
    this.riskSequence += 1;
    await this.upsert(`risk:${this.riskSequence}:${decision.accepted}`, "risk", null, decision);
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.memoryMirror.appendEvent(event);
    this.eventSequence += 1;
    await this.upsert(`event:${event.at}:${event.type}:${this.eventSequence}`, "event", "symbol" in event ? event.symbol : null, event);
  }

  async getDashboardSnapshot(): Promise<unknown> {
    return this.memoryMirror.getDashboardSnapshot();
  }

  private async upsert(id: string, kind: string, symbol: string | null, payload: unknown): Promise<void> {
    await this.pool.query(
      `insert into trading_records (id, kind, symbol, payload)
       values ($1, $2, $3, $4)
       on conflict (id) do update set payload = excluded.payload`,
      [id, kind, symbol, payload]
    );
  }
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

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}

function sanitizeDatabaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^@]+@/gi, "postgresql://***@");
}
