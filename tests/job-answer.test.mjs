import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';
import { createJobAdmissionStore } from '../.reference-build/reference/node/job-admission.js';
import { createJobJournal } from '../.reference-build/reference/node/job-journal.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
import { createJobAnswerStore } from '../.reference-build/reference/node/job-answer.js';
import { createJobLease } from '../.reference-build/src/server/job-lease.js';
import { createJobCancellation } from '../.reference-build/src/server/cancel.js';
import { createJobAnswer } from '../.reference-build/src/server/answer.js';

const identity = {
  jobId: 'answer-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'test', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'original-route', correlationRef: 'original-correlation' },
};
const requirement = { kind: 'provider', requirementRef: 'challenge-1', revision: 1,
  actor: { kind: 'provider', actorRef: 'resolver-1' } };
const valid = result => { assert.equal(result.ok, true, result.code); return result.value; };
const denied = (result, code) => assert.deepEqual(result, { ok: false, code });
const delivery = { identity, requirementRef: requirement.requirementRef,
  requirementRevision: requirement.revision, resolverRef: 'resolver-1', deliveryKey: 'delivery-1',
  status: 'verified', responseRef: 'opaque-response-1' };

async function setup(t, { release = true } = {}) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const [first, second, observer] = await Promise.all(Array.from({ length: 3 }, () => harness.client()));
  await migrations(t, harness, first);
  const tables = journalTables(harness.schema);
  const state = { now: 1000, grantRevision: 1, cancellationRevision: 0, revoked: false,
    scope: structuredClone(identity.host) };
  const authority = () => ({ host: structuredClone(state.scope), grantRevision: state.grantRevision,
    cancellationRevision: state.cancellationRevision });
  const leaseHost = { now: () => state.now, newOwnerToken: () => 'worker-1',
    withAuthority: async (_identity, _operation, run) => state.revoked
      ? { ok: false, code: 'not_authorized' } : run(authority()) };
  const answerHost = { now: () => state.now,
    withAnswerAuthority: async (job, resolver, _operation, run) => state.revoked || resolver !== 'resolver-1'
      || job.jobId !== identity.jobId ? { ok: false, code: 'not_authorized' } : run(authority()) };
  const admission = createJobAdmissionStore(first.database(), tables);
  valid(await admission.admit({ namespaceRef: 'test', grantRevision: 1,
    operation: { operationRef: 'setup', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0,
      snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  const journal = createJobJournal(observer.database(), tables);
  const lease = createJobLease(leaseHost, createJobLeaseStore(first.database(), tables));
  const fence = valid(await lease.claim(identity, 100));
  const started = valid(await lease.append({ kind: 'started', previousRevision: 1,
    snapshot: { identity, revision: 2, state: 'running', effects: [] } }, fence));
  assert.equal(started.event.snapshot.revision, 2);
  valid(await lease.append({ kind: 'waiting', previousRevision: 2,
    snapshot: { identity, revision: 3, state: 'waiting', requirement, effects: [] } }, fence));
  if (release) valid(await lease.release(fence));
  const answer = client => createJobAnswer(answerHost, createJobAnswerStore(client.database(), tables));
  const challenge = { identity, requirement, jobRevision: 3, expiresAt: 2000, resolverRef: 'resolver-1' };
  return { harness, tables, first, second, observer, state, journal, answer, answerHost, challenge, leaseHost, lease, fence };
}

test('concurrent completions commit one answered event, stable receipt and bounded replay', async t => {
  const { harness, first, second, observer, journal, answer, challenge } = await setup(t);
  valid(await answer(first).issue(challenge));
  const [a, b] = await Promise.all([answer(first).complete(delivery), answer(second).complete(delivery)]);
  const receipts = [valid(a), valid(b)];
  assert.deepEqual(receipts.map(r => r.replayed).sort(), [false, true]);
  assert.deepEqual(receipts.map(r => r.eventCursor), [4, 4]);
  assert.equal(valid(await journal.load(identity)).state, 'waiting');
  assert.equal(valid(await journal.load(identity)).answer.responseRef, 'opaque-response-1');
  assert.equal((await observer.query(`SELECT count(*) AS n FROM ${harness.table('job_events')} WHERE job_id=$1 AND event->>'kind'='answered'`, [identity.jobId])).rows[0].n, '1');
  assert.equal((await observer.query(`SELECT count(*) AS n FROM ${harness.table('job_answer_deliveries')} WHERE job_id=$1`, [identity.jobId])).rows[0].n, '1');
  const replay = valid(await answer(second).events(identity, 'resolver-1', 2, 2));
  assert.deepEqual(replay.map(e => [e.kind, e.revision, e.jobId]), [['waiting', 3, identity.jobId], ['answered', 4, identity.jobId]]);
  assert.deepEqual(valid(await answer(first).events(identity, 'resolver-1', 4)), []);
  denied(await answer(first).events(identity, 'resolver-1', 0, 101), 'invalid_payload');
});

test('restart preserves original task and route; changed delivery content conflicts', async t => {
  const { first, second, state, journal, answer, challenge } = await setup(t);
  valid(await answer(first).issue(challenge));
  // A fresh API/store instance on a second database connection consumes the row.
  assert.equal(valid(await answer(second).complete(delivery)).eventCursor, 4);
  assert.deepEqual(valid(await journal.load(identity)).identity, identity);
  denied(await answer(first).complete({ ...delivery, responseRef: 'different-opaque-ref' }), 'conflict');
  state.now = 3000;
  assert.equal(valid(await answer(second).complete(delivery)).replayed, true);
  denied(await answer(second).complete({ ...delivery, deliveryKey: 'late-new-key' }), 'requirement_mismatch');
});

test('expiry, resolver, scope, grant change and revocation deny unconsumed answer', async t => {
  const { first, state, journal, answer, challenge } = await setup(t);
  valid(await answer(first).issue(challenge));
  denied(await answer(first).complete({ ...delivery, resolverRef: 'wrong-resolver' }), 'not_authorized');
  state.scope = { ...identity.host, tenantRef: 'wrong-tenant' };
  denied(await answer(first).complete(delivery), 'not_authorized');
  state.scope = { ...identity.host, accountRef: 'wrong-account' };
  denied(await answer(first).complete(delivery), 'not_authorized');
  state.scope = { ...identity.host, environmentRef: 'wrong-environment' };
  denied(await answer(first).complete(delivery), 'not_authorized');
  state.scope = structuredClone(identity.host);
  state.grantRevision++;
  denied(await answer(first).complete(delivery), 'requirement_mismatch');
  state.grantRevision--;
  state.revoked = true;
  denied(await answer(first).complete(delivery), 'not_authorized');
  state.revoked = false;
  state.now = 2000;
  denied(await answer(first).complete(delivery), 'requirement_mismatch');
  assert.equal(valid(await journal.load(identity)).revision, 3);
});

test('superseded challenge revision cannot deliver an answer to a later wait', async t => {
  const { first, answer, challenge, lease, fence, journal } = await setup(t, { release: false });
  valid(await answer(first).issue(challenge));
  valid(await lease.append({ kind: 'resumed', previousRevision: 3,
    command: { command: 'resume', identity, expectedRevision: 3, requirementRef: 'challenge-1',
      requirementRevision: 1, resolutionReceiptRef: 'verified-resolution' },
    snapshot: { identity, revision: 4, state: 'queued', effects: [] } }, fence));
  valid(await lease.append({ kind: 'started', previousRevision: 4,
    snapshot: { identity, revision: 5, state: 'running', effects: [] } }, fence));
  const next = { ...requirement, revision: 2 };
  valid(await lease.append({ kind: 'waiting', previousRevision: 5,
    snapshot: { identity, revision: 6, state: 'waiting', requirement: next, effects: [] } }, fence));
  valid(await lease.release(fence));
  valid(await answer(first).issue({ ...challenge, requirement: next, jobRevision: 6 }));
  denied(await answer(first).complete(delivery), 'requirement_mismatch');
  assert.equal(valid(await journal.load(identity)).revision, 6);
  assert.equal(valid(await answer(first).complete({ ...delivery, requirementRevision: 2,
    deliveryKey: 'delivery-2' })).eventCursor, 7);
  assert.deepEqual(valid(await journal.load(identity)).identity, identity);
});

test('a consumed challenge can be replaced after a verified same-job resume and later wait', async t => {
  const { first, answer, challenge, lease, fence, journal } = await setup(t, { release: false });
  valid(await answer(first).issue(challenge));
  valid(await answer(first).complete(delivery));
  valid(await lease.append({ kind: 'resumed', previousRevision: 4,
    command: { command: 'resume', identity, expectedRevision: 4, requirementRef: 'challenge-1',
      requirementRevision: 1, resolutionReceiptRef: 'verified-resolution' },
    snapshot: { identity, revision: 5, state: 'queued', effects: [] } }, fence));
  valid(await lease.append({ kind: 'started', previousRevision: 5,
    snapshot: { identity, revision: 6, state: 'running', effects: [] } }, fence));
  const next = { ...requirement, requirementRef: 'challenge-2', revision: 1 };
  valid(await lease.append({ kind: 'waiting', previousRevision: 6,
    snapshot: { identity, revision: 7, state: 'waiting', requirement: next, effects: [] } }, fence));
  valid(await lease.release(fence));
  valid(await answer(first).issue({ ...challenge, requirement: next, jobRevision: 7 }));
  assert.equal(valid(await answer(first).complete({ ...delivery, requirementRef: 'challenge-2',
    deliveryKey: 'delivery-2', responseRef: 'opaque-response-2' })).eventCursor, 8);
  assert.deepEqual(valid(await journal.load(identity)).identity, identity);
});

test('Stop fences a waiting answer without creating a new task or event', async t => {
  const { harness, first, second, observer, state, journal, answer, challenge, leaseHost } = await setup(t);
  valid(await answer(first).issue(challenge));
  const cancel = createJobCancellation({
    withStopAuthority: async (_identity, _actor, run) => run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 }),
    withEvidenceAuthority: async (_identity, _actor, run) => run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 }),
  }, createJobCancellationStore(second.database(), journalTables(harness.schema)));
  valid(await cancel.stop({ command: 'cancel', identity, expectedRevision: 3, reason: 'explicit_stop' }, 'user'));
  state.cancellationRevision = 1;
  denied(await answer(first).complete(delivery), 'requirement_mismatch');
  assert.equal(valid(await journal.load(identity)).state, 'cancelled');
  assert.equal((await observer.query(`SELECT count(*) AS n FROM ${harness.table('job_events')} WHERE job_id=$1 AND event->>'kind'='answered'`, [identity.jobId])).rows[0].n, '0');
});
