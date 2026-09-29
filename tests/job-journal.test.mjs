import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { migrations } from './helpers/migrations.mjs';
import { leasedJournals } from './helpers/job-lease.mjs';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';

const identity = {
  jobId: 'job-1', originTaskRef: 'task-1', requestKey: 'request-key-1', instructionRevision: 1,
  host: { tenantRef: 'tenant-1', userRef: 'user-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'env-1', purposeRef: 'purpose-1' },
  native: { requestRef: 'request-1', threadRef: 'thread-1', assistantProjectRef: 'assistant-project-1', objectiveRef: 'objective-1', rootTaskRef: 'root-task-1', outcomeRef: 'outcome-1', backingWorkRequestRef: 'backing-1', childWorkRequestRef: 'child-1', turnRef: 'turn-1', runRef: 'run-1', actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', sourceQueue: { queueRef: 'source-queue', messageRef: 'source-message' } },
  origin: { channelRef: 'channel-1', routeRef: 'route-1', correlationRef: 'correlation-1' },
};
const requirement = { kind: 'secure_input', requirementRef: 'requirement-1', revision: 1, actor: { kind: 'user', actorRef: 'user-1' } };
const effect = { actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', outcome: 'unknown' };
function event(kind, previousRevision, extra = {}) {
  const state = { submitted: 'queued', started: 'running', effects_recorded: 'running', resumed: 'queued', answered: 'waiting' }[kind] ?? kind;
  return structuredClone({ kind, previousRevision,
    snapshot: { identity, revision: previousRevision + 1, state, effects: [],
      ...(state === 'waiting' ? { requirement } : {}),
      ...(state === 'failed' ? { error: { code: 'execution_failed', correlationRef: 'safe-error' } } : {}),
      ...(state === 'cancelled' ? { cancellation: { reason: 'explicit_stop', actorRef: 'user-1' } } : {}),
      ...extra },
    ...(kind === 'cancelled' ? { command: { command: 'cancel', identity, expectedRevision: previousRevision, reason: 'explicit_stop' } } : {}),
  });
}
function ok(result) { assert.equal(result.ok, true, result.code); return result.value; }
function rejected(result, code) { assert.deepEqual(result, { ok: false, code }); }

async function setup(t) {
  const harness = await createPostgresHarness();
  t.after(() => harness.cleanup());
  const first = await harness.client(), second = await harness.client();
  const folder = await migrations(t, harness, first);
  const tables = journalTables(harness.schema);
  const [journal, other] = leasedJournals(first, second, tables,
    createJobJournal(first.database(), tables), createJobJournal(second.database(), tables));
  const stored = async () => {
    const result = {};
    for (const name of ['jobs', 'job_events', 'job_deliveries', 'job_checkpoints']) {
      result[name] = (await second.query(`SELECT * FROM ${harness.table(name)} ORDER BY 1, 2`)).rows;
    }
    return result;
  };
  return { harness, first, second, folder, tables, journal, other, stored };
}

test('migration isolation, rerun and owned cleanup preserve independent sentinel', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup());
  const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer NOT NULL)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (73)`);
  const { harness, first, folder, journal } = await setup(t);
  assert.equal((await first.query('SHOW search_path')).rows[0].search_path, 'pg_catalog');
  try { await migrate(first.database(), { migrationsFolder: folder, migrationsSchema: harness.schema, migrationsTable: 'journal_migrations' }); }
  catch { assert.fail('MIGRATION_RERUN_FAILED'); }
  const migrationJournal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  assert.equal((await first.query(`SELECT count(*)::int AS n FROM ${harness.table('journal_migrations')}`)).rows[0].n, migrationJournal.entries.length);
  ok(await journal.append(event('submitted', 0)));
  await harness.cleanup();
  assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1', [harness.schema])).rows[0].n, 0);
  assert.deepEqual((await observer.query(`SELECT * FROM ${sentinel.table('sentinel')}`)).rows, [{ value: 73 }]);
  t.diagnostic('Real SQL: generated migration and ledger applied twice; restricted search_path; owned tables/sequence/schema removed; independent sentinel survived.');
});

test('independent concurrent appenders cannot claim one revision', async t => {
  const { first, second, journal, other, stored } = await setup(t);
  assert.notEqual((await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  ok(await journal.append(event('submitted', 0)));
  const results = await Promise.all([journal.append(event('started', 1)), other.append(event('cancelled', 1))]);
  assert.equal(results.filter(r => r.ok).length, 1);
  rejected(results.find(r => !r.ok), 'conflict');
  const rows = await stored();
  assert.equal(rows.job_events.length, 2);
  assert.equal(rows.jobs[0].revision, '2');
  assert.deepEqual(ok(await other.load(identity)), results.find(r => r.ok).value.event.snapshot);
  t.diagnostic('Real SQL: distinct backends raced at revision 2; one committed, one conflicted; exactly two canonical events.');
});

test('concurrent identical admission and delivery retries return original canonical fact', async t => {
  const { journal, other, stored } = await setup(t);
  const submitted = { ...event('submitted', 0), delivery: { attemptRef: 'attempt-1', queue: { queueRef: 'q', messageRef: 'm1' } } };
  const results = await Promise.all([journal.append(submitted), other.append(submitted)]);
  assert.deepEqual(results.map(r => ok(r).replayed).sort(), [false, true]);
  const original = ok(results[0]).event;
  assert.equal('delivery' in original, false);
  ok(await journal.append(event('started', 1)));
  const retry = structuredClone(submitted); retry.delivery = { attemptRef: 'attempt-2', callbackRef: 'callback-2' };
  // Object order does not alter canonical identity/content.
  retry.snapshot.identity.host = Object.fromEntries(Object.entries(retry.snapshot.identity.host).reverse());
  assert.deepEqual(ok(await other.append(retry)), { event: original, replayed: true });
  const before = await stored();
  const changed = structuredClone(submitted); changed.delivery.queue.messageRef = 'changed';
  rejected(await journal.append(changed), 'conflict');
  assert.deepEqual(await stored(), before);
  assert.equal(before.job_events.length, 2);
  assert.equal(before.job_deliveries.length, 2);
  assert.deepEqual(before.jobs[0].identity, identity);
});

test('changed canonical content conflicts without persisting a new delivery', async t => {
  const { journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0))); ok(await journal.append(event('started', 1)));
  const before = await stored();
  const changed = { ...event('started', 1, { effects: [effect] }), delivery: { attemptRef: 'new-delivery' } };
  rejected(await journal.append(changed), 'conflict');
  assert.deepEqual(await stored(), before);
});

test('fresh connections recover missing and stale checkpoints from validated events', async t => {
  const { harness, first, journal, tables } = await setup(t);
  const submitted = event('submitted', 0);
  ok(await journal.append(submitted)); ok(await journal.append(event('started', 1)));
  const wait = event('waiting', 2); ok(await journal.append(wait));
  await first.close();
  for (const mode of ['missing', 'stale']) {
    const fresh = await harness.client();
    if (mode === 'missing') await fresh.query(`DELETE FROM ${harness.table('job_checkpoints')}`);
    else await fresh.query(`UPDATE ${harness.table('job_checkpoints')} SET revision=1, snapshot=$1`, [JSON.stringify(submitted.snapshot)]);
    const restarted = createJobJournal(fresh.database(), tables);
    assert.deepEqual(ok(await restarted.load(identity)), wait.snapshot);
    assert.deepEqual((await fresh.query(`SELECT snapshot FROM ${harness.table('job_checkpoints')}`)).rows[0].snapshot, wait.snapshot);
    await fresh.close();
  }
  t.diagnostic('Real SQL: original connection closed; new backends reconstructed exact revision 3 after missing and stale checkpoints.');
});

test('ahead, incompatible and fabricated checkpoints fail closed on reads and writes', async t => {
  const { first, harness, journal, stored } = await setup(t);
  const submitted = event('submitted', 0); ok(await journal.append(submitted));
  for (const [version, revision, snapshot] of [
    [1, 2, event('started', 1).snapshot], [2, 1, submitted.snapshot],
    [1, 1, { ...submitted.snapshot, state: 'running' }],
    [1, 1, { ...submitted.snapshot, raw: 'synthetic-unsupported' }],
  ]) {
    await first.query(`UPDATE ${harness.table('job_checkpoints')} SET version=$1, revision=$2, snapshot=$3`, [version, revision, JSON.stringify(snapshot)]);
    const before = await stored();
    rejected(await journal.load(identity), 'invalid_checkpoint');
    rejected(await journal.append(event('started', 1)), 'invalid_checkpoint');
    assert.deepEqual(await stored(), before);
  }
});

test('all host, original, native and origin identity leaves are fenced', async t => {
  const { journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0)));
  const before = await stored();
  function paths(value, base = []) { return Object.entries(value).flatMap(([k, v]) => typeof v === 'object' ? paths(v, [...base, k]) : [[...base, k]]); }
  for (const path of paths(identity).filter(path => path[0] !== 'jobId')) {
    const changed = event('started', 1); let target = changed.snapshot.identity;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)] = typeof target[path.at(-1)] === 'number' ? 2 : 'replacement';
    rejected(await journal.append(changed), 'identity_mismatch');
    rejected(await journal.load(changed.snapshot.identity), 'identity_mismatch');
    assert.deepEqual(await stored(), before);
  }
});

test('invalid transitions, revisions and unsupported raw fields leave all tables unchanged', async t => {
  const { journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0)));
  const before = await stored();
  rejected(await journal.append(event('waiting', 1)), 'invalid_transition');
  rejected(await journal.append(event('started', 2)), 'invalid_revision');
  for (const mutate of [
    e => { e.raw = 'synthetic-unsupported'; },
    e => { e.snapshot.identity.native.token = 'synthetic-unsupported'; },
    e => { e.delivery = { attemptRef: 'a', raw: 'synthetic-unsupported' }; },
    e => { e.snapshot.effects.push({ ...effect, secret: 'synthetic-unsupported' }); },
    e => { e.snapshot.revision = Number.MAX_SAFE_INTEGER + 1; },
    e => { Object.defineProperty(e, 'raw', { value: 'hidden' }); },
    e => { Object.defineProperty(e.snapshot, 'state', { enumerable: true, get() { throw Error('synthetic-secret'); } }); },
  ]) {
    const changed = event('started', 1); mutate(changed);
    rejected(await journal.append(changed), 'invalid_payload');
    assert.deepEqual(await stored(), before);
  }
  assert.deepEqual(await stored(), before);
});

test('cancellation remains terminal and unknown effects cannot disappear or authorize success', async t => {
  const { journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0))); ok(await journal.append(event('started', 1)));
  ok(await journal.append(event('effects_recorded', 2, { effects: [effect] })));
  let before = await stored();
  rejected(await journal.append(event('waiting', 3)), 'effect_conflict');
  const success = event('succeeded', 3, { effects: [effect], receipt: { receiptRef: 'receipt-1', verification: 'host_verified', jobId: identity.jobId, revision: 4 } });
  rejected(await journal.append(success), 'invalid_payload');
  assert.deepEqual(await stored(), before);
  ok(await journal.append(event('cancelled', 3, { effects: [effect] })));
  before = await stored();
  rejected(await journal.append(event('failed', 4, { effects: [effect] })), 'invalid_transition');
  assert.deepEqual(ok(await journal.load(identity)).effects, [effect]);
  assert.deepEqual(await stored(), before);
});

test('late SQL failure rolls back event, head, delivery and checkpoint with safe errors', async t => {
  const { harness, first, journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0))); ok(await journal.append(event('started', 1)));
  await first.query(`ALTER TABLE ${harness.table('job_checkpoints')} ADD CONSTRAINT synthetic_failure CHECK (revision < 3)`);
  const before = await stored();
  rejected(await journal.append({ ...event('waiting', 2), delivery: { attemptRef: 'attempt-3' } }), 'unavailable');
  assert.deepEqual(await stored(), before);
  await first.query(`ALTER TABLE ${harness.table('job_checkpoints')} DROP CONSTRAINT synthetic_failure`);
  ok(await journal.append(event('waiting', 2)));
  await first.close();
  rejected(await journal.load(identity), 'unavailable');
  t.diagnostic('Real SQL: checkpoint constraint failed after event/head/delivery writes; independent observer verified complete rollback; subsequent append succeeded.');
});

test('database constraints reject duplicate event keys and unsafe integer revisions', async t => {
  const { first, harness, journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0)));
  const before = await stored();
  await assert.rejects(first.query(`INSERT INTO ${harness.table('job_events')} SELECT * FROM ${harness.table('job_events')}`), { message: 'POSTGRES_QUERY_FAILED' });
  await assert.rejects(first.query(`UPDATE ${harness.table('jobs')} SET revision=9007199254740992`), { message: 'POSTGRES_QUERY_FAILED' });
  await assert.rejects(first.query(`UPDATE ${harness.table('job_events')} SET revision=0`), { message: 'POSTGRES_QUERY_FAILED' });
  assert.deepEqual(await stored(), before);
});

test('canonical history is validated even when a current checkpoint claims success', async t => {
  const { first, harness, journal, stored } = await setup(t);
  ok(await journal.append(event('submitted', 0))); ok(await journal.append(event('started', 1)));
  const tampered = event('waiting', 1); // shape valid but invalid queued -> waiting
  await first.query(`UPDATE ${harness.table('job_events')} SET event=$1 WHERE revision=2`, [JSON.stringify(tampered)]);
  await first.query(`UPDATE ${harness.table('job_checkpoints')} SET snapshot=$1 WHERE revision=2`, [JSON.stringify(tampered.snapshot)]);
  const before = await stored();
  rejected(await journal.load(identity), 'invalid_history');
  rejected(await journal.append(event('failed', 2)), 'invalid_history');
  assert.deepEqual(await stored(), before);
});

test('a failed migration rolls back every generated application table', async t => {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client();
  const folder = await mkdtemp(resolve('.reference-build/migrations-failure-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = resolve('reference/node/db/migrations');
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), await readFile(join(source, 'meta/_journal.json')));
  for (const file of await readdir(source)) if (file.endsWith('.sql')) {
    const sql = (await readFile(join(source, file), 'utf8')).replaceAll('"agent_reference"', `"${harness.schema}"`);
    await writeFile(join(folder, file), `${sql}\n--> statement-breakpoint\nSELECT 1/0;`);
  }
  let failed = false;
  try { await migrate(client.database(), { migrationsFolder: folder, migrationsSchema: harness.schema, migrationsTable: 'journal_migrations' }); }
  catch { failed = true; }
  assert.equal(failed, true);
  assert.deepEqual((await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`, [harness.schema])).rows,
    [{ relname: 'journal_migrations' }]);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${harness.table('journal_migrations')}`)).rows[0].n, 0);
  t.diagnostic('Real SQL: injected final migration failure rolled back all generated tables and ledger insertion.');
});

test('append detaches validated input before awaiting SQL', async t => {
  const { journal, other } = await setup(t);
  const input = event('submitted', 0);
  const expected = structuredClone(input);
  const pending = journal.append(input);
  input.snapshot.identity.host.tenantRef = 'changed-after-call';
  input.snapshot.raw = 'synthetic-unsupported';
  assert.deepEqual(ok(await pending).event, expected);
  assert.deepEqual(ok(await other.load(identity)), expected.snapshot);
});
