import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretKey, randomBytes } from 'node:crypto';
import { createVaultUse, createJobLease } from 'handrail-agent-sdk/server';
import { createMetaOAuthCallback } from 'handrail-agent-sdk/server/marketing';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { fixture, binding, clone, identity } from './helpers/marketing-fixture.mjs';
import { createVaultStore } from '../.reference-build/reference/node/vault-store.js';
import { createVaultGrants } from '../.reference-build/reference/node/vault-grants.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { createConnectionStore } from '../.reference-build/reference/node/connection-store.js';
import { journalTables, vaultTables } from '../.reference-build/reference/node/db/schema.js';
import { entryState, entryServices, identity as entryIdentity, requirement } from './helpers/vault-entry-fixture.mjs';
import { services, start } from './helpers/effect-fixture.mjs';

// Raw private assertion values and driver exceptions must not enter TAP.
class Diagnostic extends Error {}
const ok = r => { if (!r.ok) throw new Diagnostic(`EXPECTED_SUCCESS_${r.code}`); return r.value; };
function acceptance(name, run) {
  test(name, { timeout: 30_000 }, async t => { try { await run(t); } catch (e) {
    throw Error(e instanceof Diagnostic ? e.message : 'MARKETING_POSTGRES_ACCEPTANCE_FAILED');
  } });
}
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const db = await harness.client(); await migrations(t, harness, db);
  const f = fixture(), tables = journalTables(harness.schema), journal = createJobJournal(db.database(), tables);
  const authority = { host: identity.host, grantRevision: 1, cancellationRevision: 0 };
  const host = { now: f.host.now, newOwnerToken: () => 'marketing-worker', withAuthority: async (_r, _p, run) =>
    f.state.current ? run({ ...authority, actorRef: 'actor' }) : { ok: false, code: 'not_authorized' } };
  ok(await journal.append({ kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } }));
  const lease = createJobLease({ ...host, withAuthority: async (_r, _p, run) => run(authority) }, createJobLeaseStore(db.database(), tables));
  const fence = ok(await lease.claim(identity, 60_000));
  f.host.isCurrent = () => f.state.current && f.state.now < fence.expiresAt;
  ok(await lease.append({ kind: 'started', previousRevision: 1, snapshot: { identity, revision: 2, state: 'running', effects: [] } }, fence));
  const key = createSecretKey(randomBytes(32)), keys = { active: async () => ({ keyHandle: 'fixture-key', keyVersion: 1 }), resolve: async () => key };
  const storage = { authorize: async () => identity.host };
  ok(await createVaultStore(db.database(), storage, keys, vaultTables(harness.schema)).create(f.b.request.item, { token: f.privateCode }));
  const owner = { now: f.host.now, withOwner: async (_i, _p, run) => run(identity.host) };
  const grants = createVaultGrants(db.database(), owner, keys, harness.schema);
  const grant = { request: f.b.request, state: 'active', permissions: { use: true, reveal: false, export: false }, issuedAt: 1000,
    expiresAt: 100_000, itemExpiresAt: 200_000, taskExpiresAt: 200_000 };
  ok(await grants.administration.put(grant, 0));
  const use = () => createVaultUse(host, grants.use, [f.executor()], 2000);
  const scan = async (...outputs) => {
    const rows = [];
    for (const table of ['jobs', 'job_events', 'job_effects', 'vault_items', 'vault_access', 'vault_item_grants'])
      rows.push((await db.query(`SELECT * FROM ${harness.table(table)}`)).rows);
    const serialized = JSON.stringify([rows, outputs]);
    assert.equal(serialized.includes(f.privateCode) || serialized.includes(f.privateToken), false);
  };
  return { ...f, db, harness, host, journal, lease, fence, grants, grant, use, scan, keys, owner };
}
acceptance('Meta executor composes with encrypted Vault custody and durable effect receipts', async t => {
  const s = await setup(t);
  const first = ok(await s.use().execute(s.b.request, s.fence)); assert.equal(first.outcome, 'verified');
  const replay = ok(await s.use().execute(s.b.request, s.fence)); assert.deepEqual(replay, first);
  assert.equal(s.state.calls.filter(c => c === 'exchange').length, 1);
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome, 'verified');
  await s.scan(first, replay);
});
acceptance('unknown exchange survives fresh SQL connection and cannot dispatch again', async t => {
  const s = await setup(t);
  s.client.exchangeCode = async () => { s.state.calls.push('exchange'); throw Error(s.privateToken); };
  assert.equal(ok(await s.use().execute(s.b.request, s.fence)).outcome, 'unknown');
  const other = await s.harness.client();
  const grants = createVaultGrants(other.database(), s.owner, s.keys, s.harness.schema);
  // The native private-custody boundary reports its committed attempt, never
  // infers not_applied from absence of a retained token. Its durability is a host gate.
  const reconnect = createVaultUse(s.host, grants.use, [s.executor()], 2000);
  assert.equal(ok(await reconnect.reconcile(s.b.request)).outcome, 'unknown');
  assert.equal(ok(await reconnect.execute(s.b.request, s.fence)).outcome, 'unknown');
  assert.equal(s.state.calls.length, 1);
  const snapshot = ok(await s.journal.load(identity));
  assert.deepEqual(snapshot.effects, [{ ...s.b.request.effect, outcome: 'unknown' }]);
  await s.scan(snapshot);
});
for (const scenario of ['denied', 'expired', 'revoked', 'wrong-project', 'wrong-environment', 'wrong-account', 'lease-lost']) {
  acceptance(`durable Vault admission rejects ${scenario} without private dispatch`, async t => {
    const s = await setup(t), request = clone(s.b.request), fence = clone(s.fence);
    if (scenario === 'denied') s.state.current = false;
    if (scenario === 'expired') s.state.now = s.grant.expiresAt;
    if (scenario === 'revoked') ok(await s.grants.administration.revoke(request.item, request.grantRef, 1));
    if (scenario.startsWith('wrong-')) request.identity.host[`${scenario.slice(6)}Ref`] = 'other';
    if (scenario === 'lease-lost') fence.epoch++;
    assert.equal((await s.use().execute(request, fence)).ok, false);
    assert.deepEqual(s.state.calls, []); await s.scan();
  });
}
acceptance('lease expiry during exchange keeps durable unknown and withholds verification', async t => {
  const s = await setup(t);
  s.state.hook = async phase => { if (phase === 'exchange') s.state.now = s.fence.expiresAt; };
  const result = await s.use().execute(s.b.request, s.fence);
  assert.equal(result.ok, false); assert.equal(s.state.retained, false);
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome, 'unknown');
  assert.equal(ok(await s.use().reconcile(s.b.request)).outcome, 'unknown');
  await s.scan(result);
});
acceptance('cancellation during exchange preserves unknown and no late custody publication', async t => {
  const s = await setup(t);
  // Native host withdraws authority during private IO. Executor guard catches it;
  // real journal cancellation/lease semantics are also covered by test:cancel.
  s.state.hook = async phase => { if (phase === 'exchange') s.state.current = false; };
  const original = s.custody.retain;
  s.custody.retain = (...args) => s.state.current ? original(...args) : Promise.resolve(false);
  const result = await s.use().execute(s.b.request, s.fence);
  assert.equal(s.state.retained, false);
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome, 'unknown'); await s.scan(result);
});
acceptance('original unknown connection survives SQL reconnect and local revoke', async t => {
  const s = await setup(t), r = s.b.recipe.connection;
  const host = { now: s.host.now, withAuthority: async (_r, _op, run) => run({ scope: identity.host }) };
  const store = createConnectionStore(s.db.database(), host, s.harness.schema);
  ok(await store.admit(r));
  const unknown = { request: r, state: 'unknown_effect', authorization: { state: 'unverified' },
    effect: { ...r.effect, outcome: 'unknown' }, reconciliationRef: 'original-exchange' };
  ok(await store.reconnect(r, 1, unknown));
  const other = await s.harness.client(), fresh = createConnectionStore(other.database(), host, s.harness.schema);
  assert.deepEqual(ok(await fresh.load(r)).result, unknown);
  assert.equal((await fresh.reconnect(r, 2, { request: r, state: 'requested', authorization: { state: 'unverified' } })).ok, false);
  const revoked = ok(await fresh.revoke(r, 2));
  assert.equal(revoked.result.state, 'unknown_effect'); assert.deepEqual(revoked.result.effect, unknown.effect);
  assert.equal(revoked.result.reconciliationRef, 'original-exchange'); assert.equal(revoked.locallyRevoked, true);
});
acceptance('OAuth identical duplicates use one encrypted capture and answer; conflicting code is denied', async t => {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const db = await harness.client(); await migrations(t, harness, db);
  const s = services(db.database(), harness.schema, {}, { state: { now: 1000 } });
  ok(await s.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity: entryIdentity, state: 'queued', revision: 1, effects: [] } }));
  const fence = await start(s, 60_000);
  ok(await s.lease.append({ kind: 'waiting', previousRevision: 2,
    snapshot: { identity: entryIdentity, state: 'waiting', revision: 3, requirement, effects: [] } }, fence));
  const state = entryState(), api = entryServices(db.database(), harness.schema, state);
  state.request.origin = 'https://host.invalid';
  const handle = ok(await api.entry.issue(state.request)), b = binding();
  b.recipe.connection.identity = clone(entryIdentity); b.recipe.connection.effect = clone(state.request.effect);
  const session = { recipe: b.recipe, entry: handle, state: 's'.repeat(32), expiresAt: 2000, actorRef: 'actor', entryRequest: state.request };
  const callbackHost = { now: () => state.now, isCurrent: () => true, withSession: async run => run(session) };
  const callback = createMetaOAuthCallback(callbackHost, api.entry);
  const code = randomBytes(32).toString('hex'), params = { state: session.state, code };
  assert.equal(await callback(b.recipe.redirectUri, params), 'captured');
  const other = await harness.client(), restarted = entryServices(other.database(), harness.schema, state, api.keys);
  assert.equal(await createMetaOAuthCallback(callbackHost, restarted.entry)(b.recipe.redirectUri, params), 'captured');
  assert.equal(await callback(b.recipe.redirectUri, { ...params, code: 'DIFFERENT_PRIVATE_CODE' }), 'denied');
  const items = (await db.query(`SELECT * FROM ${harness.table('vault_items')}`)).rows;
  const answers = (await db.query(`SELECT * FROM ${harness.table('job_answer_deliveries')}`)).rows;
  assert.equal(items.length, 1); assert.equal(answers.length, 1);
  assert.equal(JSON.stringify([items, answers]).includes(code), false);
});
