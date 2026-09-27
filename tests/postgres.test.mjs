import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';

test('PostgreSQL isolates transactions, rolls back, and cleans only its owned schema', async t => {
  // Independent fixture ownership: cleaning the subject must not clean sentinel.
  const sentinel = await createPostgresHarness();
  t.after(() => sentinel.cleanup());
  const observer = await sentinel.client();
  const marker = sentinel.table('sentinel');
  await observer.query(`CREATE TABLE ${marker} (value integer NOT NULL)`);
  await observer.query(`INSERT INTO ${marker} VALUES (73)`);

  const harness = await createPostgresHarness();
  t.after(() => harness.cleanup());
  const first = await harness.client();
  const second = await harness.client();
  const firstPid = await first.query('SELECT pg_backend_pid() AS pid');
  const secondPid = await second.query('SELECT pg_backend_pid() AS pid');
  assert.notEqual(firstPid.rows[0].pid, secondPid.rows[0].pid);
  const table = harness.table('visibility');
  await first.query(`CREATE TABLE ${table} (value integer PRIMARY KEY)`);
  const count = async client => (await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count;

  await first.transaction(async writer => {
    await writer.query(`INSERT INTO ${table} VALUES (1)`);
    assert.equal(await count(writer), 1);
    assert.equal(await count(second), 0, 'uncommitted row is invisible to independent client');
  });
  assert.equal(await count(second), 1, 'commit becomes visible');

  let ownDuringRollback;
  let otherDuringRollback;
  await assert.rejects(first.transaction(async writer => {
    await writer.query(`INSERT INTO ${table} VALUES (2)`);
    ownDuringRollback = await count(writer);
    otherDuringRollback = await count(second);
    throw new Error('synthetic transaction failure');
  }), { message: 'POSTGRES_TRANSACTION_FAILED' });
  // Keep these outside assert.rejects: a failed assertion in the callback must
  // not be confused with the intentional rollback trigger.
  assert.equal(ownDuringRollback, 2);
  assert.equal(otherDuringRollback, 1);
  assert.equal(await count(first), 1, 'failed transaction rolled back on writer');
  assert.equal(await count(second), 1, 'rolled-back row never becomes visible');

  // Teardown must also release an open transaction before dropping its tables.
  await first.query('BEGIN');
  await first.query(`INSERT INTO ${table} VALUES (3)`);
  await harness.cleanup();
  await harness.cleanup(); // successful cleanup is idempotent
  const remaining = await observer.query(
    'SELECT count(*)::integer AS count FROM pg_catalog.pg_namespace WHERE nspname = $1', [harness.schema]);
  assert.equal(remaining.rows[0].count, 0, 'owned schema removed');
  assert.deepEqual((await observer.query(`SELECT value FROM ${marker}`)).rows, [{ value: 73 }],
    'independently owned schema and sentinel survive');
  t.diagnostic('Independent backends; uncommitted visibility isolated; commit visible; rollback verified; owned schema removed; sentinel preserved.');
});
