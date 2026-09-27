import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { createJobLease } from '../.reference-build/src/server/job-lease.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { createJobAdmissionStore } from '../.reference-build/reference/node/job-admission.js';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';

const identity = {
  jobId: 'lease-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 7,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root', actionRef: 'original-action', operationRef: 'original-operation', effectRef: 'original-effect', sourceQueue: { queueRef: 'native-queue', messageRef: 'native-message' } },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' },
};
const effect = { actionRef: 'original-action', operationRef: 'original-operation', effectRef: 'original-effect', outcome: 'unknown' };
const clone = v => structuredClone(v);
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
const rejected = (r, code = 'lease_lost') => assert.deepEqual(r, { ok: false, code });
function event(kind, previousRevision, extra = {}, id = identity) {
  const state = { submitted: 'queued', started: 'running', effects_recorded: 'running' }[kind] ?? kind;
  return clone({ kind, previousRevision, snapshot: { identity: id, state, revision: previousRevision + 1, effects: [],
    ...(kind === 'failed' ? { error: { code: 'execution_failed', correlationRef: 'fixture-error' } } : {}),
    ...(kind === 'waiting' ? { requirement: { kind: 'host', requirementRef: 'wait-ref', revision: 1, actor: { kind: 'host', actorRef: 'host' } } } : {}),
    ...(kind === 'succeeded' ? { receipt: { receiptRef: 'verified-receipt', verification: 'host_verified', jobId: id.jobId, revision: previousRevision + 1 } } : {}),
    ...(kind === 'cancelled' ? { cancellation: { reason: 'explicit_stop', actorRef: 'actor' } } : {}), ...extra },
    ...(kind === 'cancelled' ? { command: { command: 'cancel', identity: id, expectedRevision: previousRevision, reason: 'explicit_stop' } } : {}) });
}
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const first = await harness.client(), second = await harness.client(), observer = await harness.client();
  await migrations(t, harness, first);
  const tables = journalTables(harness.schema);
  const state = { now: 1000, grantRevision: 3, cancellationRevision: 0, denied: false, throws: false, scope: clone(identity.host) };
  let token = 0;
  // Fixture policy changes happen between awaited operations. Native adapters
  // must hold their own policy lock through run, including the storage commit.
  const host = { now: () => state.clock ? state.clock() : state.now, newOwnerToken: () => `owner-${++token}`,
    withAuthority: async (_id, _operation, run) => {
      if (state.throws) throw Error('synthetic-private-host-error');
      if (state.denied) return { ok: false, code: 'not_authorized' };
      return run({ host: clone(state.scope), grantRevision: state.grantRevision, cancellationRevision: state.cancellationRevision });
    } };
  const make = db => createJobLease(host, createJobLeaseStore(db, tables));
  const journal = createJobJournal(first.database(), tables);
  const admission = createJobAdmissionStore(first.database(), tables);
  const submission = { namespaceRef: 'fixture', grantRevision: 3,
    operation: { operationRef: 'setup', inputRefs: { provider: 'synthetic' } }, event: event('submitted', 0) };
  ok(await admission.admit(submission));
  const stored = async () => {
    const result = {};
    for (const name of ['jobs', 'job_events', 'job_deliveries', 'job_checkpoints', 'job_admissions']) {
      result[name] = (await observer.query(`SELECT * FROM ${harness.table(name)} ORDER BY 1, 2`)).rows;
    }
    return result;
  };
  return { harness, first, second, observer, tables, journal, admission, submission, state, host, make,
    a: make(first.database()), b: make(second.database()), stored };
}
async function unchanged(stored, run, code = 'lease_lost') {
  const before = await stored(); rejected(await run(), code); assert.deepEqual(await stored(), before);
}
async function blocked(observer, pid) {
  for (let i = 0; i < 150; i++) {
    const row = (await observer.query('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('EXPECTED_DATABASE_LOCK_WAIT');
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('distinct PostgreSQL backends race one admitted job; expiry replaces epoch and fences every old operation', async t => {
  const { first, second, a, b, journal, state, stored, admission, submission } = await setup(t);
  assert.notEqual((await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const initial = await stored();
  const claims = await Promise.all([a.claim(identity, 100), b.claim(identity, 100)]);
  assert.equal(claims.filter(r => ok(r) !== null).length, 1);
  const old = claims.map(ok).find(Boolean);
  ok(await a.append(event('started', 1), old));
  ok(await a.append(event('effects_recorded', 2, { effects: [effect] }), old));
  state.now = old.expiresAt;
  await unchanged(stored, () => a.renew(old, 100)); // exact boundary is expired
  state.now++;
  const replacement = ok(await b.claim(identity, 100));
  assert.equal(replacement.epoch, old.epoch + 1);
  assert.notEqual(replacement.ownerToken, old.ownerToken);
  assert.deepEqual(replacement.identity, old.identity);
  const failed = event('failed', 3, { effects: [effect] });
  for (const run of [() => a.renew(old, 100), () => a.release(old), () => a.check(old),
    () => a.append(failed, old), () => a.complete(failed, old)]) await unchanged(stored, run);
  await unchanged(stored, () => journal.append(failed)); // cannot bypass via bare journal
  assert.deepEqual(ok(await journal.load(identity)).effects, [effect]);
  const renewed = ok(await b.renew(replacement, 250));
  assert.equal(renewed.epoch, replacement.epoch); assert.equal(renewed.expiresAt, state.now + 250);
  assert.deepEqual(ok(await b.check(replacement)), renewed); // old expiry hint is not authority
  const result = ok(await b.complete(failed, renewed));
  assert.deepEqual(result.event.snapshot.identity, identity);
  assert.deepEqual(result.event.snapshot.effects, [effect]);
  const final = await stored();
  assert.equal(final.jobs[0].lease_owner, null);
  assert.equal(final.jobs[0].lease_epoch, String(replacement.epoch));
  assert.deepEqual(final.job_admissions, initial.job_admissions);
  assert.deepEqual(ok(await admission.admit(submission)), { event: submission.event, replayed: true });
  assert.deepEqual(await stored(), final);
  t.diagnostic('Local PostgreSQL fixture: distinct backends, one winner, newer epoch on same job; stale renew/release/check/append/complete rejected without durable changes; original unknown effect and admission preserved.');
});

test('current owner renews, releases and reclaims without resetting epoch, then commits verified success', async t => {
  const { a, b, state, stored } = await setup(t);
  let fence = ok(await a.claim(identity, 100));
  state.now += 20; fence = ok(await a.renew(fence, 200));
  assert.equal(fence.expiresAt, 1220);
  ok(await a.release(fence));
  await unchanged(stored, () => a.release(fence));
  const next = ok(await b.claim(identity, 100));
  assert.equal(next.epoch, fence.epoch + 1);
  ok(await b.append(event('started', 1), next));
  const complete = ok(await b.complete(event('succeeded', 2), next));
  assert.equal(complete.event.snapshot.state, 'succeeded');
  assert.equal(ok(await a.claim(identity, 100)), null);
});

test('wrong owner, epoch, original binding, scope and changed grant/cancellation authority fail closed', async t => {
  const { a, state, stored } = await setup(t);
  const fence = ok(await a.claim(identity, 100));
  for (const changed of [{ ...fence, ownerToken: 'wrong-owner' }, { ...fence, epoch: fence.epoch + 1 }]) {
    for (const run of [() => a.renew(changed, 100), () => a.release(changed), () => a.check(changed),
      () => a.append(event('started', 1), changed), () => a.complete(event('failed', 1), changed)]) await unchanged(stored, run);
  }
  for (const key of Object.keys(identity.host)) {
    state.scope[key] = 'wrong-scope';
    await unchanged(stored, () => a.check(fence), 'not_authorized');
    await unchanged(stored, () => a.claim(identity, 100), 'not_authorized');
    state.scope[key] = identity.host[key];
  }
  const wrong = clone(fence); wrong.identity.requestKey = 'different-request';
  await unchanged(stored, () => a.check(wrong));
  for (const key of ['grantRevision', 'cancellationRevision']) {
    state[key]++;
    for (const run of [() => a.renew(fence, 100), () => a.release(fence), () => a.check(fence),
      () => a.append(event('started', 1), fence), () => a.complete(event('failed', 1), fence)]) await unchanged(stored, run);
    state[key]--;
  }
  state.denied = true;
  await unchanged(stored, () => a.claim(identity, 100), 'not_authorized');
  await unchanged(stored, () => a.check(fence), 'not_authorized');
  state.denied = false; state.throws = true;
  await unchanged(stored, () => a.check(fence), 'not_authorized');
  state.throws = false;
  state.now = fence.expiresAt + 1; state.grantRevision++; state.cancellationRevision++;
  const next = ok(await a.claim(identity, 100));
  assert.equal(next.grantRevision, state.grantRevision); assert.equal(next.cancellationRevision, state.cancellationRevision);
  ok(await a.check(next));
});

test('waiting and every terminal state are ineligible even after lease expiry', async t => {
  const { a, state, journal, stored } = await setup(t);
  for (const kind of ['waiting', 'failed', 'succeeded', 'cancelled']) {
    const id = { ...clone(identity), jobId: `job-${kind}`, requestKey: `request-${kind}` };
    ok(await journal.append(event('submitted', 0, {}, id)));
    const fence = ok(await a.claim(id, 100));
    ok(await a.append(event('started', 1, {}, id), fence));
    ok(await a.append(event(kind, 2, {}, id), fence));
    await unchanged(stored, () => a.check(fence));
    state.now += 101;
    const before = await stored();
    assert.equal(ok(await a.claim(id, 100)), null); assert.deepEqual(await stored(), before);
  }
});

test('stale append waits behind replacement transaction and cannot commit with a current journal revision', async t => {
  const { a, b, first, second, observer, make, state, stored } = await setup(t);
  const old = ok(await a.claim(identity, 100));
  state.now = old.expiresAt + 1;
  const locked = gate(), commit = gate();
  let replacement;
  const replacing = first.database().transaction(async tx => {
    replacement = ok(await make(tx).claim(identity, 100));
    locked.resolve(); await commit.promise;
  });
  await locked.promise;
  const before = await stored(); // observer still sees the old owner until commit
  const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const pending = b.append(event('started', 1), old);
  try { await blocked(observer, pid); }
  finally { commit.resolve(); }
  await replacing; rejected(await pending);
  const after = await stored();
  assert.deepEqual(after.job_events, before.job_events);
  assert.deepEqual(after.job_checkpoints, before.job_checkpoints);
  assert.deepEqual(after.job_deliveries, before.job_deliveries);
  assert.equal(after.jobs[0].revision, before.jobs[0].revision);
  assert.equal(after.jobs[0].lease_epoch, String(replacement.epoch));
  ok(await b.append(event('started', 1), replacement));
  t.diagnostic('Local PostgreSQL fixture: pg_stat_activity confirmed stale writer waiting on a database Lock; replacement committed first, old epoch rejected at still-current journal revision 1.');
});

test('clock sampled after lock wait rejects expired write; expiry during append rolls back all journal changes', async t => {
  const { a, b, first, second, observer, harness, state, stored } = await setup(t);
  const fence = ok(await a.claim(identity, 100));
  const locked = gate(), unlock = gate();
  const holding = first.transaction(async tx => {
    await tx.query(`SELECT * FROM ${harness.table('jobs')} FOR UPDATE`);
    locked.resolve(); await unlock.promise;
  });
  await locked.promise;
  const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const before = await stored();
  const pending = b.append(event('started', 1), fence);
  try { await blocked(observer, pid); state.now = fence.expiresAt; }
  finally { unlock.resolve(); }
  await holding; rejected(await pending); assert.deepEqual(await stored(), before);
  state.now++;
  const next = ok(await b.claim(identity, 100));
  let calls = 0;
  state.clock = () => ++calls === 1 ? state.now : next.expiresAt;
  await unchanged(stored, () => b.append({ ...event('started', 1), delivery: { attemptRef: 'rolled-back-attempt' } }, next));
  assert.equal(calls, 2); delete state.clock;
});

test('completion failure rolls back ownership, event, delivery and checkpoint together; invalid inputs are sanitized', async t => {
  const { a, first, harness, stored, state } = await setup(t);
  const fence = ok(await a.claim(identity, 100));
  ok(await a.append(event('started', 1), fence));
  await first.query(`ALTER TABLE ${harness.table('jobs')} ADD CONSTRAINT keep_fixture_owner CHECK (lease_owner IS NOT NULL)`);
  await unchanged(stored, () => a.complete({ ...event('succeeded', 2), delivery: { attemptRef: 'completion-attempt' } }, fence), 'unavailable');
  await first.query(`ALTER TABLE ${harness.table('jobs')} DROP CONSTRAINT keep_fixture_owner`);
  for (const bad of [{ ...fence, extra: 'unsupported' }, { ...fence, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...fence, cancellationRevision: -1 }, { ...fence, ownerToken: 'not a token' }]) {
    await unchanged(stored, () => a.check(bad), 'invalid_payload');
  }
  const accessor = clone(fence); Object.defineProperty(accessor, 'ownerToken', { enumerable: true, get() { throw Error('synthetic-private'); } });
  await unchanged(stored, () => a.check(accessor), 'invalid_payload');
  await unchanged(stored, () => a.renew(fence, 0), 'invalid_payload');
  state.clock = () => NaN; await unchanged(stored, () => a.check(fence), 'unavailable'); delete state.clock;
  ok(await a.complete(event('succeeded', 2), fence));
});

test('fenced journal retries retain canonical and checkpoint behavior; bare runtime writes fail before any lease exists', async t => {
  const { journal, a, b, stored, state } = await setup(t);
  await unchanged(stored, () => journal.append(event('started', 1)));
  const fence = ok(await a.claim(identity, 100));
  const started = event('started', 1);
  ok(await a.append(started, fence));
  assert.equal(ok(await a.append({ ...started, delivery: { attemptRef: 'retry' } }, fence)).replayed, true);
  const changed = event('started', 1, { effects: [effect] });
  await unchanged(stored, () => a.append(changed, fence), 'conflict');
  state.now = fence.expiresAt + 1;
  const next = ok(await b.claim(identity, 100));
  await unchanged(stored, () => a.append({ ...started, delivery: { attemptRef: 'stale-retry' } }, fence));
  assert.equal(ok(await b.append(started, next)).replayed, true);
  assert.deepEqual(ok(await journal.load(identity)), started.snapshot);
});

test('unsafe clocks and exhausted epochs fail without mutation; database rejects malformed lease storage', async t => {
  const { a, first, harness, state, stored } = await setup(t);
  for (const assignment of ['lease_epoch=-1', 'lease_epoch=9007199254740992', "lease_owner='orphan-owner'", 'lease_expires_at=100']) {
    const before = await stored();
    await assert.rejects(first.query(`UPDATE ${harness.table('jobs')} SET ${assignment}`), { message: 'POSTGRES_QUERY_FAILED' });
    assert.deepEqual(await stored(), before);
  }
  state.now = Number.MAX_SAFE_INTEGER;
  await unchanged(stored, () => a.claim(identity, 1), 'unavailable');
  state.now = 1000;
  await first.query(`UPDATE ${harness.table('jobs')} SET lease_epoch=9007199254740991`);
  await unchanged(stored, () => a.claim(identity, 100));
});
