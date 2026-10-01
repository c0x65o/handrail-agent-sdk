import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { createPostgresHarness, migrations } from './database.mjs';
import { services, identity } from './host.mjs';

const ok = result => { assert.equal(result.ok, true, result.code); return result.value; };
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
async function fixture(t, options) {
  const harness = await createPostgresHarness();
  const client = await harness.client();
  await migrations(t, harness, client);
  await client.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY, receipt text NOT NULL, attempts integer NOT NULL DEFAULT 1)`);
  const key = randomBytes(32).toString('hex');
  const instances = [];
  t.after(async () => { for (const s of instances) await s.close(); await harness.cleanup(); });
  const open = async options => { const s = await services(harness.schema, key, options); instances.push(s); return s; };
  const s = await open(options);
  const admit = async (s, id) => ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'agent-task', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity: id, revision: 1, state: 'queued', effects: [] } } }));
  await admit(s, identity);
  return { s, open, admit, client, harness };
}

test('failed attachment preparation settles the canonical job before provider/tool execution and survives reconnect', async t => {
  const privateFailure = 'private-storage-endpoint-and-object-key';
  const { s, open } = await fixture(t, { host: {
    input: async () => [{ role: 'user', content: [{ type: 'input_file', file: 'opaque-owned-attachment' },
      { type: 'input_text', text: 'Read my saved draft trip.' }] }],
    prepareModelInput: async () => { throw Error(privateFailure); },
  } });
  assert.equal(ok(await s.runtime.wake(identity)), 'failed');
  assert.equal(s.model.requests, 0);
  assert.equal(s.calls.length, 0);
  const fresh = await open({});
  assert.equal(ok(await fresh.runtime.wake(identity)), 'failed');
  assert.equal(fresh.model.requests, 0);
  const member = { id: 'fixture', source: 'server_derived', trust: 'authoritative' };
  const read = createAgentCheckpointReader({ runtime: fresh.runtime,
    attribution: async () => ({ organization: member, project: member, service_environment: member,
      known_user: member, session: member, automation: { ...member, id: null } }), pendingToolCallIds: async () => [] });
  const page = await read({ identity, turnId: 'turn-one', mutationId: 'mutation-one' }, empty);
  assert.equal(page.result.status, 'failed');
  assert.deepEqual(page.events.map(event => event.type), ['response.started', 'response.error']);
  assert.ok(!JSON.stringify([page, s.events]).includes(privateFailure));
});

test('preparation deadline settles without dispatch, and a materially different subsequent conversation completes', async t => {
  const { s, open, admit } = await fixture(t, { limits: { maxElapsedMs: 250 },
    host: { prepareModelInput: async () => new Promise(() => {}) } });
  assert.equal(ok(await s.runtime.wake(identity)), 'failed');
  assert.equal(s.model.requests, 0);
  const nextIdentity = { ...identity, jobId: 'next-job', requestKey: 'next-request', originTaskRef: 'next-task' };
  const next = await open({ identity: nextIdentity, scenario: 'research' });
  await admit(next, nextIdentity);
  assert.equal(ok(await next.runtime.wake(nextIdentity)), 'succeeded');
  assert.equal(ok(await next.states.load(nextIdentity, next.authority())).output, 'Fallback quote: 21');
});

test('durable Stop during preparation remains cancelled when late preparation fails', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { s } = await fixture(t, { host: { prepareModelInput: async () => {
    entered(); await held; throw Error('late private failure');
  } } });
  const running = s.runtime.wake(identity);
  await started;
  const snapshot = ok(await s.journal.load(identity));
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor'));
  release(); await running;
  assert.equal(ok(await s.journal.load(identity)).state, 'cancelled');
  assert.equal(s.model.requests, 0);
  assert.equal(ok(await s.runtime.wake(identity)), 'cancelled');
});

test('initial input failure settles even before the first private checkpoint', async t => {
  const { s } = await fixture(t, { host: { input: async () => { throw Error('private input failure'); } } });
  assert.equal(ok(await s.runtime.wake(identity)), 'failed');
  assert.equal(ok(await s.journal.load(identity)).state, 'failed');
  assert.equal(s.model.requests, 0);
});

test('process shutdown during preparation retains recovery rather than recording failure', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { s, open } = await fixture(t, { host: { prepareModelInput: async (_id, input) => {
    entered(); await held; return input;
  } } });
  const running = s.runtime.wake(identity);
  await started;
  await s.runtime.stop();
  assert.equal(ok(await running), 'stopped');
  release();
  assert.equal(ok(await s.journal.load(identity)).state, 'running');
  const replacement = await open({ scenario: 'research' });
  assert.equal(ok(await replacement.runtime.wake(identity)), 'succeeded');
});
