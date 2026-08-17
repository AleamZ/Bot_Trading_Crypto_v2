import type pg from "pg";

export async function recordSchemaMigration(pool: pg.Pool, version: string, name: string): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version varchar(80) primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);
  await pool.query(`insert into schema_migrations (version, name) values ($1, $2) on conflict (version) do nothing`, [version, name]);
}
