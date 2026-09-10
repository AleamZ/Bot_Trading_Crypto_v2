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
    min: 0,
    maxLifetimeSeconds: readSeconds("POSTGRES_MAX_LIFETIME_SECONDS", 300),
    idleTimeoutMillis: readMillis("POSTGRES_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: readMillis("POSTGRES_CONNECTION_TIMEOUT_MS", 5_000),
    query_timeout: readMillis("POSTGRES_QUERY_TIMEOUT_MS", 30_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: readMillis("POSTGRES_KEEPALIVE_INITIAL_DELAY_MS", 10_000)
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

export async function withPostgresStartupRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const maxAttempts = readAttempts("POSTGRES_STARTUP_MAX_ATTEMPTS", 5);
  const baseDelayMs = readMillis("POSTGRES_STARTUP_RETRY_DELAY_MS", 250);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientPostgresError(error) || attempt >= maxAttempts) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        component: "postgres-startup",
        message: "Transient PostgreSQL startup failure; retrying",
        label,
        attempt,
        maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error)
      }));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function verifyPostgresConnection(connectionString: string): Promise<void> {
  const pool = getPostgresPool(connectionString);
  await withPostgresStartupRetry("initial connection", () => pool.query("select 1"));
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

function readAttempts(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(5, Math.trunc(value)));
}

function readSeconds(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(3_600, Math.trunc(value)));
}

function isTransientPostgresError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "57P01", "57P03"].includes(code) || message === "Query read timeout";
}

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}
