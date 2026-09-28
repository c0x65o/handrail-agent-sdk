import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { createJobAdmissionStore } from '../.reference-build/reference/node/job-admission.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { createJobLease } from '../.reference-build/src/server/job-lease.js';
import { createReferenceWorker } from '../.reference-build/reference/node/worker.js';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';

const identity = { jobId: 'worker-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 7,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root', actionRef: 'original-action',
    operationRef: 'original-operation', effectRef: 'original-effect' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' } };
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
function event(kind, current, extra = {}) {
  return { kind, previousRevision: current.revision,
    snapshot: { identity: current.identity, revision: current.revision + 1, effects: current.effects,
      ...(kind === 'waiting' ? { state: 'waiting', requirement: { kind: 'host', requirementRef: 'durable-signal',
        revision: 1, actor: { kind: 'host', actorRef: 'fixture-host' } } } : { state: 'running' }), ...extra } };
}
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t, harness, client);
  const tables = journalTables(harness.schema), db = client.database();
  const journal = createJobJournal(db, tables), admission = createJobAdmissionStore(db, tables);
  ok(await admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'deterministic', inputRefs: { source: 'synthetic' } },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, state: 'queued', revision: 1, effects: [] } } }));
  let token = 0;
  const lease = createJobLease({ now: Date.now, newOwnerToken: () => `fixture-${++token}`,
    withAuthority: async (_id, _operation, run) => run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 }) },
  createJobLeaseStore(db, tables));
  const host = { recover: async () => [identity], authorize: async () => ({ namespaceRef: 'fixture', host: identity.host, grantRevision: 1 }) };
  const limits = { maxSteps: 2, maxElapsedMs: 5_000, maxStepMs: 500, maxRetries: 1, leaseTtlMs: 800 };
  const rows = async () => (await client.query(`SELECT revision, event FROM ${harness.table('job_events')} ORDER BY revision`)).rows;
  return { harness, client, journal, admission, lease, host, limits, rows };
}
function child(schema, mode) {
  const proc = fork(new URL('./helpers/worker-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(Error('WORKER_CHILD_TIMEOUT')); }, 12_000);
    proc.once('message', value => { clearTimeout(timer); resolve(value); });
    proc.once('error', () => { clearTimeout(timer); reject(Error('WORKER_CHILD_FAILED')); });
    proc.once('exit', () => { clearTimeout(timer); reject(Error('WORKER_CHILD_EXITED_EARLY')); });
  });
  proc.send({ schema, identity, mode });
  return { proc, message, exited };
}

test('fresh process resumes the same admitted job after a committed checkpoint', async t => {
  const { harness, client, journal, rows } = await setup(t);
  const first = child(harness.schema, 'checkpoint');
  let second;
  t.after(() => { first.proc.kill('SIGKILL'); second?.proc.kill('SIGKILL'); });
  const checkpoint = await first.message;
  assert.deepEqual({ event: checkpoint.event, jobId: checkpoint.jobId, revision: checkpoint.revision,
    correlationRef: checkpoint.correlationRef }, { event: 'checkpoint_committed', jobId: identity.jobId,
    revision: 3, correlationRef: identity.origin.correlationRef });
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'effects_recorded']);
  first.proc.kill('SIGKILL');
  const firstExit = await first.exited;
  assert.deepEqual(firstExit, { code: null, signal: 'SIGKILL' });
  const head = (await client.query(`SELECT lease_expires_at FROM ${harness.table('jobs')} WHERE job_id=$1`, [identity.jobId])).rows[0];
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(head.lease_expires_at) - Date.now() + 15)));
  second = child(harness.schema, 'resume');
  const done = await second.message;
  assert.equal(done.event, 'done'); assert.notEqual(checkpoint.pid, done.pid);
  assert.deepEqual(done.result, [{ ok: true, value: 'succeeded' }]);
  const secondExit = await second.exited;
  assert.deepEqual(secondExit, { code: 0, signal: null });
  const history = await rows();
  assert.deepEqual(history.map(r => [Number(r.revision), r.event.kind]),
    [[1, 'submitted'], [2, 'started'], [3, 'effects_recorded'], [4, 'succeeded']]);
  assert.equal(history.filter(r => r.event.kind === 'effects_recorded').length, 1);
  assert.equal(history.filter(r => r.event.kind === 'succeeded').length, 1);
  for (const row of history) assert.deepEqual(row.event.snapshot.identity, identity);
  assert.deepEqual(ok(await journal.load(identity)), history[3].event.snapshot);
  const finalHead = (await client.query(`SELECT lease_owner, lease_epoch FROM ${harness.table('jobs')} WHERE job_id=$1`, [identity.jobId])).rows[0];
  assert.equal(finalHead.lease_owner, null); assert.equal(finalHead.lease_epoch, '2');
  t.diagnostic(`Synthetic process correlation: first_pid=${checkpoint.pid} second_pid=${done.pid} job=${identity.jobId} origin=${identity.origin.correlationRef} revisions=1,2,3,4; one checkpoint and one success.`);
});

test('waiting job does not dispatch or spin without a durable resume signal', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  const fence = ok(await lease.claim(identity, 800));
  const submitted = ok(await journal.load(identity));
  ok(await lease.append(event('started', submitted), fence));
  const running = ok(await journal.load(identity));
  ok(await lease.append(event('waiting', running), fence));
  ok(await lease.release(fence));
  let calls = 0;
  const worker = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { calls++; return { kind: 'checkpoint' }; } });
  assert.deepEqual(await worker.start(), [{ ok: true, value: 'waiting' }]);
  assert.deepEqual(await worker.wake(identity), { ok: true, value: 'waiting' });
  await worker.stop();
  assert.equal(calls, 0);
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'waiting']);
});

test('durable step exhaustion commits a precise failed state and stays terminal', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  let calls = 0;
  const worker = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { calls++; return { kind: 'checkpoint' }; } });
  assert.deepEqual(await worker.start(), [{ ok: true, value: 'failed' }]);
  await worker.stop();
  assert.equal(calls, 2);
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'effects_recorded', 'effects_recorded', 'failed']);
  assert.deepEqual(ok(await journal.load(identity)).error, { code: 'execution_failed', correlationRef: identity.origin.correlationRef });
  const again = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { assert.fail('terminal job dispatched'); } });
  assert.deepEqual(await again.start(), [{ ok: true, value: 'failed' }]); await again.stop();
});

test('adapter retry exhaustion is bounded and records the original correlation', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  let calls = 0;
  const worker = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { calls++; throw Error('synthetic-private-error'); } });
  assert.deepEqual(await worker.start(), [{ ok: true, value: 'failed' }]); await worker.stop();
  assert.equal(calls, 2); // first attempt plus one allowed retry
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'failed']);
  assert.deepEqual(ok(await journal.load(identity)).error, { code: 'execution_failed', correlationRef: identity.origin.correlationRef });
});

test('graceful stop aborts the current step and releases the lease', async t => {
  const { client, harness, journal, admission, lease, host, limits, rows } = await setup(t);
  let stepStarted;
  const entered = new Promise(resolve => { stepStarted = resolve; });
  const worker = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { stepStarted(); return new Promise(() => {}); } });
  const running = worker.start(); await entered;
  await worker.stop();
  assert.deepEqual(await running, [{ ok: true, value: 'stopped' }]);
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started']);
  const head = (await client.query(`SELECT lease_owner FROM ${harness.table('jobs')} WHERE job_id=$1`, [identity.jobId])).rows[0];
  assert.equal(head.lease_owner, null);
});

test('changed original authorization does not dispatch or mutate the journal', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  let calls = 0;
  const denied = { ...host, authorize: async () => null };
  const worker = createReferenceWorker({ journal, admission, lease, host: denied, limits,
    step: async () => { calls++; return { kind: 'checkpoint' }; } });
  assert.deepEqual(await worker.start(), [{ ok: false, code: 'not_authorized' }]); await worker.stop();
  assert.equal(calls, 0); assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted']);
});

test('step timeout terminates with a precise failure and ignores a late adapter result', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  let resolveStep;
  const worker = createReferenceWorker({ journal, admission, lease, host,
    limits: { ...limits, maxElapsedMs: 200, maxStepMs: 30, maxRetries: 0 },
    step: async () => new Promise(resolve => { resolveStep = resolve; }) });
  assert.deepEqual(await worker.start(), [{ ok: true, value: 'failed' }]);
  resolveStep({ kind: 'succeeded', receiptRef: 'late-receipt' });
  await worker.stop();
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'failed']);
  assert.deepEqual(ok(await journal.load(identity)).error, { code: 'execution_failed', correlationRef: identity.origin.correlationRef });
});

test('recorded unknown effect is preserved for separate reconciliation', async t => {
  const { journal, admission, lease, host, limits, rows } = await setup(t);
  const fence = ok(await lease.claim(identity, 800));
  ok(await lease.append(event('started', ok(await journal.load(identity))), fence));
  const running = ok(await journal.load(identity));
  const effect = { actionRef: 'original-action', operationRef: 'original-operation',
    effectRef: 'original-effect', outcome: 'unknown' };
  ok(await lease.append(event('effects_recorded', running, { effects: [effect] }), fence));
  ok(await lease.release(fence));
  let calls = 0;
  const worker = createReferenceWorker({ journal, admission, lease, host, limits,
    step: async () => { calls++; return { kind: 'checkpoint' }; } });
  assert.deepEqual(await worker.start(), [{ ok: false, code: 'effect_conflict' }]); await worker.stop();
  assert.equal(calls, 0);
  assert.deepEqual((await rows()).map(r => r.event.kind), ['submitted', 'started', 'effects_recorded']);
  assert.deepEqual(ok(await journal.load(identity)).effects, [effect]);
});
