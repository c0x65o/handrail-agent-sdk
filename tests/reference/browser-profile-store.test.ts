import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes, createCipheriv, createDecipheriv, createSecretKey } from 'node:crypto';
import { fork } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { createPostgresHarness } from '../helpers/postgres.js';
import { migrations } from '../helpers/migrations.mjs';
import { createBrowserProfileStore, type BrowserProfileHost, type BrowserProfilePolicy, type BrowserProfileResult } from '../../reference/node/browser-profile-store.js';
import { browserProfileTables, journalTables } from '../../reference/node/db/schema.js';
import { createJobJournal } from '../../reference/node/job-journal.js';
import { seal } from '../../reference/node/private-envelope.js';
import { canonical, encrypt, decrypt } from '../../reference/node/vault-private.js';
import { fixtures, keyBytes } from './vault-fixture.js';
import { profilePolicy, profileState, keyService, scope, digest, scan } from './browser-profile-fixture.js';
class Diagnostic extends Error {}
function acceptance(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, { timeout: 30_000 }, async t => { try { await run(t); } catch (e) { throw Error(e instanceof Diagnostic ? e.message : 'BROWSER_PROFILE_ACCEPTANCE_FAILED'); } });
}
function passed<T>(r: BrowserProfileResult<T>): T { if (!r.ok) throw new Diagnostic(`EXPECTED_SUCCESS_${r.code}`); return r.value; }
function denied(r: unknown, code: string) { assert.equal(JSON.stringify(r) === JSON.stringify({ ok: false, code }), true); }
async function setup(t: TestContext) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  const seed = randomBytes(32).toString('hex'), keys = keyService(seed), tables = browserProfileTables(harness.schema);
  let grant: BrowserProfilePolicy | null = profilePolicy, time = 1000;
  const host: BrowserProfileHost = { authorize: async () => grant };
  const store = createBrowserProfileStore(client.database(), host, keys, tables, () => time);
  return { harness, client, seed, keys, tables, host, store, value: profileState(seed),
    authorize(p: BrowserProfilePolicy | null) { grant = p; }, clock(t: number) { time = t; },
    rows: () => client.database().select().from(tables.snapshots), ledger: () => client.database().select().from(tables.states) };
}
async function child(mode: string, seed: string, schema: string, status?: string) {
  return new Promise<any>((resolve, reject) => {
    const worker = fork(new URL('./browser-profile-process.js', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', message: any;
    const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(Error('PRIVATE_PROCESS_TIMEOUT')); }, 15_000);
    worker.stdout!.on('data', b => { output += b; }); worker.stderr!.on('data', b => { output += b; });
    worker.on('message', m => { message = m; });
    worker.on('error', () => { clearTimeout(timeout); reject(Error('PRIVATE_PROCESS_FAILED')); });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0 || !message?.ok || scan(seed, [output, message]).matches !== 0 || output !== '') reject(Error('PRIVATE_PROCESS_FAILED'));
      else resolve({ ...message, outputBytes: Buffer.byteLength(output), scan: scan(seed, [output, message]) });
    });
    worker.send({ mode, seed, schema, status });
  });
}
acceptance('exact encrypted cookies and both storage types survive exited writer and fresh reader; durable sinks contain no canaries', async t => {
  const s = await setup(t), writer = await child('create', s.seed, s.harness.schema), reader = await child('load', s.seed, s.harness.schema);
  assert.equal(writer.pid !== reader.pid && reader.pid !== process.pid && writer.pid !== process.pid, true);
  assert.equal(reader.digest === digest(s.value) && reader.count === 3, true);
  const journal = createJobJournal(s.client.database(), journalTables(s.harness.schema));
  const r = await journal.append({ kind: 'submitted', previousRevision: 0, snapshot: {
    identity: { jobId: 'profile-job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1,
      host: scope, native: {}, origin: { channelRef: 'channel', routeRef: 'route', correlationRef: 'correlation' } },
    revision: 1, state: 'queued', effects: [],
  } }); assert.equal(r.ok, true);
  const sinks: unknown[] = [await s.rows(), await s.ledger(), writer, reader, r];
  for (const table of ['jobs', 'job_events', 'job_deliveries', 'job_checkpoints', 'job_admissions', 'job_effects']) {
    sinks.push((await s.client.query(`SELECT * FROM ${s.harness.table(table)}`)).rows);
  }
  assert.equal(scan(s.seed, sinks).matches, 0);
  t.diagnostic(`Private scan: ${scan(s.seed, sinks).scanned} needles, 0 matches; 6 journal tables; child output 0 bytes; restored 3 values.`);
});
acceptance('all six host scope dimensions deny load/save/termination/cleanup and origin checks deny before keys', async t => {
  const s = await setup(t), m = passed(await s.store.create('profile', s.value));
  for (const dimension of Object.keys(scope)) {
    s.authorize({ ...profilePolicy, scope: { ...scope, [dimension]: 'wrong' } }); const before = s.keys.calls;
    denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'not_authorized');
    denied(await s.store.save(m, s.value), 'not_authorized');
    denied(await s.store.terminate('profile', 'revoked'), 'not_authorized');
    denied(await s.store.cleanup('profile'), 'not_authorized');
    assert.equal(s.keys.calls, before);
  }
  s.authorize(profilePolicy); const before = s.keys.calls;
  for (const o of ['https://other.example.test', 'https://account.example.test/path', 'http://account.example.test']) {
    denied(await s.store.loadForExecutor('profile', o), 'origin_not_allowed');
  }
  assert.equal(s.keys.calls, before);
  s.authorize(null); denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'not_authorized');
  denied(await s.store.create('other', s.value), 'not_authorized');
});
acceptance('unsupported state, unapproved origins, getters and caller mutation never enter custody', async t => {
  const s = await setup(t);
  for (const v of [ { ...s.value, indexedDB: [] }, { ...s.value, cookies: [{ ...s.value.cookies[0], domain: '.example.test' }] },
    { ...s.value, cookies: [{ ...s.value.cookies[0], origin: 'https://other.example.test' }] },
    { ...s.value, storage: [{ ...s.value.storage[0], origin: 'https://other.example.test' }] },
    { ...s.value, cookies: [{ ...s.value.cookies[0], secure: false }] },
    { get cookies() { throw Error(); }, storage: [] } ]) denied(await s.store.create('invalid', v as any), 'invalid_payload');
  assert.equal((await s.rows()).length, 0);
  const mutable = structuredClone(s.value) as any, pending = s.store.create('profile', mutable);
  mutable.cookies[0].value = 'changed'; mutable.storage.length = 0;
  passed(await pending);
  assert.equal(digest(passed(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0])).state) === digest(s.value), true);
});
acceptance('two real PostgreSQL clients racing saves have exactly one revision winner', async t => {
  const s = await setup(t), m = passed(await s.store.create('profile', s.value)), other = await s.harness.client();
  assert.notEqual((await s.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const second = createBrowserProfileStore(other.database(), s.host, s.keys, s.tables);
  let arrived = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  s.keys.beforeResolve = async () => { if (++arrived === 2) release(); await barrier; };
  const results = await Promise.all([s.store.save(m, s.value), second.save(m, s.value)]);
  s.keys.beforeResolve = undefined; assert.equal(arrived, 2);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => !r.ok && r.code === 'conflict').length, 1);
  assert.equal(passed(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0])).metadata.revision, 2);
  denied(await s.store.save(m, s.value), 'conflict');
  s.authorize({ ...profilePolicy, authorityEpoch: profilePolicy.authorityEpoch + 1 });
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'conflict');
  denied(await s.store.save({ ...m, authorityEpoch: profilePolicy.authorityEpoch + 1 }, s.value), 'conflict');
});
for (const status of ['revoked', 'deleted'] as const) acceptance(`${status} fence survives restart, interrupted cleanup, restored ciphertext and stale saves`, async t => {
  const s = await setup(t); await child('create', s.seed, s.harness.schema); const [original] = await s.rows();
  const terminated = await child('terminate', s.seed, s.harness.schema, status);
  assert.equal(terminated.receipt.authorityEpoch, profilePolicy.authorityEpoch + 1);
  assert.equal(terminated.receipt.remote.state, 'not_requested');
  assert.equal((await s.rows()).length, 1); await child('terminal', s.seed, s.harness.schema, status);
  // A real database permission failure interrupts cleanup after committed fencing.
  await s.client.query(`REVOKE DELETE ON ${s.harness.table('browser_profile_snapshots')} FROM CURRENT_USER`);
  denied(await s.store.cleanup('process-profile'), 'unavailable');
  await s.client.query(`GRANT DELETE ON ${s.harness.table('browser_profile_snapshots')} TO CURRENT_USER`);
  await child('terminal', s.seed, s.harness.schema, status);
  const cleaned = passed(await s.store.cleanup('process-profile')); assert.equal(cleaned.local.cleanup, 'complete');
  passed(await s.store.cleanup('process-profile')); assert.equal((await s.rows()).length, 0);
  await s.client.database().insert(s.tables.snapshots).values(original);
  await child('terminal', s.seed, s.harness.schema, status);
  passed(await s.store.cleanup('process-profile')); assert.equal((await s.ledger())[0].authorityEpoch, 8);
});
acceptance('paused creates, saves and loads are fenced by termination during key resolution', async t => {
  const s = await setup(t), other = await s.harness.client();
  const terminator = createBrowserProfileStore(other.database(), s.host, keyService(s.seed), s.tables);
  let id = 'creating';
  s.keys.beforeResolve = async () => { passed(await terminator.terminate(id, 'revoked')); };
  denied(await s.store.create(id, s.value), 'conflict'); assert.equal((await s.rows()).length, 0);
  s.keys.beforeResolve = undefined; id = 'saving'; const m = passed(await s.store.create(id, s.value));
  s.keys.beforeResolve = async () => { passed(await terminator.terminate(id, 'revoked')); };
  denied(await s.store.save(m, s.value), 'profile_revoked');
  s.keys.beforeResolve = undefined; id = 'loading'; passed(await s.store.create(id, s.value));
  s.keys.beforeResolve = async () => { passed(await terminator.terminate(id, 'deleted')); };
  denied(await s.store.loadForExecutor(id, profilePolicy.allowedOrigins[0]), 'profile_deleted');
});
acceptance('expiry equality and expiry during key resolution request reauthentication without extending state', async t => {
  const s = await setup(t), m = passed(await s.store.create('profile', s.value));
  s.clock(profilePolicy.expiresAt);
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'reauthentication_required');
  denied(await s.store.save(m, s.value), 'reauthentication_required');
  denied(await s.store.create('other', s.value), 'reauthentication_required');
  s.clock(1000); s.keys.beforeResolve = async () => { s.clock(profilePolicy.expiresAt); };
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'reauthentication_required');
  s.clock(1000); denied(await s.store.save(m, s.value), 'reauthentication_required');
  assert.equal((await s.ledger())[0].revision, 1);
});
acceptance('missing and wrong keys never try another key or profile; fixed errors remain private', async t => {
  const s = await setup(t); passed(await s.store.create('profile', s.value)); passed(await s.store.create('alternative', s.value));
  s.keys.unavailable.add(1); const before = s.keys.calls;
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'key_unavailable'); assert.equal(s.keys.calls, before + 1);
  s.keys.unavailable.clear(); s.keys.wrong.add(1); const wrong = s.keys.calls;
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'corrupt_state'); assert.equal(s.keys.calls, wrong + 1);
  denied(await s.store.loadForExecutor('missing', profilePolicy.allowedOrigins[0]), 'profile_missing'); assert.equal(s.keys.calls, wrong + 1);
});
acceptance('tampered ciphertext, encodings, scope and version metadata cannot restore state', async t => {
  const s = await setup(t); passed(await s.store.create('profile', s.value)); const [original] = await s.rows(), [ledger] = await s.ledger();
  for (const field of ['nonce', 'ciphertext', 'tag'] as const) {
    const b = Buffer.from(original[field], 'base64'); b[0] ^= 1;
    for (const value of [b.toString('base64'), '*bad*', '']) {
      await s.client.database().update(s.tables.snapshots).set({ ...original, [field]: value });
      if (field === 'nonce') await s.client.database().update(s.tables.states).set({ activeNonce: value });
      denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'corrupt_state');
    }
    await s.client.database().update(s.tables.states).set(ledger);
  }
  for (const changed of [{ stateFormatVersion: 2 }, { envelopeVersion: 2 }, { algorithm: 'unsupported' }]) {
    const row = 'stateFormatVersion' in changed ? { ...original, metadata: { ...original.metadata, ...changed } } : { ...original, ...changed };
    await s.client.database().update(s.tables.snapshots).set(row);
    denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'incompatible_state');
  }
  // Change both trusted policy and ledger to reach cryptographic authentication.
  for (const dimension of Object.keys(scope)) {
    const changed = { ...scope, [dimension]: 'altered' }, p = { ...profilePolicy, scope: changed };
    s.authorize(p); await s.client.database().update(s.tables.states).set({ ...ledger, scope: changed });
    await s.client.database().update(s.tables.snapshots).set({ ...original, metadata: { ...original.metadata, scope: changed } });
    denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'corrupt_state');
  }
  for (const delta of [{ expiresAt: profilePolicy.expiresAt + 1 }, { authorityEpoch: 8 }, { allowedOrigins: ['https://altered.example.test'] }]) {
    const p = { ...profilePolicy, ...delta }; s.authorize(p);
    await s.client.database().update(s.tables.states).set({ ...ledger, authorityEpoch: p.authorityEpoch });
    await s.client.database().update(s.tables.snapshots).set({ ...original, metadata: { ...original.metadata, ...delta } });
    denied(await s.store.loadForExecutor('profile', p.allowedOrigins[0]), 'corrupt_state');
  }
  s.authorize(profilePolicy); await s.client.database().update(s.tables.states).set({ ...ledger, revision: 2 });
  await s.client.database().update(s.tables.snapshots).set({ ...original, metadata: { ...original.metadata, revision: 2 } });
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'corrupt_state');
});
acceptance('old ciphertext cannot roll back an active revision; missing ledger never reconstructs authority', async t => {
  const s = await setup(t), m = passed(await s.store.create('profile', s.value)), [old] = await s.rows();
  passed(await s.store.save(m, s.value)); await s.client.database().update(s.tables.snapshots).set(old);
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'conflict');
  await s.client.database().delete(s.tables.states);
  denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'profile_missing');
  denied(await s.store.create('profile', s.value), 'conflict'); assert.equal((await s.ledger()).length, 0);
});
acceptance('authorization changes and thrown secret-bearing service errors have only fixed results', async t => {
  const s = await setup(t); passed(await s.store.create('profile', s.value));
  s.keys.beforeResolve = async () => { s.authorize(null); };
  const results = [await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0])]; denied(results[0], 'not_authorized');
  const host = { authorize: async () => { throw Error(s.value.cookies[0].value); } };
  const bad = createBrowserProfileStore(s.client.database(), host, s.keys, s.tables);
  results.push(await bad.loadForExecutor('profile', profilePolicy.allowedOrigins[0])); denied(results[1], 'not_authorized');
  s.authorize(profilePolicy); s.keys.beforeResolve = async () => { throw Error(keyBytes(s.seed).toString('hex')); };
  results.push(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0])); denied(results[2], 'key_unavailable');
  assert.equal(scan(s.seed, results).matches, 0);
});
acceptance('generated migrations rerun and constraints reject nonce reuse without touching sentinel schema', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup()); const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (42)`);
  const s = await setup(t); await migrations(t, s.harness, s.client); passed(await s.store.create('profile', s.value));
  const [row] = await s.rows(); let rejected = false;
  try { await s.client.database().insert(s.tables.snapshots).values({ ...row, profileRef: 'duplicate' }); } catch { rejected = true; }
  assert.equal(rejected, true); await s.harness.cleanup();
  assert.equal((await observer.query(`SELECT value FROM ${sentinel.table('sentinel')}`)).rows[0].value, 42);
});
acceptance('shared primitive preserves legacy vault v1 bytes and authenticates a distinct browser domain', async () => {
  const seed = randomBytes(32).toString('hex'), f = fixtures(seed)[0], key = createSecretKey(keyBytes(seed));
  const header = { itemId: 'secret-0', revision: 1, scope, item: f.item, envelopeVersion: 1, algorithm: 'aes-256-gcm', keyHandle: 'private-key', keyVersion: 1 };
  const aad = Buffer.from(canonical({ domain: 'handrail-reference-vault', ...header })), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(f.value)), cipher.final()]);
  const legacy = { ...header, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  assert.equal(JSON.stringify(decrypt(legacy, key)) === JSON.stringify(f.value), true);
  const current = encrypt(header, f.value, key), reader = createDecipheriv('aes-256-gcm', key, Buffer.from(current.nonce, 'base64'));
  reader.setAAD(aad); reader.setAuthTag(Buffer.from(current.tag, 'base64'));
  const plaintext = Buffer.concat([reader.update(Buffer.from(current.ciphertext, 'base64')), reader.final()]);
  try { assert.equal(plaintext.toString() === JSON.stringify(f.value), true); } finally { plaintext.fill(0); }
  const wrongDomain = createDecipheriv('aes-256-gcm', key, nonce);
  wrongDomain.setAAD(Buffer.from(canonical({ domain: 'handrail-reference-browser-profile', ...header })));
  wrongDomain.setAuthTag(Buffer.from(legacy.tag, 'base64')); const partial = wrongDomain.update(ciphertext);
  try { assert.throws(() => wrongDomain.final()); } finally { partial.fill(0); }
});

acceptance('authenticated but unsupported plaintext and cross-profile envelope swaps fail closed', async t => {
  const s = await setup(t); passed(await s.store.create('profile', s.value)); const [row] = await s.rows();
  const { nonce: _nonce, ciphertext: _ciphertext, tag: _tag, ...header } = row;
  const authenticated = Buffer.from(canonical({ domain: 'handrail-reference-browser-profile', ...header }));
  for (const value of [{ ...s.value, unsupported: [] }, { ...s.value, cookies: [{ ...s.value.cookies[0], origin: 'https://other.example.test' }] }]) {
    const envelope = seal(value, createSecretKey(keyBytes(s.seed)), authenticated);
    await s.client.database().update(s.tables.snapshots).set({ ...row, ...envelope });
    await s.client.database().update(s.tables.states).set({ activeNonce: envelope.nonce });
    denied(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]), 'corrupt_state');
  }
  await s.client.database().update(s.tables.snapshots).set({ ...row, profileRef: 'swapped', metadata: { ...row.metadata, profileRef: 'swapped' } });
  await s.client.database().update(s.tables.states).set({ profileRef: 'swapped', activeNonce: row.nonce });
  denied(await s.store.loadForExecutor('swapped', profilePolicy.allowedOrigins[0]), 'corrupt_state');
});
acceptance('concurrent creation has one winner and failed SQL save rolls back snapshot and revision together', async t => {
  const s = await setup(t), other = await s.harness.client();
  const second = createBrowserProfileStore(other.database(), s.host, s.keys, s.tables);
  const results = await Promise.all([s.store.create('profile', s.value), second.create('profile', s.value)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => !r.ok && r.code === 'conflict').length, 1);
  const m = passed(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0])).metadata;
  await s.client.query(`ALTER TABLE ${s.harness.table('browser_profile_states')} ADD CONSTRAINT fixture_revision_limit CHECK (revision = 1)`);
  const before = JSON.stringify(await s.rows());
  denied(await s.store.save(m, s.value), 'unavailable');
  assert.equal(JSON.stringify(await s.rows()) === before, true); assert.equal((await s.ledger())[0].revision, 1);
  passed(await s.store.loadForExecutor('profile', profilePolicy.allowedOrigins[0]));
});
