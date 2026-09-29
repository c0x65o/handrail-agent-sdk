import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { identity, request, services, start, ok } from './helpers/effect-fixture.mjs';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
const unknown = { outcome: 'unknown' };
const absent = { outcome: 'not_applied', evidenceRef: 'definitively-not-applied' };
const verified = { outcome: 'verified', receiptRef: 'original-provider-receipt' };
const denied = (r, code) => assert.deepEqual(r, { ok: false, code });
async function setup(t, adapter = { reconcile: async () => absent, dispatch: async () => verified }, options) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  const s = services(client.database(), harness.schema, adapter, options);
  ok(await s.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity, state: 'queued', revision: 1, effects: [] } }));
  const ledger = async () => (await client.query(`SELECT * FROM ${harness.table('job_effects')}`)).rows;
  return { ...s, harness, client, ledger };
}
function child(schema, mode) {
  const proc = fork(new URL('./helpers/effect-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(Error('EFFECT_CHILD_TIMEOUT')); }, 12000);
    proc.once('message', value => { clearTimeout(timer); resolve(value); });
    proc.once('error', () => { clearTimeout(timer); reject(Error('EFFECT_CHILD_FAILED')); });
    proc.once('exit', () => { clearTimeout(timer); reject(Error('EFFECT_CHILD_EXITED_EARLY')); });
  });
  proc.send({ schema, mode }); return { proc, message, exited };
}
test('SIGKILL after provider commit: fresh worker recovers one effect and original receipt on real PostgreSQL', async t => {
  const s = await setup(t);
  await s.client.query(`CREATE TABLE ${s.harness.table('synthetic_provider')} (key text PRIMARY KEY, receipt text NOT NULL)`);
  await s.client.query(`CREATE TABLE ${s.harness.table('synthetic_calls')} (id serial PRIMARY KEY)`);
  const first = child(s.harness.schema, 'crash'); let second;
  t.after(() => { first.proc.kill('SIGKILL'); second?.proc.kill('SIGKILL'); });
  const committed = await first.message; assert.equal(committed.event, 'provider_committed');
  first.proc.kill('SIGKILL'); assert.deepEqual(await first.exited, { code: null, signal: 'SIGKILL' });
  const [uncertain] = await s.ledger();
  assert.deepEqual(uncertain.request, request); assert.deepEqual(uncertain.observation, unknown);
  assert.equal(uncertain.resolved_revision, null); assert.equal(uncertain.authority.epoch, 1);
  const expires = (await s.client.query(`SELECT lease_expires_at FROM ${s.harness.table('jobs')}`)).rows[0].lease_expires_at;
  await new Promise(r => setTimeout(r, Math.max(0, Number(expires) - Date.now() + 20)));
  second = child(s.harness.schema, 'recover'); const recovered = await second.message;
  assert.equal(recovered.event, 'recovered'); assert.deepEqual(recovered.observation, verified);
  assert.notEqual(committed.pid, recovered.pid); assert.deepEqual(await second.exited, { code: 0, signal: null });
  const final = ok(await s.journal.load(identity));
  assert.equal(final.state, 'succeeded'); assert.deepEqual(final.identity, identity);
  assert.equal(final.receipt.receiptRef, verified.receiptRef); assert.equal(final.effects[0].outcome, 'verified');
  assert.equal((await s.ledger()).length, 1);
  assert.equal((await s.client.query(`SELECT count(*) FROM ${s.harness.table('synthetic_calls')}`)).rows[0].count, '1');
  assert.equal((await s.client.query(`SELECT count(*) FROM ${s.harness.table('synthetic_provider')}`)).rows[0].count, '1');
  t.diagnostic(`Fixture only: killed_pid=${committed.pid}; recovery_pid=${recovered.pid}; job=effect-job; effect=original-effect; dispatches=1; provider_effects=1; receipt=original-provider-receipt; lease_epochs=1,2.`);
});
test('conflicting request digests and reused provider idempotency fail without dispatch', async t => {
  let calls = 0;
  const s = await setup(t, { reconcile: async () => absent, dispatch: async () => { calls++; return verified; } });
  const fence = await start(s); assert.deepEqual(ok(await s.effects.execute(request, fence)), verified);
  assert.deepEqual(ok(await s.effects.execute(request, fence)), verified);
  for (const patch of [{ requestDigest: `sha256:${'b'.repeat(64)}` }, { actionRef: 'other-action' },
    { operationRef: 'other-operation' }, { idempotencyRef: 'other-key' }, { providerRef: 'other-provider' }, { effectRef: 'other-effect' }])
    denied(await s.effects.execute({ ...request, ...patch }, fence), 'effect_conflict');
  assert.equal(calls, 1); assert.equal((await s.ledger()).length, 1);
});
test('ambiguous/unavailable reads and secret adapter errors never permit redispatch', async t => {
  let calls = 0, reads = 0;
  const s = await setup(t, { reconcile: async () => { reads++; return reads === 1 ? absent : unknown; },
    dispatch: async () => { calls++; throw Error('synthetic-private-token'); } });
  const fence = await start(s);
  for (let i = 0; i < 3; i++) assert.deepEqual(ok(await s.effects.execute(request, fence)), unknown);
  assert.equal(calls, 1); assert.equal(reads, 3);
  assert.deepEqual((await s.ledger())[0].observation, unknown);
  assert.ok(!JSON.stringify(await s.ledger()).includes('synthetic-private-token'));
});
test('verified not-applied permits same-identity retry under fresh authority', async t => {
  let calls = 0, reads = 0;
  const s = await setup(t, { reconcile: async () => { reads++; return absent; },
    dispatch: async () => { calls++; return calls === 1 ? unknown : verified; } });
  const fence = await start(s);
  assert.deepEqual(ok(await s.effects.execute(request, fence)), unknown);
  assert.deepEqual(ok(await s.effects.execute(request, fence)), verified);
  assert.equal(calls, 2); assert.equal(reads, 2); assert.equal((await s.ledger()).length, 1);
  assert.deepEqual((await s.ledger())[0].request, request);
});
test('Stop permits factual reconciliation while denying new dispatch and preserving terminal journal', async t => {
  let calls = 0, applied = false;
  const s = await setup(t, { reconcile: async () => applied ? verified : absent,
    dispatch: async () => { calls++; applied = true; return unknown; } });
  const fence = await start(s); ok(await s.effects.execute(request, fence));
  const before = ok(await s.journal.load(identity));
  const cancelled = ok(await createJobCancellationStore(s.client.database(), s.tables).cancel({ command: 'cancel', identity,
    expectedRevision: before.revision, reason: 'explicit_stop' }, 'actor', { host: identity.host, grantRevision: 1, cancellationRevision: 0 }));
  assert.deepEqual(ok(await s.effects.reconcile(request)), verified);
  denied(await s.effects.execute(request, fence), 'lease_lost');
  assert.deepEqual(ok(await s.journal.load(identity)), cancelled); assert.equal(calls, 1);
  assert.equal((await s.ledger())[0].observation.receiptRef, verified.receiptRef);
});
test('dispatch reauthorization, changed scope and expired leases fence execution', async t => {
  let calls = 0;
  const s = await setup(t, { reconcile: async () => absent, dispatch: async () => { calls++; return verified; } });
  const fence = await start(s);
  s.state.denyDispatch = true; denied(await s.effects.execute(request, fence), 'not_authorized');
  assert.equal((await s.ledger()).length, 1); // admission committed before dispatch gate
  s.state.denyDispatch = false; s.state.grantRevision++;
  denied(await s.effects.execute(request, fence), 'lease_lost'); s.state.grantRevision--;
  s.state.scope = { ...identity.host, accountRef: 'wrong-account' };
  denied(await s.effects.execute(request, fence), 'not_authorized'); delete s.state.scope;
  s.state.now += 6000; denied(await s.effects.execute(request, fence), 'lease_lost');
  assert.equal(calls, 0);
});
test('timeout and late private results stay unknown; malformed receipts and read errors are suppressed', async t => {
  let finish, calls = 0, reads = 0;
  const s = await setup(t, { reconcile: async () => { if (++reads > 1) throw Error('private-read-error'); return absent; },
    dispatch: async () => { calls++; return new Promise(r => { finish = r; }); } }, { timeoutMs: 20 });
  const fence = await start(s); assert.deepEqual(ok(await s.effects.execute(request, fence)), unknown);
  finish({ ...verified, payload: 'private-payload' });
  assert.deepEqual(ok(await s.effects.execute(request, fence)), unknown);
  assert.equal(calls, 1); assert.deepEqual((await s.ledger())[0].observation, unknown);
});
test('generic journal cannot resolve an effect without the ledger proof', async t => {
  const s = await setup(t, { reconcile: async () => unknown, dispatch: async () => { assert.fail('dispatch'); } });
  const fence = await start(s); ok(await s.effects.execute(request, fence));
  const current = ok(await s.journal.load(identity));
  const forged = { kind: 'effects_recorded', previousRevision: current.revision,
    snapshot: { ...current, revision: current.revision + 1, effects: current.effects.map(e => ({ ...e, outcome: 'verified' })) } };
  denied(await s.lease.append(forged, fence), 'effect_conflict');
  denied(await s.journal.appendEffectResolution(forged, { fence, authority: { host: identity.host, grantRevision: 1, cancellationRevision: 0 }, now: () => s.state.now }), 'effect_conflict');
});
test('concurrent workers serialize read/dispatch and return the same original receipt', async t => {
  let dispatches = 0, reads = 0, entered, release;
  const waiting = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  const adapter = { reconcile: async () => { reads++; return absent; },
    dispatch: async () => { dispatches++; entered(); await hold; return verified; } };
  const s = await setup(t, adapter); const fence = await start(s);
  const other = await s.harness.client();
  const second = services(other.database(), s.harness.schema, adapter, { state: { now: s.state.now } });
  const firstRun = s.effects.execute(request, fence); await waiting;
  const secondRun = second.effects.execute(request, fence);
  release();
  assert.deepEqual((await Promise.all([firstRun, secondRun])).map(ok), [verified, verified]);
  assert.equal(dispatches, 1); assert.equal(reads, 1);
  assert.equal(ok(await s.journal.load(identity)).revision, 4);
});
test('expired lease after read prevents dispatch and unresolved reads never use cached not-applied evidence', async t => {
  let calls = 0, reads = 0, s;
  s = await setup(t, { reconcile: async () => { reads++; s.state.now += 6000; return absent; },
    dispatch: async () => { calls++; return verified; } });
  const fence = await start(s);
  denied(await s.effects.execute(request, fence), 'lease_lost'); assert.equal(calls, 0); assert.equal(reads, 1);
  assert.deepEqual((await s.ledger())[0].observation, unknown);
});
test('provider idempotency key cannot be rebound to a different original job', async t => {
  let calls = 0;
  const adapter = { reconcile: async () => absent, dispatch: async () => { calls++; return verified; } };
  const s = await setup(t, adapter), fence = await start(s);
  ok(await s.effects.execute(request, fence));
  const otherIdentity = { ...identity, jobId: 'different-job', originTaskRef: 'different-task' };
  ok(await s.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity: otherIdentity, state: 'queued', revision: 1, effects: [] } }));
  const secondFence = ok(await s.lease.claim(otherIdentity, 5000));
  ok(await s.lease.append({ kind: 'started', previousRevision: 1,
    snapshot: { identity: otherIdentity, state: 'running', revision: 2, effects: [] } }, secondFence));
  denied(await s.effects.execute({ ...request, identity: otherIdentity }, secondFence), 'effect_conflict');
  assert.equal(calls, 1); assert.deepEqual(ok(await s.journal.load(otherIdentity)).effects, []);
});
