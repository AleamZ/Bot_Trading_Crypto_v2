import pg from "pg";

const pools = new Map<string, pg.Pool>();

export function getPostgresPool(connectionString: string): pg.Pool {
  const cached = pools.get(connectionString);
  if (cached) return cached;

  const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined;
  const max = readPoolMax();
  const options = {
    connectionString,
    max,
    idleTimeoutMillis: readMillis("POSTGRES_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: readMillis("POSTGRES_CONNECTION_TIMEOUT_MS", 5_000),
    query_timeout: readMillis("POSTGRES_QUERY_TIMEOUT_MS", 10_000)
  };
  const pool = new pg.Pool(ssl ? { ...options, ssl } : options);
  pool.on("error", (error) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        component: "postgres-pool",
        message: "PostgreSQL pool client error",
        error: error.message
      })
    );
  });
  pools.set(connectionString, pool);
  return pool;
}

export async function closeAllPostgresPools(): Promise<void> {
  const active = [...pools.values()];
  pools.clear();
  await Promise.all(active.map((pool) => pool.end()));
}

export function getPostgresPoolStats(): Array<{ total: number; idle: number; waiting: number }> {
  return [...pools.values()].map((pool) => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  }));
}

function readPoolMax(): number {
  const value = Number(process.env.POSTGRES_POOL_MAX ?? process.env.PG_POOL_MAX ?? 2);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

function readMillis(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.trunc(value));
}

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}
