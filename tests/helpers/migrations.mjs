import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Apply checked-in Drizzle migrations with only the quoted namespace relocated.
// The stock migrator's ledger and its table-owned SERIAL sequence live in the
// same owned schema; dropping that table drops its owned sequence. No global DDL.
export async function migrations(t, harness, client) {
  const folder = await mkdtemp(resolve('.reference-build/migrations-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = resolve('reference/node/db/migrations');
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), await readFile(join(source, 'meta/_journal.json')));
  for (const file of await readdir(source)) if (file.endsWith('.sql')) {
    const sql = (await readFile(join(source, file), 'utf8')).replaceAll('"agent_reference"', `"${harness.schema}"`);
    await writeFile(join(folder, file), sql);
  }
  try { await migrate(client.database(), { migrationsFolder: folder, migrationsSchema: harness.schema, migrationsTable: 'journal_migrations' }); }
  catch { assert.fail('ISOLATED_MIGRATION_FAILED'); }
  return folder;
}
