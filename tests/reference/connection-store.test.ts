import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';
import { createConnectionStore } from '../../reference/node/connection-store.js';
import { connectionTables, journalTables } from '../../reference/node/db/schema.js';
import type { ConnectionEnsureInput, ConnectionEnsureResult } from '../../src/contracts/connection.js';
import type { ConnectionCredentials, ConnectionStoreAuthority, ConnectionStoreHost, ConnectionStoreResult } from '../../src/server/connection-store.js';
import { createPostgresHarness } from '../helpers/postgres.js';
import { migrations } from '../helpers/migrations.mjs';

class Diagnostic extends Error {}
function acceptance(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, { timeout: 30_000 }, async t => {
    try { await run(t); } catch (e) { throw Error(e instanceof Diagnostic ? e.message : 'CONNECTION_STORE_ACCEPTANCE_FAILED'); }
  });
}
function passed<T>(r: ConnectionStoreResult<T>): T { if (!r.ok) throw new Diagnostic(`EXPECTED_SUCCESS_${r.code}`); return r.value; }
function denied(r: unknown, code: string) { assert.equal(JSON.stringify(r) === JSON.stringify({ ok: false, code }), true); }
const clone = <T>(v: T): T => structuredClone(v);
const scope = { tenantRef: 'tenant-1', userRef: 'user-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'env-1', purposeRef: 'purpose-1' };
function request(): ConnectionEnsureInput {
  return { operation: 'connection.ensure', connectionRef: 'connection-1', providerRef: 'provider-1', prerequisiteVersion: 'recipe-v1',
    evidenceMode: 'fixture', minimumCapabilities: ['api.read'], effect: { actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1' },
    identity: { jobId: 'job-1', originTaskRef: 'task-1', requestKey: 'request-1', instructionRevision: 1, host: clone(scope),
      native: {}, origin: { channelRef: 'channel-1', routeRef: 'route-1', correlationRef: 'correlation-1' } } };
}
const credential: ConnectionCredentials = { tokenRef: 'vault-token-1', profileRef: 'profile-1', credentialRevision: 1,
  credentialExpiresAt: 5000, grantRef: 'grant-1', grantRevision: 1, grantExpiresAt: 4000 };
const binding = { credentialRevision: 1, grantRevision: 1 };
function ready(r = request(), receiptRef = 'receipt-1'): ConnectionEnsureResult {
  return { request: r, state: 'ready', authorization: { state: 'active', expiresAt: 3000 },
    evidence: { kind: 'api_capabilities', receiptRef, provenance: r.evidenceMode === 'fixture'
      ? { kind: 'fixture', fixtureRef: 'fixture-1' } : { kind: 'provider', verificationRef: 'synthetic-verification-1' },
      scope: r.identity.host, providerRef: r.providerRef, prerequisiteVersion: r.prerequisiteVersion,
      verifiedCapabilities: r.minimumCapabilities, verifiedAt: 900, expiresAt: 2000 } };
}
function intermediate(r = request()): ConnectionEnsureResult { return { request: r, state: 'verifying', authorization: { state: 'unverified' } }; }
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function setup(t: TestContext) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  let time = 1000, authority: ConnectionStoreAuthority = { scope }, allowed = true;
  const host: ConnectionStoreHost = { now: () => time, withAuthority: async (_r, _op, run) => allowed ? run(authority) : { ok: false, code: 'not_authorized' } };
  const store = createConnectionStore(client.database(), host, harness.schema), r = request();
  return { harness, client, host, store, r, tables: connectionTables(harness.schema),
    clock: (v: number) => { time = v; }, authorize: (v: ConnectionStoreAuthority) => { authority = v; }, deny: () => { allowed = false; },
    async initialized() { passed(await store.admit(r)); return passed(await store.rotate(r, 1, credential)); },
    async second(otherHost = host) { const other = await harness.client(); return createConnectionStore(other.database(), otherHost, harness.schema); } };
}
acceptance('current verification persists private revisions and restores the same reference through a fresh SQL connection', async t => {
  const s = await setup(t); await s.initialized();
  const saved = passed(await s.store.reconnect(s.r, 2, ready(), binding));
  assert.equal(saved.revision, 3); assert.equal(saved.result.state, 'ready');
  assert.equal(saved.result.request.vaultRef, undefined); assert.equal(saved.credentials?.tokenRef, 'vault-token-1');
  await s.client.close(); const fresh = await s.second();
  assert.deepEqual(passed(await fresh.load(s.r)), saved);
});
acceptance('identical admission and CAS retries preserve the original fact; changed content conflicts', async t => {
  const s = await setup(t); const original = passed(await s.store.admit(s.r));
  assert.deepEqual(passed(await s.store.admit(s.r)), original);
  await s.initialized();
  const saved = passed(await s.store.reconnect(s.r, 2, ready(), binding));
  assert.deepEqual(passed(await s.store.reconnect(s.r, 2, ready(), binding)), saved);
  denied(await s.store.reconnect(s.r, 2, ready(s.r, 'receipt-other'), binding), 'conflict');
  assert.equal((await s.client.database().select().from(s.tables.revisions)).length, 3);
  assert.equal((await s.client.database().select().from(s.tables.receipts)).length, 1);
});
for (const mutation of ['revoke', 'rotate'] as const) acceptance(`verification racing ${mutation} cannot publish stale readiness`, async t => {
  const s = await setup(t); await s.initialized();
  const entered = latch(), release = latch();
  const verifier = await s.second({ ...s.host, withAuthority: async (r, op, run) => {
    if (op === 'reconnect') { entered.release(); await release.promise; }
    return s.host.withAuthority(r, op, run);
  } });
  const pending = verifier.reconnect(s.r, 2, ready(), binding); await entered.promise;
  try {
    const next = mutation === 'revoke' ? await s.store.revoke(s.r, 2)
      : await s.store.rotate(s.r, 2, { ...credential, tokenRef: 'vault-token-2', credentialRevision: 2 });
    passed(next);
    assert.equal(passed(await s.store.load(s.r)).result.state, 'inspecting');
  } finally { release.release(); }
  denied(await pending, 'conflict');
  denied(await verifier.reconnect(s.r, 3, ready(), binding), 'not_current');
  assert.equal((await s.client.database().select().from(s.tables.receipts)).length, 0);
});
acceptance('rotation and revocation fence already-ready reads before any asynchronous cleanup', async t => {
  const s = await setup(t); await s.initialized(); passed(await s.store.reconnect(s.r, 2, ready(), binding));
  passed(await s.store.rotate(s.r, 3, { ...credential, credentialRevision: 2, tokenRef: 'vault-token-2' }));
  const second = await s.second(); assert.equal(passed(await second.load(s.r)).result.state, 'inspecting');
  denied(await second.reconnect(s.r, 4, ready(), binding), 'not_current');
  passed(await second.reconnect(s.r, 4, ready(s.r, 'receipt-2'), { ...binding, credentialRevision: 2 }));
  passed(await s.store.revoke(s.r, 5));
  assert.equal(passed(await second.load(s.r)).locallyRevoked, true);
  denied(await second.reconnect(s.r, 6, ready(s.r, 'receipt-3'), { ...binding, credentialRevision: 2 }), 'not_current');
  // Even possession of current credential revision cannot restore a revoked grant.
  denied(await second.rotate(s.r, 6, { ...credential, credentialRevision: 3 }), 'conflict');
});
acceptance('independent connections contend at a deterministic barrier: one CAS winner and one conflict', async t => {
  const s = await setup(t); await s.initialized();
  const gate = latch(); let arrivals = 0;
  const host: ConnectionStoreHost = { ...s.host, withAuthority: async (r, op, run) => {
    if (++arrivals === 2) gate.release(); await gate.promise; return s.host.withAuthority(r, op, run);
  } };
  const a = await s.second(host), b = await s.second(host);
  const outcomes = await Promise.all([a.reconnect(s.r, 2, intermediate()), b.reconnect(s.r, 2, { ...intermediate(), state: 'configuring' })]);
  assert.equal(outcomes.filter(r => r.ok).length, 1); assert.equal(outcomes.filter(r => !r.ok && r.code === 'conflict').length, 1);
  assert.equal(passed(await s.store.load(s.r)).revision, 3);
});
acceptance('concurrent identical admission has one durable logical identity; alias and immutable request changes are denied', async t => {
  const s = await setup(t), other = await s.second();
  const outcomes = await Promise.all([s.store.admit(s.r), other.admit(s.r)]);
  assert.deepEqual(passed(outcomes[0]), passed(outcomes[1]));
  denied(await other.admit({ ...s.r, connectionRef: 'alias-connection' }), 'conflict');
  for (const change of [{ prerequisiteVersion: 'recipe-v2' }, { minimumCapabilities: ['api.write'] }, { vaultRef: 'new-admitted-custody' },
    { evidenceMode: 'provider' as const }, { identity: { ...s.r.identity, originTaskRef: 'new-task' } }]) {
    denied(await other.admit({ ...s.r, ...change }), 'request_mismatch');
  }
  assert.equal((await s.client.database().select().from(s.tables.connections)).length, 1);
});
for (const dimension of Object.keys(scope) as (keyof typeof scope)[]) acceptance(`wrong ${dimension} is denied on lookup and writes even with host scope supplied`, async t => {
  const s = await setup(t); await s.initialized();
  const wrong = { ...s.r, identity: { ...s.r.identity, host: { ...scope, [dimension]: 'wrong' } } };
  denied(await s.store.load(wrong), 'not_authorized');
  s.authorize({ scope: wrong.identity.host });
  denied(await s.store.load(wrong), 'not_authorized');
  denied(await s.store.revoke(wrong, 2), 'not_authorized');
});
acceptance('expiry is rechecked for ready reads and identical retries; stale grant bindings fail', async t => {
  const s = await setup(t); await s.initialized();
  denied(await s.store.reconnect(s.r, 2, ready(), { ...binding, grantRevision: 2 }), 'not_current');
  passed(await s.store.reconnect(s.r, 2, ready(), binding)); s.clock(2000);
  denied(await s.store.load(s.r), 'not_current'); denied(await s.store.reconnect(s.r, 2, ready(), binding), 'not_current');
  s.clock(1000);
  passed(await s.store.rotate(s.r, 3, { ...credential, grantRevision: 2 }));
  denied(await s.store.reconnect(s.r, 4, ready(), binding), 'not_current');
  passed(await s.store.reconnect(s.r, 4, ready(s.r, 'receipt-new-grant'), { ...binding, grantRevision: 2 }));
});
acceptance('credential, grant, authorization and evidence expiry are independently enforced', async t => {
  const s = await setup(t); passed(await s.store.admit(s.r));
  for (const c of [{ ...credential, credentialExpiresAt: 1000 }, { ...credential, grantExpiresAt: 1000 }]) denied(await s.store.rotate(s.r, 1, c), 'not_current');
  passed(await s.store.rotate(s.r, 1, credential));
  const result = ready(); assert.equal(result.state, 'ready'); if (result.state !== 'ready') throw Error();
  for (const bad of [{ ...result, authorization: { state: 'active' as const, expiresAt: 1000 } },
    { ...result, authorization: { state: 'active' as const, expiresAt: 6000 } },
    { ...result, evidence: { ...result.evidence, expiresAt: 1000 } },
    { ...result, evidence: { ...result.evidence, expiresAt: 6000 } }]) denied(await s.store.reconnect(s.r, 2, bad, binding), 'not_current');
});
acceptance('canonical receipt contents and revision bindings survive intermediate states and fresh stores', async t => {
  const s = await setup(t); await s.initialized(); const result = ready();
  if (result.state !== 'ready') throw Error();
  passed(await s.store.reconnect(s.r, 2, result, binding)); passed(await s.store.reconnect(s.r, 3, intermediate()));
  const second = await s.second();
  denied(await second.reconnect(s.r, 4, { ...result, evidence: { ...result.evidence, expiresAt: 2100 } }, binding), 'receipt_conflict');
  denied(await second.reconnect(s.r, 4, { ...result, evidence: { ...result.evidence, provenance: { kind: 'fixture', fixtureRef: 'other-fixture' } } }, binding), 'receipt_conflict');
  passed(await second.reconnect(s.r, 4, result, binding));
  passed(await second.rotate(s.r, 5, { ...credential, credentialRevision: 2 }));
  denied(await second.reconnect(s.r, 6, result, { ...binding, credentialRevision: 2 }), 'receipt_conflict');
});
acceptance('receipt identity cannot be relabelled as provider evidence under a new admission', async t => {
  const s = await setup(t); await s.initialized(); passed(await s.store.reconnect(s.r, 2, ready(), binding));
  const provider = { ...s.r, connectionRef: 'provider-connection', evidenceMode: 'provider' as const };
  passed(await s.store.admit(provider)); passed(await s.store.rotate(provider, 1, credential));
  denied(await s.store.reconnect(provider, 2, ready(provider), binding), 'receipt_conflict');
  const fixtureResult = ready(); if (fixtureResult.state !== 'ready') throw Error();
  denied(await s.store.reconnect(s.r, 3, { ...fixtureResult, evidence: { ...fixtureResult.evidence,
    provenance: { kind: 'provider', verificationRef: 'synthetic' } } }, binding), 'provenance_mismatch');
});
acceptance('unresolved effects retain their original identity across reconnect, rotation and revocation', async t => {
  const s = await setup(t); await s.initialized();
  const unknown: ConnectionEnsureResult = { request: s.r, state: 'unknown_effect', authorization: { state: 'unverified' },
    effect: { ...s.r.effect, outcome: 'unknown' }, reconciliationRef: 'reconcile-1' };
  passed(await s.store.reconnect(s.r, 2, unknown));
  denied(await s.store.reconnect(s.r, 3, ready(), binding), 'effect_conflict');
  passed(await s.store.rotate(s.r, 3, { ...credential, credentialRevision: 2 }));
  passed(await s.store.revoke(s.r, 4)); const saved = passed(await s.store.load(s.r));
  assert.equal(saved.result.state, 'unknown_effect');
  if (saved.result.state !== 'unknown_effect') throw Error();
  assert.deepEqual(saved.result.effect, unknown.effect); assert.equal(saved.result.reconciliationRef, 'reconcile-1');
});
acceptance('composed SQL job cancellation and lease fences deny reads and stale verification', async t => {
  const s = await setup(t), { jobs } = journalTables(s.harness.schema);
  const authority = { host: scope, grantRevision: 1, cancellationRevision: 0 };
  const fence = { ...authority, identity: s.r.identity, ownerToken: 'owner-1', epoch: 1, expiresAt: 5000 };
  await s.client.database().insert(jobs).values({ jobId: s.r.identity.jobId, identity: s.r.identity, revision: 1,
    leaseOwner: fence.ownerToken, leaseEpoch: 1, leaseExpiresAt: 5000, leaseGrantRevision: 1, leaseCancellationRevision: 0 });
  s.authorize({ scope, job: { authority, fence, now: s.host.now } });
  await s.initialized(); passed(await s.store.reconnect(s.r, 2, ready(), binding));
  const other = await s.harness.client(); await other.database().update(jobs).set({ cancellationEpoch: 1 }).where(eq(jobs.jobId, s.r.identity.jobId));
  denied(await s.store.load(s.r), 'lease_lost'); denied(await s.store.reconnect(s.r, 2, ready(), binding), 'lease_lost');
});
acceptance('host denials, thrown diagnostics, malformed private metadata and SQL rollback return only fixed failures', async t => {
  const s = await setup(t); await s.initialized();
  const marker = 'synthetic-private-diagnostic';
  const throwing = await s.second({ ...s.host, withAuthority: async () => { throw Error(marker); } });
  denied(await throwing.load(s.r), 'unavailable');
  const malformed = { ...credential, rawError: marker };
  denied(await s.store.rotate(s.r, 2, malformed), 'invalid_payload');
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...credential }, 'tokenRef', { enumerable: true, get: () => { getterCalls++; return marker; } });
  denied(await s.store.rotate(s.r, 2, accessor), 'invalid_payload'); assert.equal(getterCalls, 0);
  await s.client.query(`ALTER TABLE ${s.harness.table('connections')} ADD CONSTRAINT fixture_revision_limit CHECK (revision <= 2)`);
  denied(await s.store.reconnect(s.r, 2, ready(), binding), 'unavailable');
  assert.equal((await s.client.database().select().from(s.tables.receipts)).length, 0);
  assert.equal((await s.client.database().select().from(s.tables.revisions)).length, 2);
  assert.equal(JSON.stringify(await s.client.database().select().from(s.tables.connections)).includes(marker), false);
  s.deny(); denied(await s.store.load(s.r), 'not_authorized');
});
acceptance('migrations rerun, SQL constraints reject duplicates, and owned schema cleanup preserves an unrelated sentinel', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup()); const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (42)`);
  const s = await setup(t); await migrations(t, s.harness, s.client); await s.initialized();
  const [row] = await s.client.database().select().from(s.tables.connections);
  let rejected = false;
  try { await s.client.database().insert(s.tables.connections).values({ ...row, connectionRef: 'duplicate' }); } catch { rejected = true; }
  assert.equal(rejected, true); rejected = false;
  try { await s.client.database().update(s.tables.connections).set({ revision: 0 }); } catch { rejected = true; }
  assert.equal(rejected, true);
  await s.harness.cleanup();
  assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1', [s.harness.schema])).rows[0].n, 0);
  assert.equal((await observer.query(`SELECT value FROM ${sentinel.table('sentinel')}`)).rows[0].value, 42);
  t.diagnostic('All 13 migrations applied and rerun; logical uniqueness and revision constraints enforced; owned schema absent after cleanup; unrelated sentinel intact.');
});
acceptance('fresh verification after local revocation requires a new grant revision and new canonical receipt', async t => {
  const s = await setup(t); await s.initialized(); passed(await s.store.reconnect(s.r, 2, ready(), binding));
  const revoked = passed(await s.store.revoke(s.r, 3)); s.clock(1100);
  assert.deepEqual(passed(await s.store.revoke(s.r, 3)), revoked);
  const next = { ...credential, credentialRevision: 2, grantRevision: 2, tokenRef: 'vault-token-2' };
  const rotated = passed(await s.store.rotate(s.r, 4, next));
  assert.deepEqual(passed(await s.store.rotate(s.r, 4, next)), rotated);
  denied(await s.store.rotate(s.r, 4, { ...next, tokenRef: 'conflicting-token' }), 'conflict');
  denied(await s.store.reconnect(s.r, 5, ready(), { credentialRevision: 2, grantRevision: 2 }), 'receipt_conflict');
  assert.equal(passed(await s.store.reconnect(s.r, 5, ready(s.r, 'receipt-reauthorized'), { credentialRevision: 2, grantRevision: 2 })).result.state, 'ready');
});
acceptance('mutable caller input is detached before authority waits; expiry is checked after a SQL lock wait', async t => {
  const s = await setup(t); await s.initialized();
  const entered = latch(), release = latch();
  const delayed = await s.second({ ...s.host, withAuthority: async (r, op, run) => {
    entered.release(); await release.promise; return s.host.withAuthority(r, op, run);
  } });
  const result = ready();
  const pending = delayed.reconnect(s.r, 2, result, binding); await entered.promise;
  (result as { state: string }).state = 'configuring'; release.release();
  assert.equal(passed(await pending).result.state, 'ready');
  passed(await s.store.reconnect(s.r, 3, intermediate()));
  const locked = latch(), unlock = latch(), attempted = latch();
  const holder = await s.harness.client();
  const holding = holder.database().transaction(async tx => {
    await tx.select().from(s.tables.connections).for('update'); locked.release(); await unlock.promise;
  });
  await locked.promise;
  const verifier = await s.second({ ...s.host, withAuthority: async (r, op, run) => {
    attempted.release(); return s.host.withAuthority(r, op, run);
  } });
  const verification = verifier.reconnect(s.r, 4, ready(s.r, 'receipt-expiring'), binding);
  await attempted.promise; s.clock(2000); unlock.release(); await holding;
  denied(await verification, 'not_current');
  assert.equal((await s.client.database().select().from(s.tables.receipts)).length, 1);
});
