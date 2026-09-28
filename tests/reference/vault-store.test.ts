import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { randomBytes, createSecretKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createPostgresHarness } from '../helpers/postgres.js';
import { migrations } from '../helpers/migrations.mjs';
import { createVaultStore } from '../../reference/node/vault-store.js';
import type { VaultScope, VaultStorageHost } from '../../reference/node/vault-store.js';
import type { VaultItem } from '../../src/contracts/vault.js';
import { vaultTables, journalTables } from '../../reference/node/db/schema.js';
import { createJobJournal } from '../../reference/node/job-journal.js';
import { fixtures, keyService, keyBytes, privateScan, scope } from './vault-fixture.js';

// Catch even assertion/driver failures before TAP can serialize a private value.
function acceptance(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, async t => { try { await run(t); } catch { throw Error('VAULT_ACCEPTANCE_FAILED'); } });
}
function passed<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw Error('VAULT_EXPECTED_SUCCESS');
  return r.value;
}
function denied(r: unknown, code: string) { assert.equal(JSON.stringify(r) === JSON.stringify({ ok: false, code }), true); }
async function setup(t: TestContext) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client();
  await migrations(t, harness, client);
  const seed = randomBytes(32).toString('hex');
  const keys = keyService(seed), tables = vaultTables(harness.schema);
  let authority: VaultScope | null = scope;
  const host: VaultStorageHost = { authorize: async () => authority };
  const store = createVaultStore(client.database(), host, keys, tables);
  return { harness, client, seed, keys, tables, store, host,
    authorize(value: VaultScope | null) { authority = value; },
    fixture: fixtures(seed)[0], rows: () => client.database().select().from(tables.items) };
}
async function child(mode: 'write' | 'read', seed: string, schema: string) {
  return new Promise<{ ok: boolean; pid: number; count: number; receipts: unknown[]; output: string }>((resolve, reject) => {
    const worker = fork(new URL('./vault-process.js', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', message: any;
    const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(Error('PRIVATE_PROCESS_TIMEOUT')); }, 15_000);
    worker.stdout!.on('data', b => { output += b; }); worker.stderr!.on('data', b => { output += b; });
    worker.on('message', value => { message = value; });
    worker.on('error', () => { clearTimeout(timeout); reject(Error('PRIVATE_PROCESS_FAILED')); });
    worker.on('exit', code => {
      clearTimeout(timeout);
      // No captured bytes are ever attached to assertion errors.
      if (code !== 0 || !message?.ok || !privateScan(seed, [message, output])) reject(Error('PRIVATE_PROCESS_FAILED'));
      else resolve({ ...message, output });
    });
    worker.send({ mode, seed, schema });
  });
}

acceptance('all eight variants survive exited writer and fresh reader processes; restart nonces and sinks stay private', async t => {
  const s = await setup(t);
  const writer = await child('write', s.seed, s.harness.schema);
  const reader = await child('read', s.seed, s.harness.schema);
  assert.equal(writer.pid !== reader.pid && writer.pid !== process.pid && reader.pid !== process.pid, true);
  assert.equal(writer.count === 8 && reader.count === 8, true);
  const rows = await s.rows();
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows.map(r => r.nonce)).size, 16);
  // Exercise a populated journal, event/checkpoint and reference receipt sink.
  const journal = createJobJournal(s.client.database(), journalTables(s.harness.schema));
  const receipt = await journal.append({ kind: 'submitted', previousRevision: 0, snapshot: {
    identity: { jobId: 'vault-job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1, host: scope,
      native: {}, origin: { channelRef: 'channel', routeRef: 'route', correlationRef: 'correlation' } },
    revision: 1, state: 'queued', effects: [],
  } });
  passed(receipt);
  const sinks: unknown[] = [rows, writer, reader, receipt];
  for (const name of ['jobs', 'job_events', 'job_deliveries', 'job_checkpoints', 'job_admissions']) {
    sinks.push((await s.client.query(`SELECT * FROM ${s.harness.table(name)}`)).rows);
  }
  assert.equal(privateScan(s.seed, sinks), true);
  assert.equal(writer.output === '' && reader.output === '', true);
  t.diagnostic('Two distinct child processes exited successfully; 8 variants recovered, 16 unique persisted nonces; private scans passed.');
});

acceptance('each ownership dimension denies reads and writes before any key service call', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  for (const dimension of Object.keys(scope)) {
    s.authorize({ ...scope, [dimension]: 'unauthorized' });
    const before = s.keys.calls;
    denied(await s.store.readForExecutor(f.item), 'not_authorized');
    denied(await s.store.create(f.item, f.value), 'not_authorized');
    assert.equal(s.keys.calls, before);
  }
  s.authorize(null);
  const before = s.keys.calls;
  denied(await s.store.create(fixtures(s.seed, '-denied')[0].item, f.value), 'not_authorized');
  denied(await s.store.readForExecutor(f.item), 'not_authorized');
  assert.equal(s.keys.calls, before);
  assert.equal((await s.rows()).length, 1);
});

acceptance('ciphertext, tag and nonce corruption and malformed encoding fail closed', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  const [original] = await s.rows();
  const errors = [];
  for (const field of ['ciphertext', 'nonce', 'tag'] as const) {
    const corrupted = Buffer.from(original[field], 'base64'); corrupted[0] ^= 1;
    for (const value of [corrupted.toString('base64'), '*malformed*', '']) {
      await s.client.database().update(s.tables.items).set({ ...original, [field]: value });
      const error = await s.store.readForExecutor(f.item); errors.push(error); denied(error, 'unavailable');
    }
  }
  assert.equal(privateScan(s.seed, errors), true);
});

acceptance('all six swapped scope fields remain authenticated even when host authorizes the altered scope', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  for (const dimension of Object.keys(scope)) {
    const changed = { ...scope, [dimension]: 'changed' };
    await s.client.database().update(s.tables.items).set({ scope: changed });
    s.authorize(changed);
    denied(await s.store.readForExecutor(f.item), 'unavailable');
  }
});

acceptance('swapped item, revision and valid type metadata cannot authenticate', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  const [original] = await s.rows();
  const changedItems: VaultItem[] = [
    { ...f.item, reference: { kind: 'secret', itemRef: 'replacement', revision: 1 } } as VaultItem,
    { ...f.item, reference: { kind: 'secret', itemRef: 'secret-0', revision: 2 } } as VaultItem,
    { metadata: { kind: 'token', tokenType: 'api' }, reference: { kind: 'secret', itemRef: 'secret-0', revision: 1 } },
  ];
  for (const item of changedItems) {
    await s.client.database().update(s.tables.items).set({ ...original, item,
      itemId: item.reference.kind === 'secret' ? item.reference.itemRef : item.reference.paymentRef, revision: item.reference.revision });
    denied(await s.store.readForExecutor(item), 'unavailable');
  }
  await s.client.database().update(s.tables.items).set(original);
  for (const item of changedItems.slice(1)) denied(await s.store.readForExecutor(item), 'unavailable');
});

acceptance('missing and wrong keys, unsupported envelope/algorithm/key versions have bounded errors', async t => {
  const s = await setup(t), f = s.fixture;
  passed(await s.store.create(f.item, f.value));
  const [original] = await s.rows();
  for (const patch of [{ keyHandle: 'missing' }, { keyVersion: 2 }, { keyVersion: 0 }, { envelopeVersion: 2 }, { algorithm: 'unsupported' }]) {
    await s.client.database().update(s.tables.items).set({ ...original, ...patch });
    denied(await s.store.readForExecutor(f.item), 'unavailable');
  }
  await s.client.database().update(s.tables.items).set(original);
  const bad = createVaultStore(s.client.database(), s.host, { ...s.keys, resolve: async () => createSecretKey(randomBytes(32)) }, s.tables);
  denied(await bad.readForExecutor(f.item), 'unavailable');
  const errors = [];
  for (const resolve of [async () => null, async () => { throw Error(Object.values(f.value)[0]); }]) {
    const broken = createVaultStore(s.client.database(), s.host, { ...s.keys, resolve }, s.tables);
    errors.push(await broken.readForExecutor(f.item));
    denied(errors.at(-1), 'unavailable');
  }
  assert.equal(privateScan(s.seed, errors), true);
});

acceptance('token, identity and payment metadata and key identifiers are cryptographically bound', async t => {
  const s = await setup(t);
  for (const f of fixtures(s.seed).slice(1)) {
    passed(await s.store.create(f.item, f.value));
    const id = f.item.reference.kind === 'secret' ? f.item.reference.itemRef : f.item.reference.paymentRef;
    const [row] = (await s.rows()).filter(r => r.itemId === id);
    const metadata = f.item.metadata;
    const changes = metadata.kind === 'token' ? [{ ...metadata, tokenType: metadata.tokenType === 'api' ? 'refresh' : 'api' }]
      : metadata.kind === 'identity' ? [{ ...metadata, field: metadata.field === 'ssn' ? 'tax_id' : 'ssn' }, { ...metadata, provenanceRef: 'other-fixture' }]
      : metadata.kind === 'payment_method' ? ['instrument'].map(k => ({ ...metadata, [k]: 'other' })) : [];
    for (const changed of changes) {
      const item = { ...f.item, metadata: changed } as VaultItem;
      await s.client.database().update(s.tables.items).set({ item }).where(eq(s.tables.items.itemId, id));
      denied(await s.store.readForExecutor(metadata.kind === 'payment_method' ? f.item : item), 'unavailable');
    }
    await s.client.database().update(s.tables.items).set(row).where(eq(s.tables.items.itemId, id));
  }
  const f = fixtures(s.seed)[1];
  const [row] = (await s.rows()).filter(r => r.itemId === 'secret-1');
  // Same actual key returned for altered aliases: AAD, not key lookup failure,
  // must reject both handle and key version substitution.
  const keys = { ...s.keys, resolve: async () => createSecretKey(keyBytes(s.seed)) };
  const store = createVaultStore(s.client.database(), s.host, keys, s.tables);
  for (const patch of [{ keyHandle: 'other-handle' }, { keyVersion: 2 }]) {
    await s.client.database().update(s.tables.items).set({ ...row, ...patch }).where(eq(s.tables.items.itemId, row.itemId));
    denied(await store.readForExecutor(f.item), 'unavailable');
  }
});

acceptance('invalid or unavailable active keys never persist a row and need no fallback', async t => {
  const s = await setup(t), f = s.fixture;
  const providers = [
    { ...s.keys, active: async () => { throw Error(Object.values(f.value)[0]); } },
    { ...s.keys, active: async () => ({ keyHandle: 'private-key', keyVersion: 0 }) },
    { ...s.keys, resolve: async () => null },
    { ...s.keys, resolve: async () => createSecretKey(randomBytes(16)) },
  ];
  const errors = [];
  for (const keys of providers) {
    const store = createVaultStore(s.client.database(), s.host, keys, s.tables);
    errors.push(await store.create(f.item, f.value)); denied(errors.at(-1), 'unavailable');
  }
  assert.equal((await s.rows()).length, 0);
  assert.equal(privateScan(s.seed, errors), true);
});

acceptance('strict value shapes reject incomplete card data and security codes, identity bundles and accessor metadata without key access', async t => {
  const s = await setup(t);
  const payment = fixtures(s.seed)[7], identity = fixtures(s.seed)[3];
  for (const [item, value] of [
    [payment.item, { password: 'synthetic' }], [payment.item, { adapterRef: '4111111111111111' }],
    [payment.item, { pan: '4111111111111111', cvv: '123' }],
    [payment.item, { ...payment.value, cvv: '123' }], [identity.item, { value: 'synthetic', ssn: 'synthetic' }],
    [s.fixture.item, { password: 'x'.repeat(16_385) }],
    [{ ...identity.item, metadata: { ...identity.item.metadata, classification: 'real' } }, identity.value],
  ] as const) denied(await s.store.create(item as VaultItem, value as any), 'invalid_payload');
  let invoked = false;
  const input = { ...s.fixture.item };
  Object.defineProperty(input, 'metadata', { enumerable: true, get() { invoked = true; throw Error(); } });
  denied(await s.store.create(input, s.fixture.value), 'invalid_payload');
  assert.equal(invoked, false); assert.equal(s.keys.calls, 0); assert.equal((await s.rows()).length, 0);
  const host = { authorize: async () => scope };
  passed(await createVaultStore(s.client.database(), host, s.keys, s.tables).create(payment.item, payment.value));
});

acceptance('concurrent writes have one winner and duplicate writes never overwrite ciphertext', async t => {
  const s = await setup(t), f = s.fixture, second = await s.harness.client();
  const other = createVaultStore(second.database(), s.host, s.keys, s.tables);
  const results = await Promise.all([s.store.create(f.item, f.value), other.create(f.item, f.value)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok && r.code === 'conflict').length, 1);
  const before = JSON.stringify(await s.rows()), calls = s.keys.calls;
  denied(await other.create(f.item, f.value), 'conflict');
  assert.equal(s.keys.calls, calls); assert.equal(JSON.stringify(await s.rows()) === before, true);
  passed(await other.readForExecutor(f.item));
});

acceptance('detached inputs and repeated host checks fence revocation during key resolution', async t => {
  const s = await setup(t), f = s.fixture;
  const mutable = structuredClone(f);
  const pending = s.store.create(mutable.item, mutable.value);
  (mutable.value as { password: string }).password = 'changed';
  (mutable.item.reference as { itemRef: string }).itemRef = 'changed';
  passed(await pending);
  assert.equal(JSON.stringify(passed(await s.store.readForExecutor(f.item))) === JSON.stringify(f.value), true);
  const keys = { ...s.keys, resolve: async (...args: Parameters<typeof s.keys.resolve>) => {
    await s.keys.resolve(...args); s.authorize(null);
    // If decryption were attempted before reauthorization this wrong key would
    // return unavailable, rather than the required not_authorized.
    return createSecretKey(randomBytes(32));
  } };
  const store = createVaultStore(s.client.database(), s.host, keys, s.tables);
  denied(await store.readForExecutor(f.item), 'not_authorized');
  s.authorize(scope);
  denied(await store.create(fixtures(s.seed, '-revoke')[0].item, f.value), 'not_authorized');
  assert.equal((await s.rows()).length, 1);
});

acceptance('driver and authorization failures never retain canaries or key bytes in errors or receipts', async t => {
  const s = await setup(t), f = s.fixture;
  const errors = [];
  const host = { authorize: async () => { throw Error(keyBytes(s.seed).toString('hex')); } };
  const store = createVaultStore(s.client.database(), host, s.keys, s.tables);
  errors.push(await store.create(f.item, f.value), await store.readForExecutor(f.item));
  errors.forEach(e => denied(e, 'not_authorized'));
  assert.equal(s.keys.calls, 0);
  await s.client.query(`ALTER TABLE ${s.harness.table('vault_items')} ADD CONSTRAINT fixture_failure CHECK (revision < 1)`);
  errors.push(await s.store.create(f.item, f.value)); denied(errors.at(-1), 'unavailable');
  assert.equal((await s.rows()).length, 0);
  await s.client.close();
  errors.push(await s.store.create(f.item, f.value), await s.store.readForExecutor(f.item));
  errors.slice(-2).forEach(e => denied(e, 'unavailable'));
  assert.equal(privateScan(s.seed, errors), true);
});

acceptance('generated migration reruns, uniqueness constraints and owned cleanup preserve independent sentinel', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup());
  const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (42)`);
  const s = await setup(t);
  await migrations(t, s.harness, s.client);
  passed(await s.store.create(s.fixture.item, s.fixture.value));
  const [row] = await s.rows();
  let rejected = false;
  try { await s.client.database().insert(s.tables.items).values({ ...row, itemId: 'duplicate-nonce' }); } catch { rejected = true; }
  assert.equal(rejected, true);
  await s.harness.cleanup();
  assert.equal((await observer.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1', [s.harness.schema])).rowCount, 0);
  assert.equal((await observer.query(`SELECT value FROM ${sentinel.table('sentinel')}`)).rows[0].value, 42);
  t.diagnostic('Owned migrated schema removed; independent sentinel preserved; both harness cleanups succeeded.');
});
