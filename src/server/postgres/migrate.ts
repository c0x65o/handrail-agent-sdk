import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { assertAgentPostgresSchema } from './db/schema.js';

/** Ordered, additive historical runtime migrations, with unchanged SQL identities.
 * Host migration runners may consume this without invoking our bootstrap. */
export async function agentPostgresMigrations(schema: string): Promise<readonly {
  id: string; createdAt: number; hash: string; statements: readonly string[];
}[]> {
  assertAgentPostgresSchema(schema);
  const journal = JSON.parse(await readFile(new URL('./migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const runtime = new Set([0, 1, 2, 6, 7, 8, 13, 14]);
  return Promise.all(journal.entries.filter(e => runtime.has(e.idx)).map(async e => {
    const sql = (await readFile(new URL(`./migrations/${e.tag}.sql`, import.meta.url), 'utf8'))
      .replaceAll('"agent_reference"', `"${schema}"`);
    return { id: e.tag, createdAt: e.when, hash: createHash('sha256').update(sql).digest('hex'),
      statements: sql.split('--> statement-breakpoint').filter(s => s.trim()) };
  }));
}

/** Explicit operator bootstrap only. Atomic, serialized per schema. Compatible
 * with the original Drizzle journal_migrations ledger, including partial installs.
 * Never infer an existing table's provenance or silently adopt an unknown schema.
 * Pool is host-owned; a checked-out transaction connection is always released. */
export async function migrateAgentPostgres(pool: Pick<Pool, 'connect'>, schema: string): Promise<void> {
  const migrations = await agentPostgresMigrations(schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [`agent-schema:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"."journal_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const applied = await client.query<{ hash: string; created_at: string }>(`SELECT hash, created_at FROM "${schema}"."journal_migrations"`);
    for (const migration of migrations) {
      const old = applied.rows.filter(r => Number(r.created_at) === migration.createdAt);
      if (old.length) {
        if (old.length !== 1 || old[0]!.hash !== migration.hash) throw Error('agent_migration_history_conflict');
        continue;
      }
      for (const statement of migration.statements) await client.query(statement);
      await client.query(`INSERT INTO "${schema}"."journal_migrations" (hash, created_at) VALUES ($1, $2)`, [migration.hash, migration.createdAt]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
