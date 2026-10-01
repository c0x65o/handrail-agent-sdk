import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPostgresHarness } from '../helpers/postgres.js';
import { migrations } from '../helpers/migrations.mjs';
import { createVaultStore } from '../../reference/node/vault-store.js';
import type { VaultScope, VaultStorageHost } from '../../reference/node/vault-store.js';
import { createVaultLifecycle } from '../../reference/node/vault-lifecycle.js';
import { vaultTables } from '../../reference/node/db/schema.js';
import { fixtures, keyService, privateScan, scope } from './vault-fixture.js';

// No private assertion operands, driver causes or synthetic values reach TAP.
function acceptance(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, async t => { try { await run(t); } catch { throw Error('VAULT_LIFECYCLE_ACCEPTANCE_FAILED'); } });
}
function passed<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw Error('VAULT_EXPECTED_SUCCESS');
  return r.value;
}
function denied(r: unknown, code: string) { assert.equal(JSON.stringify(r) === JSON.stringify({ ok: false, code }), true); }
async function setup(t: TestContext) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  const second = await harness.client();
  assert.equal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid !== (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, true);
  const seed = randomBytes(32).toString('hex'), keys = keyService(seed), tables = vaultTables(harness.schema);
  let authority: VaultScope | null = scope;
  const host: VaultStorageHost = { authorize: async () => authority };
  const store = createVaultStore(client.database(), host, keys, tables);
  const lifecycle = createVaultLifecycle(client.database(), host, keys, tables);
  const other = createVaultLifecycle(second.database(), host, keys, tables);
  return { harness, client, second, seed, keys, tables, host, store, lifecycle, other,
    authorize(value: VaultScope | null) { authority = value; }, fixture: fixtures(seed)[0],
    async scan(extra: unknown = []) {
      const sinks: unknown[] = [extra];
      for (const name of ['vault_items', 'vault_states', 'vault_preparations', 'jobs', 'job_events', 'job_deliveries', 'job_checkpoints', 'job_admissions']) {
        sinks.push((await second.query(`SELECT * FROM ${harness.table(name)}`)).rows);
      }
      assert.equal(privateScan(seed, sinks), true);
    },
  };
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), waiting = new Promise<void>(r => { release = r; });
  return { entered, release, async wait() { enter(); await waiting; } };
}
async function child(mode: 'prepare' | 'recover', seed: string, schema: string) {
  return new Promise<{ ok: boolean; pid: number; receipts: unknown[]; output: string }>((resolve, reject) => {
    const worker = fork(new URL('./vault-process.js', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', message: any;
    const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(Error('PRIVATE_PROCESS_TIMEOUT')); }, 15_000);
    worker.stdout!.on('data', b => { output += b; }); worker.stderr!.on('data', b => { output += b; });
    worker.on('message', value => { message = value; });
    worker.on('error', () => { clearTimeout(timeout); reject(Error('PRIVATE_PROCESS_FAILED')); });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0 || !message?.ok || !privateScan(seed, [message, output])) reject(Error('PRIVATE_PROCESS_FAILED'));
      else resolve({ ...message, output });
    });
    worker.send({ mode, seed, schema });
  });
}

acceptance('fresh processes resume durable preparation for eight variants with unchanged references and exact target keys', async t => {
  const s = await setup(t);
  const writer = await child('prepare', s.seed, s.harness.schema);
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 8);
  await s.scan(writer);
  const reader = await child('recover', s.seed, s.harness.schema);
  assert.equal(writer.pid !== reader.pid && reader.pid !== process.pid && writer.pid !== process.pid, true);
  assert.equal(writer.output === '' && reader.output === '', true);
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 0);
  const rows = await s.client.database().select().from(s.tables.items);
  assert.equal(rows.length === 8 && rows.every(r => r.keyVersion === 2 && r.revision === 1), true);
  for (const f of fixtures(s.seed)) assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  await s.scan([writer, reader]);
  t.diagnostic('Writer exited after preparation; fresh reader recovered all 8 variants without source key access; references unchanged; captured diagnostics and SQL scans passed.');
});

acceptance('concurrent commits have one winner; stale preparations and receipts cannot replace newer key state', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const a = passed(await s.lifecycle.prepare(f.item)), b = passed(await s.other.prepare(f.item));
  const results = await Promise.all([s.lifecycle.resume(a), s.other.resume(b)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok && (r.code === 'conflict' || r.code === 'unavailable')).length, 1);
  const winner = passed(results.find(r => r.ok)!);
  passed(await s.lifecycle.resume(winner));
  s.keys.version = 3;
  const newer = passed(await s.lifecycle.prepare(f.item)); passed(await s.lifecycle.resume(newer));
  denied(await s.lifecycle.resume(a), 'conflict'); denied(await s.lifecycle.resume(b), 'conflict');
  passed(await s.lifecycle.resume(newer));
  const [row] = await s.client.database().select().from(s.tables.items);
  assert.equal(row.keyVersion, 3);
  assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  await s.scan([a, b, results, newer]);
});

for (const status of ['deleted', 'revoked'] as const) acceptance(`${status} fences pending recovery, reads, recreation and replayed backups before and after cleanup`, async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const receipt = passed(await s.lifecycle.prepare(f.item));
  const [backup] = await s.client.database().select().from(s.tables.items);
  const [preparation] = await s.client.database().select().from(s.tables.preparations);
  passed(await s.other.terminate(f.item, status));
  const before = s.keys.calls;
  denied(await s.store.readForExecutor(f.item), 'not_authorized');
  denied(await s.lifecycle.resume(receipt), 'not_authorized');
  denied(await s.lifecycle.prepare(f.item), 'not_authorized');
  denied(await s.store.create(f.item, f.value), 'not_authorized');
  assert.equal(s.keys.calls, before);
  passed(await s.lifecycle.cleanup(f.item)); passed(await s.lifecycle.cleanup(f.item));
  // A restored ciphertext/preparation is never accepted as lifecycle authority.
  await s.client.database().insert(s.tables.items).values(backup);
  await s.client.database().insert(s.tables.preparations).values(preparation);
  denied(await s.store.readForExecutor(f.item), 'not_authorized');
  denied(await s.lifecycle.resume(receipt), 'not_authorized');
  passed(await s.other.terminate(f.item, status === 'deleted' ? 'revoked' : 'deleted'));
  const [state] = await s.client.database().select().from(s.tables.states);
  assert.equal(state.status === status && state.activeNonce === null && state.lastRotation === null, true);
  passed(await s.lifecycle.cleanup(f.item));
  assert.equal((await s.client.database().select().from(s.tables.items)).length, 0);
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 0);
  await s.scan(receipt);
});

for (const operation of ['read', 'prepare', 'prepare-target', 'resume', 'create'] as const) acceptance(`durable tombstone during ${operation} key resolution prevents decryption/output or persistence`, async t => {
  const s = await setup(t), f = s.fixture;
  if (operation !== 'create') passed(await s.store.create(f.item, f.value));
  s.keys.version = 2;
  const receipt = operation === 'resume' ? passed(await s.lifecycle.prepare(f.item)) : undefined;
  const gate = barrier(); s.keys.beforeResolve = version => operation === 'prepare-target' && version === 1 ? Promise.resolve() : gate.wait();
  // Wrong material proves the fence executes before attempted authentication.
  s.keys.wrong.add(operation === 'resume' || operation === 'create' || operation === 'prepare-target' ? 2 : 1);
  const pending = operation === 'read' ? s.store.readForExecutor(f.item)
    : operation === 'prepare' || operation === 'prepare-target' ? s.lifecycle.prepare(f.item)
    : operation === 'resume' ? s.lifecycle.resume(receipt!) : s.store.create(f.item, f.value);
  await gate.entered;
  try { passed(await s.other.terminate(f.item, 'revoked')); } finally { gate.release(); }
  const result = await pending;
  denied(result, operation === 'create' ? 'conflict' : 'not_authorized');
  s.keys.beforeResolve = undefined;
  passed(await s.other.cleanup(f.item));
  assert.equal((await s.client.database().select().from(s.tables.items)).length, 0);
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 0);
  await s.scan(result);
});

acceptance('final private output fence observes a deletion after decryption during authorization', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  let calls = 0;
  const host: VaultStorageHost = { authorize: async () => {
    if (++calls === 4) passed(await s.other.terminate(f.item, 'deleted'));
    return scope;
  } };
  denied(await createVaultStore(s.client.database(), host, s.keys, s.tables).readForExecutor(f.item), 'not_authorized');
  assert.equal(calls, 4);
  await s.scan();
});

acceptance('cleanup SQL interruption rolls back private removal but leaves committed tombstone retryable', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const receipt = passed(await s.lifecycle.prepare(f.item));
  passed(await s.lifecycle.terminate(f.item, 'deleted'));
  await s.client.query(`CREATE TABLE ${s.harness.table('cleanup_hold')} (id text REFERENCES ${s.harness.table('vault_items')}(item_id))`);
  await s.client.query(`INSERT INTO ${s.harness.table('cleanup_hold')} VALUES ($1)`, ['secret-0']);
  const failure = await s.lifecycle.cleanup(f.item); denied(failure, 'unavailable');
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 1);
  denied(await s.lifecycle.resume(receipt), 'not_authorized');
  denied(await s.store.readForExecutor(f.item), 'not_authorized');
  await s.client.query(`DROP TABLE ${s.harness.table('cleanup_hold')}`);
  passed(await s.lifecycle.cleanup(f.item)); passed(await s.lifecycle.cleanup(f.item));
  await s.scan(failure);
});

acceptance('missing and wrong exact keys fail closed; target-only recovery is retryable without key retirement', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const errors: unknown[] = [];
  for (const set of [s.keys.unavailable, s.keys.wrong]) for (const version of [1, 2]) {
    set.add(version);
    // Wrong target material can encrypt, but recovery with the real exact key must fail.
    if (set === s.keys.wrong && version === 2) { set.delete(version); continue; }
    const r = await s.lifecycle.prepare(f.item); denied(r, 'unavailable'); errors.push(r); set.delete(version);
  }
  const receipt = passed(await s.lifecycle.prepare(f.item));
  for (const set of [s.keys.unavailable, s.keys.wrong]) {
    set.add(2); const r = await s.lifecycle.resume(receipt); denied(r, 'unavailable'); errors.push(r); set.delete(2);
  }
  s.keys.unavailable.add(1);
  passed(await s.lifecycle.resume(receipt)); passed(await s.lifecycle.resume(receipt));
  assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  await s.scan(errors);
});

acceptance('all six scopes and current host denial fence preparation/recovery/cleanup; changed scope during key access fails closed', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const receipt = passed(await s.lifecycle.prepare(f.item));
  for (const changed of [...Object.keys(scope).map(k => ({ ...scope, [k]: 'other' })), null]) {
    s.authorize(changed);
    const before = s.keys.calls;
    denied(await s.lifecycle.prepare(f.item), 'not_authorized');
    denied(await s.lifecycle.resume(receipt), 'not_authorized');
    denied(await s.lifecycle.terminate(f.item, 'deleted'), 'not_authorized');
    denied(await s.lifecycle.cleanup(f.item), 'not_authorized');
    assert.equal(s.keys.calls, before);
  }
  s.authorize(scope);
  s.keys.beforeResolve = async () => { s.authorize({ ...scope, purposeRef: 'changed' }); };
  denied(await s.lifecycle.resume(receipt), 'not_authorized');
  s.keys.beforeResolve = undefined; s.authorize(scope);
  passed(await s.lifecycle.resume(receipt)); await s.scan(receipt);
});

acceptance('missing/unavailable authoritative ledger and stale ciphertext fail closed without reconstruction', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  const [backup] = await s.client.database().select().from(s.tables.items);
  s.keys.version = 2; const receipt = passed(await s.lifecycle.prepare(f.item)); passed(await s.lifecycle.resume(receipt));
  await s.client.database().update(s.tables.items).set(backup);
  const before = s.keys.calls;
  denied(await s.store.readForExecutor(f.item), 'unavailable');
  denied(await s.lifecycle.resume(receipt), 'unavailable');
  assert.equal(s.keys.calls, before);
  await s.client.database().delete(s.tables.states);
  denied(await s.store.readForExecutor(f.item), 'unavailable');
  denied(await s.lifecycle.prepare(f.item), 'unavailable');
  await s.client.query(`ALTER TABLE ${s.harness.table('vault_states')} RENAME TO unavailable_states`);
  denied(await s.store.readForExecutor(f.item), 'unavailable');
  denied(await s.lifecycle.resume(receipt), 'unavailable');
  assert.equal(s.keys.calls, before);
  await s.client.query(`ALTER TABLE ${s.harness.table('unavailable_states')} RENAME TO vault_states`);
  await s.scan();
});

acceptance('tampered prepared bindings cannot authenticate even with current host authorization', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const receipt = passed(await s.lifecycle.prepare(f.item));
  const [p] = await s.client.database().select().from(s.tables.preparations);
  for (const patch of [{ keyVersion: 3 }, { nonce: Buffer.alloc(12).toString('base64') }, { tag: Buffer.alloc(16).toString('base64') }, { ciphertext: 'AAAA' }]) {
    await s.client.database().update(s.tables.preparations).set({ envelope: { ...p.envelope, ...patch } });
    denied(await s.lifecycle.resume(receipt), 'unavailable');
  }
  await s.client.database().update(s.tables.preparations).set(p);
  passed(await s.lifecycle.resume(receipt)); await s.scan(receipt);
});

acceptance('generated migrations rerun safely; owned lifecycle schemas removed with independent sentinel intact', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup());
  const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (42)`);
  const s = await setup(t); await migrations(t, s.harness, s.client);
  passed(await s.store.create(s.fixture.item, s.fixture.value));
  passed(await s.lifecycle.terminate(s.fixture.item, 'revoked'));
  await migrations(t, s.harness, s.client);
  denied(await s.store.readForExecutor(s.fixture.item), 'not_authorized');
  await s.scan(); await s.harness.cleanup();
  assert.equal((await observer.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1', [s.harness.schema])).rowCount, 0);
  assert.equal((await observer.query(`SELECT value FROM ${sentinel.table('sentinel')}`)).rows[0].value, 42);
  t.diagnostic('Owned migrated lifecycle schema removed; independent sentinel preserved; migration reruns did not clear tombstones.');
});

acceptance('one-time generated upgrade preserves existing v1 envelopes and initializes their durable fence', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  const before = JSON.stringify(await s.client.database().select().from(s.tables.items));
  // Reconstruct the pre-lifecycle schema only inside this owned disposable fixture.
  await s.client.query(`DROP TABLE ${s.harness.table('vault_states')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('vault_preparations')}`);
  // The fixture rewinds the migration ledger to v1; remove newer persistence
  // objects too so the forward migrations can replay from that exact schema.
  await s.client.query(`DROP TABLE ${s.harness.table('job_cancellation_evidence')}`);
  await s.client.query(`ALTER TABLE ${s.harness.table('jobs')} DROP COLUMN cancellation_epoch`);
  await s.client.query(`DROP TABLE ${s.harness.table('job_answer_deliveries')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('job_challenges')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('job_effects')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('vault_item_grants')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('vault_access')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('vault_entry_sessions')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('browser_profile_snapshots')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('browser_profile_states')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('connection_receipts')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('connection_revisions')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('connections')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('agent_run_states')}`);
  await s.client.query(`DROP TABLE ${s.harness.table('conversation_records')}`);
  await s.client.query(`DELETE FROM ${s.harness.table('journal_migrations')} WHERE id > 4`);
  await migrations(t, s.harness, s.client);
  assert.equal(JSON.stringify(await s.client.database().select().from(s.tables.items)) === before, true);
  assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  s.keys.version = 2;
  passed(await s.lifecycle.resume(passed(await s.lifecycle.prepare(f.item))));
  await s.scan();
});

acceptance('failed rotation commit rolls back envelope and generation together; preparation remains retryable', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value)); s.keys.version = 2;
  const receipt = passed(await s.lifecycle.prepare(f.item));
  const before = JSON.stringify(await s.client.database().select().from(s.tables.states));
  await s.client.query(`ALTER TABLE ${s.harness.table('vault_items')} ADD CONSTRAINT fixture_commit_failure CHECK (key_version = 1)`);
  denied(await s.lifecycle.resume(receipt), 'unavailable');
  assert.equal(JSON.stringify(await s.client.database().select().from(s.tables.states)) === before, true);
  assert.equal((await s.client.database().select().from(s.tables.preparations)).length, 1);
  assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  await s.client.query(`ALTER TABLE ${s.harness.table('vault_items')} DROP CONSTRAINT fixture_commit_failure`);
  passed(await s.lifecycle.resume(receipt)); await s.scan(receipt);
});
