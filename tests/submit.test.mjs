import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { createJobAdmission } from '../.reference-build/src/server/submit.js';
import { createJobAdmissionStore } from '../.reference-build/reference/node/job-admission.js';
import { fixtureLeaseHost } from './helpers/job-lease.mjs';
import { createJobLease } from '../.reference-build/src/server/job-lease.js';
import { createJobLeaseStore } from '../.reference-build/reference/node/job-lease.js';
import { journalTables } from '../.reference-build/reference/node/db/schema.js';

const request = { requestKey: 'admission-request-1', originTaskRef: 'original-task-submit-1', instructionRevision: 7,
  operation: { operationRef: 'connection.ensure', inputRefs: { provider: 'synthetic-provider', capability: 'read-metadata' } } };
const authority = { namespaceRef: 'workspace-1', grantRevision: 3,
  host: { tenantRef: 'tenant-1', userRef: 'actor-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'fixture', purposeRef: 'setup' } };
const binding = { native: { requestRef: 'native-request-1', rootTaskRef: 'native-root-1', sourceQueue: { queueRef: 'native-queue-1', messageRef: 'native-message-1' } },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation-1' } };
const clone = value => structuredClone(value);
function host(id, scope = authority) {
  return { authorizeSubmit: async () => ({ ...clone(scope), ...clone(binding) }),
    authorizeInspect: async () => clone(scope), newJobId: () => id };
}
function ok(result) { assert.equal(result.ok, true, result.code); return result.value; }
function rejected(result, code) { assert.deepEqual(result, { ok: false, code }); }
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const first = await harness.client(), second = await harness.client();
  await migrations(t, harness, first);
  const tables = journalTables(harness.schema);
  const make = (client, auth) => createJobAdmission(auth, createJobAdmissionStore(client.database(), tables));
  const stored = async () => {
    const result = {};
    for (const name of ['job_admissions', 'jobs', 'job_events', 'job_deliveries', 'job_checkpoints']) {
      result[name] = (await second.query(`SELECT * FROM ${harness.table(name)} ORDER BY 1, 2`)).rows;
    }
    return result;
  };
  return { harness, first, second, tables, make, stored,
    api: make(first, host('job-submit-1')), other: make(second, host('job-submit-2')) };
}

test('simultaneous identical submissions on independent backends admit exactly one original job', async t => {
  const { first, second, api, other, stored } = await setup(t);
  assert.notEqual((await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const results = (await Promise.all([api.submit(clone(request)), other.submit(clone(request))])).map(ok);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(results[0].jobId, results[1].jobId);
  assert.equal(results[0].originTaskRef, request.originTaskRef);
  const rows = await stored();
  for (const name of ['job_admissions', 'jobs', 'job_events', 'job_checkpoints']) assert.equal(rows[name].length, 1);
  assert.equal(rows.job_deliveries.length, 0);
  assert.deepEqual(rows.jobs[0].identity.native, binding.native);
  assert.deepEqual(rows.jobs[0].identity.origin, binding.origin);
  t.diagnostic(`PostgreSQL fixture admission receipts: ${JSON.stringify(results)}`);
});

test('operation, original instruction/task, account, scope and native/origin changes conflict under an existing reservation', async t => {
  const { api, first, make, stored } = await setup(t);
  ok(await api.submit(request)); const before = await stored();
  const changedRequests = [
    { ...request, operation: { ...request.operation, operationRef: 'different-operation' } },
    { ...request, operation: { ...request.operation, inputRefs: { ...request.operation.inputRefs, capability: 'write-metadata' } } },
    { ...request, originTaskRef: 'replacement-task' }, { ...request, instructionRevision: 8 },
  ];
  for (const changed of changedRequests) rejected(await api.submit(changed), 'conflict');
  for (const key of ['accountRef', 'projectRef', 'environmentRef', 'purposeRef']) {
    const changed = clone(authority); changed.host[key] = 'changed';
    rejected(await make(first, host('unused-job', changed)).submit(request), 'conflict');
  }
  for (const key of ['native', 'origin']) {
    const changed = host('unused-job');
    changed.authorizeSubmit = async () => ({ ...clone(authority), ...clone(binding),
      [key]: key === 'native' ? { requestRef: 'changed' } : { ...binding.origin, correlationRef: 'changed' } });
    rejected(await make(first, changed).submit(request), 'conflict');
  }
  assert.deepEqual(await stored(), before);
});

test('independent authorized tenant, actor, account and environment namespaces are isolated', async t => {
  const { first, make, stored, api } = await setup(t);
  const original = ok(await api.submit(request));
  for (const key of ['tenantRef', 'userRef', 'accountRef', 'environmentRef', 'projectRef']) {
    const scope = clone(authority); scope.host[key] = 'independent';
    // Host namespaces partition account/environment work. Keeping the old
    // namespace instead would conflict, as the preceding test proves.
    if (!['tenantRef', 'userRef'].includes(key)) scope.namespaceRef = `workspace-${key}`;
    const independent = make(first, host(`job-isolation-${key}`, scope));
    const receipt = ok(await independent.submit(request));
    assert.notEqual(receipt.jobId, original.jobId);
    rejected(await independent.inspect({ jobId: original.jobId }), 'not_authorized');
    ok(await independent.inspect({ jobId: receipt.jobId }));
    rejected(await api.inspect({ jobId: receipt.jobId }), 'not_authorized');
  }
  assert.equal((await stored()).jobs.length, 6);
});

test('forged identity/grant claims and unsupported decoded data never reach authorization or persistence', async t => {
  const { first, make, stored } = await setup(t);
  let calls = 0; const auth = host('unused-job');
  auth.authorizeSubmit = async () => { calls++; return { ...clone(authority), ...clone(binding) }; };
  auth.authorizeInspect = async () => { calls++; return clone(authority); };
  const api = make(first, auth);
  for (const mutate of [
    r => { r.identity = { ...authority.host, jobId: 'forged' }; },
    r => { r.grantRevision = 900; }, r => { r.host = authority.host; },
    r => { r.operation.inputRefs.token = { raw: 'synthetic-private' }; },
    r => { r.operation.inputRefs.resource = 'https://unapproved.invalid'; },
    r => { r.operation.inputRefs = []; }, r => { r.operation.inputRefs.resource = undefined; },
    r => { r.operation.inputRefs.resource = 3; },
    r => { r.extra = Symbol('unsupported'); },
    r => { Object.defineProperty(r, 'requestKey', { enumerable: true, get() { throw Error('synthetic-private'); } }); },
    r => { Object.defineProperty(r, 'hidden', { value: 'synthetic-private' }); },
    r => { r[Symbol('hidden')] = 'synthetic-private'; },
    r => { r.operation.inputRefs.cycle = r; },
    r => { r.operation.inputRefs = new Date(); },
    r => { r.instructionRevision = Number.NaN; },
  ]) {
    const input = clone(request); mutate(input); rejected(await api.submit(input), 'invalid_payload');
  }
  rejected(await api.inspect({ jobId: 'existing', grantRevision: 900 }), 'invalid_payload');
  assert.equal(calls, 0);
  for (const rows of Object.values(await stored())) assert.equal(rows.length, 0);
});

test('every retry and inspect require current authority; errors do not leak host causes', async t => {
  const { first, api, make, stored } = await setup(t);
  const receipt = ok(await api.submit(request)); const before = await stored();
  let calls = 0;
  const deniedHost = host('unused-job');
  deniedHost.authorizeSubmit = deniedHost.authorizeInspect = async () => { calls++; throw Error('synthetic-private-host-error'); };
  const denied = make(first, deniedHost);
  rejected(await denied.submit(request), 'not_authorized');
  rejected(await denied.inspect({ jobId: receipt.jobId }), 'not_authorized');
  rejected(await denied.inspect({ jobId: 'unknown' }), 'not_authorized');
  assert.equal(calls, 3);
  const changed = clone(authority); changed.grantRevision++;
  rejected(await make(first, host('unused-job', changed)).submit(request), 'conflict');
  // Fresh authority can approve a read without rewriting the original grant binding.
  ok(await make(first, host('unused-job', changed)).inspect({ jobId: receipt.jobId }));
  for (const key of Object.keys(authority.host)) {
    const wrong = clone(authority); wrong.host[key] = 'wrong';
    rejected(await make(first, host('unused-job', wrong)).inspect({ jobId: receipt.jobId }), 'not_authorized');
  }
  assert.deepEqual(await stored(), before);
});

test('canonical object ordering retries and lost responses recover original identity after client close', async t => {
  const { harness, api, first, make, stored } = await setup(t);
  const receipt = ok(await api.submit(request));
  const before = await stored();
  await first.close();
  rejected(await api.inspect({ jobId: receipt.jobId }), 'unavailable');
  rejected(await api.submit(request), 'unavailable');
  const fresh = await harness.client();
  const auth = host('new-client-unused-job');
  auth.authorizeSubmit = async () => ({ ...clone(authority), ...clone(binding),
    host: Object.fromEntries(Object.entries(authority.host).reverse()),
    native: Object.fromEntries(Object.entries(binding.native).reverse()) });
  const retry = { ...clone(request), operation: { inputRefs: Object.fromEntries(Object.entries(request.operation.inputRefs).reverse()), operationRef: request.operation.operationRef } };
  assert.deepEqual(ok(await make(fresh, auth).submit(retry)), { ...receipt, replayed: true });
  assert.equal(ok(await make(fresh, auth).inspect({ jobId: receipt.jobId })).state, 'queued');
  assert.deepEqual(await stored(), before);
  await fresh.close();
  assert.deepEqual(await stored(), before);
  t.diagnostic(`Recovered original synthetic job/task after connection close: ${receipt.jobId}/${receipt.originTaskRef}; no cancellation or extra event.`);
});

test('late reservation failure rolls back job/event/checkpoint and permits a clean retry', async t => {
  const { harness, first, api, other, stored } = await setup(t);
  await first.query(`ALTER TABLE ${harness.table('job_admissions')} ADD CONSTRAINT synthetic_failure CHECK (request_key <> 'admission-request-1')`);
  rejected(await api.submit(request), 'unavailable');
  for (const rows of Object.values(await stored())) assert.equal(rows.length, 0);
  await first.query(`ALTER TABLE ${harness.table('job_admissions')} DROP CONSTRAINT synthetic_failure`);
  const receipt = ok(await other.submit(request));
  assert.equal(receipt.jobId, 'job-submit-2');
  assert.equal(receipt.replayed, false);
  const before = await stored();
  assert.equal(ok(await api.submit(request)).jobId, receipt.jobId);
  assert.deepEqual(await stored(), before);
});

test('inspection exposes only allowlisted durable state and cursor; replay stays the initial receipt', async t => {
  const { api, first, tables, stored } = await setup(t);
  const admitted = ok(await api.submit(request));
  const identity = (await stored()).jobs[0].identity;
  const runtime = createJobLease(fixtureLeaseHost(identity), createJobLeaseStore(first.database(), tables));
  const fence = ok(await runtime.claim(identity, 10000));
  const journal = { append: event => runtime.append(event, fence) };
  ok(await journal.append({ kind: 'started', previousRevision: 1,
    snapshot: { identity, state: 'running', revision: 2, effects: [] } }));
  ok(await journal.append({ kind: 'waiting', previousRevision: 2,
    snapshot: { identity, state: 'waiting', revision: 3, effects: [],
      requirement: { kind: 'secure_input', requirementRef: 'private-reference', revision: 1, actor: { kind: 'user', actorRef: 'private-actor' } } } }));
  assert.deepEqual(ok(await api.inspect({ jobId: admitted.jobId })), {
    jobId: admitted.jobId, originTaskRef: request.originTaskRef, instructionRevision: 7, state: 'waiting', eventCursor: 3 });
  assert.deepEqual(ok(await api.submit(request)), { ...admitted, replayed: true });
  assert.equal((await stored()).job_events.length, 3);
});

test('submit and inspect detach caller input before asynchronous authorization', async t => {
  const { first, make, stored } = await setup(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const auth = host('job-detached-1');
  auth.authorizeSubmit = async input => {
    await gate;
    assert.deepEqual(JSON.parse(JSON.stringify(input)), request);
    input.originTaskRef = 'host-mutation-must-not-change-binding';
    return { ...clone(authority), ...clone(binding) };
  };
  const api = make(first, auth), input = clone(request);
  const pending = api.submit(input);
  input.originTaskRef = 'caller-mutated'; input.operation.inputRefs.provider = 'caller-mutated';
  release(); const receipt = ok(await pending);
  assert.equal(receipt.originTaskRef, request.originTaskRef);
  let releaseInspect; const inspectGate = new Promise(resolve => { releaseInspect = resolve; });
  auth.authorizeInspect = async input => { await inspectGate; assert.equal(input.jobId, receipt.jobId); input.jobId = 'mutated'; return clone(authority); };
  const target = { jobId: receipt.jobId }, inspection = api.inspect(target);
  target.jobId = 'caller-mutated'; releaseInspect();
  assert.equal(ok(await inspection).jobId, receipt.jobId);
  assert.equal((await stored()).jobs[0].identity.originTaskRef, request.originTaskRef);
});

test('admission migration and cleanup preserve an independent schema sentinel', async t => {
  const sentinel = await createPostgresHarness(); t.after(() => sentinel.cleanup());
  const observer = await sentinel.client();
  await observer.query(`CREATE TABLE ${sentinel.table('sentinel')} (value integer NOT NULL)`);
  await observer.query(`INSERT INTO ${sentinel.table('sentinel')} VALUES (91)`);
  const { harness, api } = await setup(t);
  ok(await api.submit(request)); await harness.cleanup();
  assert.deepEqual((await observer.query(`SELECT * FROM ${sentinel.table('sentinel')}`)).rows, [{ value: 91 }]);
  assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname=$1', [harness.schema])).rows[0].n, 0);
});


test('authority revoked or changed during persistence suppresses output without undoing admission', async t => {
  const { first, make, api, stored } = await setup(t);
  let calls = 0;
  const revoked = host('job-release-fence-1');
  revoked.authorizeSubmit = async () => ++calls === 1 ? { ...clone(authority), ...clone(binding) } : null;
  rejected(await make(first, revoked).submit(request), 'not_authorized');
  assert.equal(calls, 2);
  const rows = await stored();
  assert.equal(rows.jobs.length, 1); assert.equal(rows.job_admissions.length, 1); assert.equal(rows.job_events.length, 1);
  const recovered = ok(await api.submit(request));
  assert.equal(recovered.jobId, 'job-release-fence-1'); assert.equal(recovered.replayed, true);
  calls = 0;
  const changed = host('unused-job');
  changed.authorizeInspect = async () => ({ ...clone(authority), grantRevision: ++calls === 1 ? 3 : 4 });
  rejected(await make(first, changed).inspect({ jobId: recovered.jobId }), 'not_authorized');
  assert.equal(calls, 2);
  assert.deepEqual(await stored(), rows);
});
