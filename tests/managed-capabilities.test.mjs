import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretKey, randomBytes } from 'node:crypto';
import { createManagedAgentCapabilities } from 'handrail-agent-sdk/server/capabilities';
import { createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { createPostgresHarness, migrations } from './fixtures/installed/database.mjs';
import { services, identity } from './fixtures/installed/host.mjs';
import { managedStore } from '../dist/server/managed/store.js';
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
const origin = 'https://app.example.com', baseUrl = `${origin}/agent-access`;
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
function model(handoff) {
  const requests = [];
  return { requests, async getResponse() { throw Error('STREAM_EXPECTED'); }, async *getStreamedResponse(request) {
    requests.push(request);
    const input = typeof request.input === 'string' ? [] : request.input;
    const outputs = input.filter(i => i.type === 'function_call_result');
    const output = outputs.length === 0 ? { type: 'function_call', callId: 'connect', name: 'agent_connect_account',
      arguments: JSON.stringify({ label: 'Family member', url: 'https://airline.example.com/login' }) }
      : handoff && !request.authCompleted ? { type: 'computer_use_approval_request', request_id: 'hosted-auth', request: {
        type: 'browser_authentication', credential_origin: 'https://airline.example.com', reason: 'Complete verification',
        fields: [{ id: 'code', label: 'Verification code', type: 'password', required: true }], options: [] } }
      : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The login is saved.' }] };
    yield { type: 'response_started' };
    yield { type: 'response_done', response: { id: `response-${outputs.length}`, output: [output], usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
  } };
}
async function setup(t, flags = { vault: true, browser: false }, handoff = false, hooks = {}) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup()); await migrations(t, harness);
  const key = createSecretKey(randomBytes(32)), keys = { current: async () => ({ ref: 'test-key', key }), resolve: async () => key };
  let signedIn = true, scope = identity.host;
  const create = () => createManagedAgentCapabilities({ database: harness.pool, schema: harness.schema, keys, baseUrl, features: flags,
    authenticate: async () => signedIn ? scope : null,
    restoreRuntime: hooks.lazy ? async original => { assert.deepEqual(original,identity); capabilities.createRuntime(deps); } : undefined,
    onAnswered: hooks.onAnswered });
  let capabilities = create(), deps;
  t.after(() => capabilities.close());
  const provider = model(handoff);
  const s = await services(harness.schema, randomBytes(32).toString('hex'), { model: provider,
    runtimeFactory: options => { deps = options; return capabilities.createRuntime(options); } });
  t.after(() => s.close());
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1, operation: { operationRef: 'connect', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  const request = (url, options) => capabilities.handleRequest(new Request(url, options));
  return { ...s, harness, keys, provider, request, get capabilities() { return capabilities; },
    auth: (value, next = scope) => { signedIn = value; scope = next; },
    async restart() { await capabilities.close(); capabilities = create();
      if(hooks.lazy)return;
      capabilities.createRuntime({ ...deps, host: { ...deps.host, authorize: async () => { throw Error('OTHER_USER'); } } });
      s.runtime = capabilities.createRuntime(deps); return s.runtime; },
  };
}
async function start(s) {
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  const state = ok(await s.states.load(identity, s.authority()));
  const result = JSON.parse(Object.values(state.results)[0].output);
  const page = await s.request(result.secureUrl);
  assert.equal(page.status, 200);
  const html = await page.text(), csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(csrf); return { ...result, csrf, html, page };
}
function submit(s, entry, password, override = {}) {
  return s.request(entry.secureUrl, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...override.headers },
    body: new URLSearchParams({ csrf: entry.csrf, username: 'private-user', password, consent: 'yes', origins: '', ...override.form }) });
}
async function settled(s) {
  for (let n = 0; n < 100; n++) {
    const state = ok(await s.journal.load(identity)); if (state.state === 'succeeded') return state;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('original task did not resume');
}
test('one SDK setup supplies form, encrypted custody, visible link, native answer and automatic same-job resume', async t => {
  const s = await setup(t), password = randomBytes(32).toString('hex'), entry = await start(s);
  assert.match(entry.html, /Save securely and continue/); assert.match(entry.page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const reader = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => ({}), pendingToolCallIds: async () => [] });
  const before = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, empty);
  assert.ok(before.events.some(e => e.type === 'response.text.delta' && e.delta.includes(entry.secureUrl)));
  assert.equal(before.result.status, 'waiting_for_approval');
  assert.deepEqual(before.result.pendingToolCallIds, [`managed:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`]);
  const response = await submit(s, entry, password); assert.equal(response.status, 200);
  await settled(s);
  const after = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, before.checkpoint);
  assert.equal(after.result.status, 'completed'); assert.ok(after.events.some(e => e.type === 'response.text.delta' && e.delta === 'The login is saved.'));
  const records = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  const checkpoint = ok(await s.states.load(identity, s.authority()));
  const events = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('job_events')}`)).rows;
  assert.equal(JSON.stringify([records, checkpoint, events, s.provider.requests]).includes(password), false);
  assert.equal(JSON.stringify([checkpoint, events, s.provider.requests]).includes('private-user'), false);
  const accounts = await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:');
  assert.equal(accounts.length, 1); assert.equal(accounts[0].value.password === password, true);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
});
test('secure entry survives a service restart before the user submits it', async t => {
  const s = await setup(t), entry = await start(s);
  const runtime = await s.restart();
  assert.equal((await submit(s, entry, randomBytes(32).toString('hex'))).status, 200);
  await settled(s); await runtime.stop();
});
test('expired private form reopens after recovery without reviving stale submissions or replacing the task', async t => {
  const s = await setup(t), entry = await start(s);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  await s.restart();
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  s.auth(false);
  const anonymous = await s.request(entry.secureUrl);
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.headers.get('x-handrail-agent-input-error'), 'authentication');
  s.auth(true, { ...identity.host, userRef: 'another' });
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  assert.equal((await store.get(identity.host, key)).version, saved.version + 1);
  s.auth(true, identity.host);
  const page = await s.request(entry.secureUrl); assert.equal(page.status, 200);
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf); assert.notEqual(csrf, entry.csrf);
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  assert.equal(ok(await s.journal.load(identity)).state, 'waiting');
  assert.equal(s.provider.requests.length, 1, 'reopening does not execute work or grant approval');
  assert.equal((await submit(s, { ...entry, csrf }, 'test-only-password')).status, 200);
  await settled(s);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
});

for (const phase of ['issue', 'complete']) test(`saved approval recovers after failed answer ${phase}, expiry and restart`, async t => {
  const s = await setup(t), entry = await start(s);
  const table = s.harness.table(phase === 'issue' ? 'job_challenges' : 'job_events');
  const fn = `"${s.harness.schema}"."fail_answer_once"`;
  await s.harness.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic answer delivery outage'; END $$`);
  await s.harness.pool.query(`CREATE TRIGGER fail_answer BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  const failed = await submit(s, entry, 'test-only-password');
  assert.equal(failed.status, 403);
  assert.match(failed.headers.get('x-handrail-agent-input-error'), /^answer_(issue|complete)_unavailable$/);
  await s.harness.pool.query(`DROP TRIGGER fail_answer ON ${table}`);
  await s.harness.pool.query(`DROP FUNCTION ${fn}()`);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  assert.equal(saved.value.completed, true, 'the original response was saved before the outage');
  assert.equal(ok(await s.journal.load(identity)).answer, undefined);
  const expired = Date.now() - 1;
  await store.put(identity.host, key, { ...saved.value, expiresAt: expired }, saved.version);
  await s.harness.pool.query(`UPDATE ${s.harness.table('job_challenges')} SET expires_at=$1`, [expired]);
  const runtime = await s.restart();
  s.state.denied = true;
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.state.denied = false;
  if (phase === 'issue') {
    // Original scheduler recovers the saved response without a second user click.
    ok(await runtime.resume(identity)); ok(await runtime.wake(identity));
  } else assert.equal((await s.request(entry.secureUrl)).status, 200);
  await settled(s);
  const deliveries = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('job_answer_deliveries')}`)).rows;
  assert.equal(deliveries.length, 1);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
  assert.equal(s.provider.requests.length, 2);
});

test('expired form cannot renew after Stop or revoked native authority', async t => {
  const s = await setup(t), entry = await start(s);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  s.state.denied = true;
  const revoked = await s.request(entry.secureUrl);
  assert.equal(revoked.status, 403);
  assert.equal(revoked.headers.get('x-handrail-agent-input-error'), 'job_authority');
  s.state.denied = false;
  const job = ok(await s.journal.load(identity));
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: job.revision, reason: 'explicit_stop' }, identity.host.userRef));
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  assert.equal((await store.get(identity.host, key)).version, saved.version + 1);
});
test('portal rejects wrong user, unauthenticated links, cross-site posts, invalid CSRF and unapproved destinations', async t => {
  const s = await setup(t), entry = await start(s);
  s.auth(false); assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.auth(true, { ...identity.host, userRef: 'another' }); assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.auth(true, identity.host);
  for (const change of [{ headers: { origin: 'https://attacker.example.com' } }, { form: { csrf: 'x'.repeat(64) } },
    { form: { consent: 'no' } }, { form: { origins: 'https://127.0.0.1' } }, { form: { origins: 'http://airline.example.com' } }])
    assert.equal((await submit(s, entry, 'test-only-password', change)).status, 403);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});
test('Stop prevents credential capture and a secure link cannot resume a cancelled task', async t => {
  const s = await setup(t), entry = await start(s), job = ok(await s.journal.load(identity));
  const reader = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => ({}), pendingToolCallIds: async () => [] });
  const before = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, empty);
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: job.revision, reason: 'explicit_stop' }, identity.host.userRef));
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  assert.equal(ok(await s.journal.load(identity)).state, 'cancelled');
  const after = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, before.checkpoint);
  assert.equal(after.result.status, 'cancelled');
  assert.ok(after.checkpoint.lastAppliedRevision >= before.checkpoint.lastAppliedRevision);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});
test('feature flags remove tools and disable the HTTP surface; construction has no database effects', async t => {
  const s = await setup(t, { vault: false, browser: false });
  assert.deepEqual(await s.capabilities.status(), { vault: 'disabled', browser: 'disabled' });
  assert.equal((await s.request(`${baseUrl}/${'a'.repeat(64)}`)).status, 404);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rowCount, 0);
});


test('revoked application authority prevents saving a previously issued credential form', async t => {
  const s = await setup(t), entry = await start(s);
  s.state.denied = true;
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});

test('hosted private sign-in survives restart and completes the same original provider request', async t => {
  const s = await setup(t, { vault: true, browser: true }, true), entry = await start(s);
  assert.equal((await submit(s, entry, 'test-only-password')).status, 200);
  let link;
  for (let n = 0; n < 100; n++) {
    const state = ok(await s.states.load(identity, s.authority()));
    const notice = state.interactionNotices.find(n => n.includes('private browser step'));
    link = notice && /\]\((https:[^)]+)\)/.exec(notice)?.[1];
    if (link && ok(await s.journal.load(identity)).state === 'waiting') break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(link);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(link).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  await s.restart();
  const page = await s.request(link); assert.equal(page.status, 200);
  const html=await page.text(), csrf=/name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(csrf);
  const code=randomBytes(16).toString('hex');
  assert.equal((await s.request(link, {method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,action:'submit',field_0:code})})).status,200);
  await settled(s);
  const checkpoint=ok(await s.states.load(identity,s.authority()));
  assert.equal(JSON.stringify([checkpoint,s.provider.requests]).includes(code),false);
  const stored=(await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  assert.equal(JSON.stringify(stored).includes(code),false);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});


test('private entry restores the original job lazily and hands its saved answer to the native scheduler', async t => {
  let notified = 0;
  const s = await setup(t, undefined, false, {lazy:true,onAnswered:async original=>{assert.deepEqual(original,identity);notified++;}});
  const entry = await start(s);
  await s.restart();
  s.auth(false);
  assert.equal((await s.request(entry.secureUrl)).status,403);
  s.auth(true);
  assert.equal((await s.request(entry.secureUrl)).status,200);
  assert.equal((await submit(s,entry,'synthetic-password')).status,200);
  assert.equal(notified,1);
  const waiting=ok(await s.journal.load(identity));
  assert.equal(waiting.state,'waiting');assert.ok(waiting.answer?.responseRef);
  assert.equal(s.provider.requests.length,1,'private form does not bypass the host scheduler');
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});
