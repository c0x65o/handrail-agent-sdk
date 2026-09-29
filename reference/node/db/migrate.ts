import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { referenceDatabase } from './database.js';
import { referenceSchemaName } from './schema.js';

// Explicit operator command only. No import-time connection or migration.
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFERENCE_DATABASE_REQUIRED');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
    options: '-c search_path=pg_catalog', connectionTimeoutMillis: 5000 });
  pool.on('error', () => {});
  try {
    await migrate(referenceDatabase(pool), {
      migrationsFolder: resolve('reference/node/db/migrations'),
      migrationsSchema: referenceSchemaName,
      migrationsTable: 'journal_migrations',
    });
  } finally { await pool.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('REFERENCE_MIGRATION_FAILED'); process.exitCode = 1; });
}
