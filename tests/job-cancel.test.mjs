import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { createJobLease } from '../.reference-build/src/server/job-lease.js';
import { createJobCancellation } from '../.reference-build/src/server/cancel.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { createJobAdmissionStore } from '../.reference-build/reference/node/job-admission.js';
import { createReferenceWorker } from '../.reference-build/reference/node/worker.js';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';

const identity = {
  jobId: 'cancel-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' },
};
const effect = { actionRef: 'action', operationRef: 'operation', effectRef: 'effect', outcome: 'unknown' };
const ok = result => { assert.equal(result.ok, true, result.code); return result.value; };
const denied = (result, code) => assert.deepEqual(result, { ok: false, code });
const stop = { command: 'cancel', identity, expectedRevision: 2, reason: 'explicit_stop' };
function event(kind, current, effects = current.effects) {
  return { kind, previousRevision: current.revision, snapshot: {
    identity, revision: current.revision + 1, state: kind === 'started' || kind === 'effects_recorded' ? 'running' : kind,
    effects,
  } };
}
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const [first, second, third, observer, locker] = await Promise.all(Array.from({ length: 5 }, () => harness.client()));
  await migrations(t, harness, first);
  const tables = journalTables(harness.schema);
  const state = { now: 1_000, grantRevision: 1, cancellationRevision: 0, revoked: false,
    expired: false, held: false, scope: structuredClone(identity.host) };
  const authority = () => ({ host: structuredClone(state.scope), grantRevision: state.grantRevision,
    cancellationRevision: state.cancellationRevision });
  let token = 0;
  const host = { now: () => state.now, newOwnerToken: () => `owner-${++token}`,
    withAuthority: async (_identity, _operation, run) => state.revoked || state.expired || state.held
      ? { ok: false, code: 'not_authorized' } : run(authority()),
    withStopAuthority: async (_identity, actorRef, run) => actorRef !== 'actor' || state.held
      ? { ok: false, code: 'not_authorized' } : run(authority()),
    withEvidenceAuthority: async (_identity, actorRef, run) => actorRef !== 'actor' || state.held
      ? { ok: false, code: 'not_authorized' } : run(authority()),
  };
  const admission = createJobAdmissionStore(first.database(), tables);
  ok(await admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'setup', inputRefs: { provider: 'synthetic' } },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, state: 'queued', revision: 1, effects: [] } } }));
  const journal = createJobJournal(observer.database(), tables);
  const lease = client => createJobLease(host, createJobLeaseStore(client.database(), tables));
  const cancel = createJobCancellation(host, createJobCancellationStore(second.database(), tables));
  return { harness, first, second, third, observer, locker, state, journal, admission, lease, cancel };
}
async function lockWait(observer, pid) {
  for (let i = 0; i < 150; i++) {
    const row = (await observer.query('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('EXPECTED_DATABASE_LOCK_WAIT');
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

test('Stop wins row lock before two worker claims; no effect can be admitted after the committed fence', async t => {
  const { harness, second, third, observer, locker, journal, lease, cancel } = await setup(t);
  const firstLease = lease(observer), secondLease = lease(third);
  const old = ok(await firstLease.claim(identity, 100));
  ok(await firstLease.append(event('started', ok(await journal.load(identity))), old));
  const hold = gate(), locked = gate();
  const holding = locker.transaction(async client => {
    await client.query(`SELECT job_id FROM ${harness.table('jobs')} WHERE job_id=$1 FOR UPDATE`, [identity.jobId]);
    locked.release(); await hold.promise;
  });
  await locked.promise;
  const cancelPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const cancelling = cancel.stop(stop, 'actor');
  await lockWait(observer, cancelPid);
  const a = firstLease.claim(identity, 100), b = secondLease.claim(identity, 100);
  hold.release(); await holding;
  const cancelled = ok(await cancelling);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual([ok(await a), ok(await b)], [null, null]);
  const head = (await locker.query(`SELECT cancellation_epoch, lease_epoch, lease_owner FROM ${harness.table('jobs')} WHERE job_id=$1`, [identity.jobId])).rows[0];
  assert.equal(head.cancellation_epoch, '1'); assert.equal(head.lease_epoch, '2'); assert.equal(head.lease_owner, null);
  denied(await firstLease.admitEffect(event('effects_recorded', { ...cancelled, revision: 2, effects: [] }, [effect]), old), 'lease_lost');
  denied(await firstLease.check(old), 'lease_lost');
  assert.deepEqual(ok(await journal.load(identity)), cancelled);
});

test('admitted unknown effect survives Stop; duplicate Stop is stable and stale resume cannot reopen', async t => {
  const { harness, observer, journal, lease, cancel } = await setup(t);
  const worker = lease(observer);
  const fence = ok(await worker.claim(identity, 100));
  const running = ok(await worker.append(event('started', ok(await journal.load(identity))), fence)).event.snapshot;
  const admitted = ok(await worker.admitEffect(event('effects_recorded', running, [effect]), fence));
  assert.equal(admitted.replayed, false);
  assert.equal(ok(await worker.admitEffect(event('effects_recorded', running, [effect]), fence)).replayed, true);
  const current = admitted.event.snapshot;
  const command = { ...stop, expectedRevision: current.revision };
  const cancelled = ok(await cancel.stop(command, 'actor'));
  assert.deepEqual(cancelled.effects, [effect]);
  assert.deepEqual(ok(await cancel.stop(command, 'actor')), cancelled);
  const evidence = { identity, effectRef: effect.effectRef, evidenceRef: 'provider-receipt', outcome: 'verified' };
  ok(await cancel.attachEvidence(evidence, 'actor'));
  ok(await cancel.attachEvidence(evidence, 'actor'));
  denied(await cancel.attachEvidence({ ...evidence, outcome: 'not_applied' }, 'actor'), 'conflict');
  assert.equal((await observer.query(`SELECT count(*) AS count FROM ${harness.table('job_cancellation_evidence')} WHERE job_id=$1`, [identity.jobId])).rows[0].count, '1');
  assert.equal((await observer.query(`SELECT count(*) AS count FROM ${harness.table('job_events')} WHERE job_id=$1 AND event->>'kind'='cancelled'`, [identity.jobId])).rows[0].count, '1');
  denied(await worker.admitEffect(event('effects_recorded', current, [effect]), fence), 'lease_lost');
  denied(await journal.append({ kind: 'resumed', previousRevision: cancelled.revision,
    command: { command: 'resume', identity, expectedRevision: cancelled.revision, requirementRef: 'wait', requirementRevision: 1, resolutionReceiptRef: 'late' },
    snapshot: { identity, revision: cancelled.revision + 1, state: 'queued', effects: [effect] } }), 'lease_lost');
  assert.deepEqual(ok(await journal.load(identity)), cancelled);
});

test('changed, revoked, expired or held authority denies progress at admission', async t => {
  const { first, state, journal, lease, cancel } = await setup(t);
  const worker = lease(first);
  const fence = ok(await worker.claim(identity, 100));
  const running = ok(await worker.append(event('started', ok(await journal.load(identity))), fence)).event.snapshot;
  const proposed = event('effects_recorded', running, [effect]);
  state.grantRevision++;
  denied(await worker.admitEffect(proposed, fence), 'lease_lost');
  state.grantRevision--;
  state.cancellationRevision++;
  denied(await worker.admitEffect(proposed, fence), 'lease_lost');
  state.cancellationRevision--;
  state.scope = { ...identity.host, accountRef: 'wrong-account' };
  denied(await worker.admitEffect(proposed, fence), 'not_authorized');
  state.scope = structuredClone(identity.host);
  for (const flag of ['revoked', 'expired', 'held']) {
    state[flag] = true;
    denied(await worker.admitEffect(proposed, fence), 'not_authorized');
    state[flag] = false;
  }
  denied(await cancel.stop(stop, 'wrong-actor'), 'not_authorized');
  state.held = true;
  denied(await cancel.stop(stop, 'actor'), 'not_authorized');
  state.held = false;
  assert.equal(ok(await cancel.stop(stop, 'actor')).state, 'cancelled');
  assert.deepEqual(ok(await journal.load(identity)).effects, []);
});

test('late deterministic callback cannot append or reopen work after Stop', async t => {
  const { first, observer, admission, journal, lease, cancel } = await setup(t);
  const entered = gate(), finish = gate();
  const worker = createReferenceWorker({
    host: { recover: async () => [], authorize: async () => ({ namespaceRef: 'fixture', host: identity.host, grantRevision: 1 }) },
    admission, journal,
    lease: lease(first),
    step: async () => { entered.release(); await finish.promise; return { kind: 'checkpoint' }; },
    limits: { maxSteps: 2, maxElapsedMs: 5_000, maxStepMs: 1_000, maxRetries: 0, leaseTtlMs: 2_000 },
  });
  await worker.start();
  const pending = worker.wake(identity);
  await entered.promise;
  const cancelled = ok(await cancel.stop(stop, 'actor'));
  finish.release();
  denied(await pending, 'lease_lost');
  assert.deepEqual(ok(await journal.load(identity)), cancelled);
  await worker.stop();
});
