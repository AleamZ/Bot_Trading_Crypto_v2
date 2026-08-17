import pg from "pg";

const pools = new Map<string, pg.Pool>();

export function getPostgresPool(connectionString: string): pg.Pool {
  const cached = pools.get(connectionString);
  if (cached) return cached;

  const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined;
  const max = readPoolMax();
  const pool = new pg.Pool(ssl ? { connectionString, ssl, max } : { connectionString, max });
  pools.set(connectionString, pool);
  return pool;
}

function readPoolMax(): number {
  const value = Number(process.env.POSTGRES_POOL_MAX ?? process.env.PG_POOL_MAX ?? 2);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}
