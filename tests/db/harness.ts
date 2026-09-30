/**
 * Runs the real Supabase migrations inside PGlite (Postgres compiled to WASM)
 * so schema constraints, RLS policies and RPCs are tested without Docker.
 *
 * Supabase-provided pieces (auth schema, auth.uid(), API roles) are stubbed
 * with the same names and semantics.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

export interface TestDb {
  db: PGlite;
  /** Run SQL as a specific API role (optionally as a signed-in user). */
  as<T = Record<string, unknown>>(
    role: 'authenticated' | 'anon' | 'service_role',
    userId: string | null,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  createUser(id: string, email?: string): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return {
    db,
    async as(role, userId, sql, params = []) {
      return db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
        await tx.exec(`set local role ${role}`);
        const result = await tx.query(sql, params);
        return result.rows as never;
      });
    },
    async createUser(id, email = `${id}@example.com`) {
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
    },
    close: () => db.close(),
  };
}
