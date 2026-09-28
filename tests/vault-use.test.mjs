import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createSecretKey } from 'node:crypto';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { identity, services, start, ok } from './helpers/effect-fixture.mjs';
import { createVaultUse } from '../.reference-build/src/server/vault-use.js';
import { createVaultGrants, vaultEffectRequest } from '../.reference-build/reference/node/vault-grants.js';
import { createVaultStore } from '../.reference-build/reference/node/vault-store.js';
import { createVaultLifecycle } from '../.reference-build/reference/node/vault-lifecycle.js';
import { vaultTables } from '../.reference-build/reference/node/db/schema.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
const clone = v => structuredClone(v);
const denied = r => assert.equal(r.ok, false);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, shared = false) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  const second = await harness.client();
  const s = services(client.database(), harness.schema, {});
  ok(await s.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity, state: 'queued', revision: 1, effects: [] } }));
  const fence = await start(s, 60_000);
  const item = { metadata: { kind: 'token', tokenType: 'api' }, reference: { kind: 'secret', itemRef: 'private-item', revision: 1 } };
  const request = { identity, jobRevision: 2, grantRef: 'item-grant', grantRevision: 1,
    effect: { effectRef: 'vault-effect', actionRef: 'setup-action', operationRef: 'trusted-token-operation' },
    operation: 'server_request', item, destination: { endpoint: 'https://fixture.invalid/setup', method: 'POST', resourceRef: 'approved-resource', redirects: 'deny' } };
  const scope = { ...identity.host, userRef: shared ? 'item-owner' : identity.host.userRef };
  const state = { actorRef: identity.host.userRef, ownerAllowed: true, hostDenied: false, calls: 0, privateReads: 0,
    reads: 0, resolveHook: undefined, dispatchHook: undefined, reconcileHook: undefined, beforePhase: undefined };
  const privateValue = randomBytes(24).toString('hex');
  const key = createSecretKey(randomBytes(32));
  const keys = { active: async () => ({ keyHandle: 'ephemeral-fixture', keyVersion: 1 }), resolve: async () => {
    state.privateReads++; await state.resolveHook?.(); return key;
  } };
  const storageHost = { authorize: async () => scope };
  const custody = createVaultStore(client.database(), storageHost, keys, vaultTables(harness.schema));
  ok(await custody.create(item, { token: privateValue })); state.privateReads = 0;
  const owner = { now: () => s.state.now, withOwner: async (_item, _action, run) => state.ownerAllowed ? run(scope) : { ok: false, code: 'not_authorized' } };
  const grants = createVaultGrants(client.database(), owner, keys, harness.schema);
  const other = createVaultGrants(second.database(), owner, keys, harness.schema);
  const grant = { request: clone(request), issuedAt: s.state.now, expiresAt: s.state.now + 30_000,
    state: 'active', permissions: { use: true, reveal: false, export: false }, itemExpiresAt: s.state.now + 120_000, taskExpiresAt: s.state.now + 120_000 };
  const host = { now: () => s.state.now, withAuthority: async (r, phase, run) => {
    await state.beforePhase?.(phase);
    if (state.hostDenied) return { ok: false, code: 'not_authorized' };
    return run({ host: s.state.scope ?? identity.host, grantRevision: s.state.grantRevision,
      cancellationRevision: s.state.cancellationRevision, actorRef: state.actorRef });
  } };
  const executor = { operationRef: request.effect.operationRef, bind: r => vaultEffectRequest(r, 'fixture-vault-provider'),
    reconcile: async () => { state.reads++; return state.reconcileHook ? state.reconcileHook() : 'not_applied'; },
    dispatch: async (_r, value, signal) => {
      state.calls++; assert.equal(value.token === privateValue, true, 'private custody delivered only to registered executor');
      return state.dispatchHook ? state.dispatchHook(signal) : 'verified';
    } };
  const use = createVaultUse(host, grants.use, [executor], 2000);
  const ledger = async () => (await client.query(`SELECT * FROM ${harness.table('job_effects')}`)).rows;
  const history = () => grants.administration.history(item);
  const scan = async (...outputs) => {
    const records = (await client.query(`SELECT * FROM ${harness.table('vault_access')}`)).rows;
    const durable = { records, effects: await ledger(), grants: (await client.query(`SELECT * FROM ${harness.table('vault_item_grants')}`)).rows,
      events: (await client.query(`SELECT * FROM ${harness.table('job_events')}`)).rows };
    assert.equal(JSON.stringify([durable, outputs]).includes(privateValue), false, 'no synthetic value in public/durable outputs');
  };
  return { ...s, state, harness, client, second, fence, item, request, grant, grants, other, use, executor, host, owner, keys, scope,
    privateValue, ledger, history, scan, lifecycle: createVaultLifecycle(second.database(), storageHost, keys, vaultTables(harness.schema)) };
}

test('table: personal/shared item authorization requires exact actor, item, scope, purpose, action and destination', async t => {
  const cases = [
    ['personal owner explicit grant', false, () => {}, true],
    ['shared recipient explicit item grant', true, () => {}, true],
    ['personal ownership alone is insufficient', false, s => { s.noGrant = true; }],
    ['organization/project sharing alone is insufficient', true, s => { s.noGrant = true; }],
    ['wrong authenticated actor', false, s => { s.state.actorRef = 'other'; }],
    ...['tenantRef', 'userRef', 'projectRef', 'accountRef', 'environmentRef', 'purposeRef'].map(k =>
      [`wrong ${k}`, false, s => { s.request.identity.host[k] = 'other'; }]),
    ['wrong action', false, s => { s.request.effect.actionRef = 'other'; }],
    ['unregistered executor', false, s => { s.request.effect.operationRef = 'arbitrary-callback'; }],
    ['wrong destination', false, s => { s.request.destination.endpoint = 'https://attacker.invalid/steal'; }],
    ['wrong method', false, s => { s.request.destination.method = 'DELETE'; }],
    ['wrong item version', false, s => { s.request.item.reference.revision = 2; }],
    ['wrong grant revision', false, s => { s.request.grantRevision = 2; }],
    ['expiry', false, s => { s.stateTime = 60_000; }],
    ['job scope revision changed', false, s => { s.jobGrantChange = true; }],
    ['native authority denied', false, s => { s.state.hostDenied = true; }],
    ['reveal unsupported', false, s => { s.request.operation = 'reveal'; }],
    ['export unsupported', false, s => { s.request.operation = 'export'; }],
    ['arbitrary callback input rejected', false, s => { s.request.callback = () => {}; }],
  ];
  for (const [name, shared, change, allowed = false] of cases) await t.test(name, async t => {
    const s = await setup(t, shared); s.request = clone(s.request); change(s);
    if (!s.noGrant) ok(await s.grants.administration.put(s.grant, 0));
    if (s.stateTime) s.host.now = () => s.grant.expiresAt; // host clock authoritative at final dispatch too
    if (s.jobGrantChange) s.host.withAuthority = async (_r, _p, run) => run({ host: identity.host, actorRef: identity.host.userRef, grantRevision: 2, cancellationRevision: 0 });
    const result = await s.use.execute(s.request, s.fence);
    assert.equal(result.ok, allowed);
    assert.equal(s.state.calls, allowed ? 1 : 0); assert.equal(s.state.privateReads, allowed ? 1 : 0);
    if (allowed) {
      assert.deepEqual(result.value, { outcome: 'verified', receiptRef: 'vault-effect' });
      assert.deepEqual(ok(await s.use.execute(s.request, s.fence)), result.value); assert.equal(s.state.calls, 1);
    }
    if (name === 'expiry') assert.ok(ok(await s.history()).some(r => r.outcome === 'expired'));
    await s.scan(result, await s.history());
  });
});

test('owner grant CAS, atomic revoke fence, restart persistence and bounded authorized history', async t => {
  const s = await setup(t, true);
  s.state.ownerAllowed = false;
  denied(await s.grants.administration.put(s.grant, 0)); denied(await s.history());
  s.state.ownerAllowed = true;
  ok(await s.grants.administration.put(s.grant, 0));
  const results = await Promise.all([s.grants.administration.revoke(s.item, 'item-grant', 1), s.other.administration.revoke(s.item, 'item-grant', 1)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => r.ok).value.revision, 2);
  assert.equal(results.find(r => !r.ok).code, 'conflict');
  denied(await s.use.execute(s.request, s.fence)); assert.equal(s.state.calls, 0);
  const reopened = createVaultGrants(s.second.database(), s.owner, s.keys, s.harness.schema);
  const history = ok(await reopened.administration.history(s.item, 100));
  assert.ok(history.some(r => r.outcome === 'revoked'));
  assert.deepEqual(Object.keys(history[0]).sort(), ['at', 'outcome', 'phase', 'receiptRef']);
  assert.equal(ok(await reopened.administration.history(s.item, 1)).length, 1);
  denied(await reopened.administration.history(s.item, 101));
  s.state.ownerAllowed = false; denied(await reopened.administration.history(s.item));
  await s.scan(history);
});

for (const change of ['revoke', 'narrow']) test(`real PostgreSQL race: ${change} commits between admission and dispatch and prevents private use`, async t => {
  const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
  const paused = gate(), resume = gate();
  s.state.beforePhase = async phase => { if (phase === 'dispatch') { paused.resolve(); await resume.promise; } };
  const execution = s.use.execute(s.request, s.fence);
  await paused.promise;
  assert.equal((await s.ledger())[0].observation.outcome, 'unknown');
  if (change === 'revoke') ok(await s.other.administration.revoke(s.item, 'item-grant', 1));
  else { const narrower = clone(s.grant); narrower.request.grantRevision = 2; narrower.request.destination.method = 'GET'; ok(await s.other.administration.put(narrower, 1)); }
  resume.resolve(); denied(await execution);
  assert.equal(s.state.calls, 0); assert.equal(s.state.privateReads, 0);
  assert.equal((await s.ledger())[0].observation.outcome, 'unknown');
  assert.ok(ok(await s.history()).some(r => r.outcome === (change === 'revoke' ? 'revoked' : 'stale_grant')));
  await s.scan(await execution);
  t.diagnostic(`Fixture-only SQL race: mutation=${change}; grant_revision=2; private_reads=0; dispatches=0; durable_effect=unknown; receipt=vault-effect.`);
});

test('revoke waits for an already dispatched operation; after commit no later use starts', async t => {
  const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
  const entered = gate(), release = gate();
  s.state.dispatchHook = async () => { entered.resolve(); await release.promise; return 'verified'; };
  const execution = s.use.execute(s.request, s.fence); await entered.promise;
  let revoked = false;
  const revocation = s.other.administration.revoke(s.item, 'item-grant', 1).then(r => { revoked = true; return r; });
  // Observe the actual PostgreSQL lock wait, not a timer-based race assumption.
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const rows = await s.client.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows.rows.length) { waiting = true; break; }
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(waiting, true); assert.equal(revoked, false);
  release.resolve(); ok(await execution); ok(await revocation);
  denied(await s.use.execute(s.request, s.fence)); assert.equal(s.state.calls, 1);
});

test('malicious executor exceptions and fabricated receipts are withheld; unknown effects reconcile after revoke', async t => {
  const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
  s.state.dispatchHook = async () => { throw Error(s.privateValue); };
  const first = ok(await s.use.execute(s.request, s.fence)); assert.deepEqual(first, { outcome: 'unknown' });
  s.state.reconcileHook = async () => { throw Error(s.privateValue); };
  assert.deepEqual(ok(await s.use.execute(s.request, s.fence)), first); assert.equal(s.state.calls, 1);
  ok(await s.other.administration.revoke(s.item, 'item-grant', 1));
  s.state.reconcileHook = async () => ({ outcome: 'verified', receiptRef: s.privateValue });
  assert.deepEqual(ok(await s.use.reconcile(s.request)), first);
  s.state.reconcileHook = async () => 'verified';
  const recovered = ok(await s.use.reconcile(s.request)); assert.deepEqual(recovered, { outcome: 'verified', receiptRef: 'vault-effect' });
  assert.equal(s.state.calls, 1); assert.equal(s.state.privateReads, 1);
  await s.scan(first, recovered, await s.history());
});

test('expiry after reconciliation and during private key resolution prevents actual dispatch', async t => {
  for (const point of ['reconcile', 'custody']) await t.test(point, async t => {
    const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
    const expire = () => { s.host.now = () => s.grant.expiresAt; };
    if (point === 'reconcile') s.state.reconcileHook = async () => { expire(); return 'not_applied'; };
    else s.state.resolveHook = async () => { expire(); };
    const result = await s.use.execute(s.request, s.fence);
    assert.equal(s.state.calls, 0); assert.equal((await s.ledger())[0].observation.outcome, 'unknown');
    await s.scan(result);
  });
});

test('cancellation, stale lease and lifecycle revoke all prevent use', async t => {
  for (const point of ['stop', 'lease', 'lifecycle']) await t.test(point, async t => {
    const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
    if (point === 'stop') ok(await createJobCancellationStore(s.second.database(), s.tables).cancel({ command: 'cancel', identity, expectedRevision: 2, reason: 'explicit_stop' }, identity.host.userRef,
      { host: identity.host, grantRevision: 1, cancellationRevision: 0 }));
    if (point === 'lease') s.fence.epoch++;
    if (point === 'lifecycle') ok(await s.lifecycle.terminate(s.item, 'revoked'));
    denied(await s.use.execute(s.request, s.fence)); assert.equal(s.state.calls, 0); assert.equal(s.state.privateReads, 0);
  });
});

test('timeout during custody cannot dispatch later and retains unknown for reconciliation', async t => {
  const s = await setup(t); ok(await s.grants.administration.put(s.grant, 0));
  const release = gate(); s.state.resolveHook = () => release.promise;
  const use = createVaultUse(s.host, s.grants.use, [s.executor], 30);
  const result = ok(await use.execute(s.request, s.fence)); assert.deepEqual(result, { outcome: 'unknown' });
  release.resolve(); await new Promise(r => setTimeout(r, 30));
  assert.equal(s.state.calls, 0); assert.equal((await s.ledger())[0].observation.outcome, 'unknown');
  await s.scan(result);
});

test('browser origin/frame binding uses exact grant destination, before any private resolution', async t => {
  for (const field of ['origin', 'frame']) await t.test(field, async t => {
    const s = await setup(t);
    s.request.operation = 'capture';
    s.request.destination = { origin: 'https://fixture.invalid', profileRef: 'profile', leaseEpoch: 1,
      documentRef: 'document', navigationRevision: 1, frames: [{ frameRef: 'top', origin: 'https://fixture.invalid' }],
      fieldRef: 'token-field', fieldKind: 'token', formEndpoint: 'https://fixture.invalid/setup' };
    s.grant.request = clone(s.request); ok(await s.grants.administration.put(s.grant, 0));
    if (field === 'origin') { s.request.destination.origin = 'https://attacker.invalid'; s.request.destination.frames[0].origin = 'https://attacker.invalid'; }
    else s.request.destination.frames.push({ frameRef: 'cross-frame', origin: 'https://attacker.invalid' });
    denied(await s.use.execute(s.request, s.fence)); assert.equal(s.state.calls, 0); assert.equal(s.state.privateReads, 0);
  });
});

test('human reveal/export permissions never confer use and a payload disguised as receipt stays unknown', async t => {
  const s = await setup(t);
  s.grant.permissions = { use: false, reveal: true, export: true };
  denied(await s.grants.administration.put(s.grant, 0));
  s.grant.permissions.use = true; ok(await s.grants.administration.put(s.grant, 0));
  s.state.dispatchHook = async () => ({ outcome: 'verified', receiptRef: s.privateValue });
  const result = ok(await s.use.execute(s.request, s.fence)); assert.deepEqual(result, { outcome: 'unknown' });
  await s.scan(result, await s.history());
});
