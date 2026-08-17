import pg from "pg";
import type { AuthRepository } from "../../application/auth/AuthRepository.js";
import { DuplicateEmailError } from "../../application/auth/AuthRepository.js";
import type { User, UserSession } from "../../domain/auth/User.js";
import { MemoryAuthRepository } from "./MemoryAuthRepository.js";

export class PostgresAuthRepository implements AuthRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined;
    this.pool = ssl ? new pg.Pool({ connectionString, ssl }) : new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.ensurePhaseOneUsersTable();

    await this.pool.query(`
      create table if not exists users (
        id uuid primary key,
        email varchar(254) unique not null,
        password_hash text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);

    await this.pool.query(`
      create table if not exists user_sessions (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        token_hash text unique not null,
        expires_at timestamptz not null,
        created_at timestamptz not null
      )
    `);

    await this.pool.query(`create index if not exists user_sessions_user_id_idx on user_sessions(user_id)`);
    await this.pool.query(`create index if not exists user_sessions_expires_at_idx on user_sessions(expires_at)`);
  }

  private async ensurePhaseOneUsersTable(): Promise<void> {
    const columns = await this.pool.query(
      `select column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = 'users'`
    );
    if (columns.rows.length === 0) return;

    const byName = new Map(
      (columns.rows as Array<{ column_name: string; data_type: string; is_nullable: string }>).map((column) => [column.column_name, column])
    );
    const hasEmailUnique = await this.hasUniqueConstraint("users", ["email"]);
    const phaseOneCompatible =
      byName.get("id")?.data_type === "uuid" &&
      byName.get("email")?.is_nullable === "NO" &&
      byName.get("password_hash")?.is_nullable === "NO" &&
      byName.get("created_at")?.is_nullable === "NO" &&
      byName.get("updated_at")?.is_nullable === "NO" &&
      hasEmailUnique;

    if (phaseOneCompatible) return;

    const legacyName = `users_legacy_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    await this.pool.query("begin");
    try {
      await this.pool.query(`drop table if exists user_sessions`);
      await this.pool.query(`alter table users rename to ${legacyName}`);
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  private async hasUniqueConstraint(tableName: string, columnNames: string[]): Promise<boolean> {
    const result = await this.pool.query(
      `select array_agg(a.attname order by a.attnum) as columns
       from pg_constraint c
       join pg_class t on c.conrelid = t.oid
       join pg_namespace n on n.oid = t.relnamespace
       join unnest(c.conkey) with ordinality as ck(attnum, ord) on true
       join pg_attribute a on a.attrelid = t.oid and a.attnum = ck.attnum
       where n.nspname = 'public' and t.relname = $1 and c.contype in ('u', 'p')
       group by c.oid`,
      [tableName]
    );
    return (result.rows as Array<{ columns: string[] | string }>).some((row) => normalizeConstraintColumns(row.columns).join(",") === columnNames.join(","));
  }

  async createUser(user: User): Promise<User> {
    try {
      await this.pool.query(
        `insert into users (id, email, password_hash, created_at, updated_at)
         values ($1, $2, $3, $4, $5)`,
        [user.id, user.email, user.passwordHash, user.createdAt, user.updatedAt]
      );
      return user;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query(
      `select id, email, password_hash, created_at, updated_at from users where email = $1 limit 1`,
      [email]
    );
    return toUser(result.rows[0]);
  }

  async findUserById(id: string): Promise<User | null> {
    const result = await this.pool.query(
      `select id, email, password_hash, created_at, updated_at from users where id = $1 limit 1`,
      [id]
    );
    return toUser(result.rows[0]);
  }

  async createSession(session: UserSession): Promise<UserSession> {
    await this.pool.query(
      `insert into user_sessions (id, user_id, token_hash, expires_at, created_at)
       values ($1, $2, $3, $4, $5)`,
      [session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt]
    );
    return session;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<UserSession | null> {
    const result = await this.pool.query(
      `select id, user_id, token_hash, expires_at, created_at from user_sessions where token_hash = $1 limit 1`,
      [tokenHash]
    );
    return toSession(result.rows[0]);
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query(`delete from user_sessions where token_hash = $1`, [tokenHash]);
  }

  async deleteExpiredSessions(nowIso: string): Promise<void> {
    await this.pool.query(`delete from user_sessions where expires_at <= $1`, [nowIso]);
  }
}

export async function createAuthRepository(databaseUrl?: string): Promise<AuthRepository> {
  if (!databaseUrl) return new MemoryAuthRepository();

  const repository = new PostgresAuthRepository(databaseUrl);
  await repository.migrate();
  return repository;
}

function normalizeConstraintColumns(columns: string[] | string): string[] {
  if (Array.isArray(columns)) return columns;
  return columns
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((column) => column.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function toUser(row: unknown): User | null {
  if (!isRecord(row)) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toSession(row: unknown): UserSession | null {
  if (!isRecord(row)) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at)
  };
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function shouldUseSsl(connectionString: string): boolean {
  return !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");
}
