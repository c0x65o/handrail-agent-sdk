import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createBrowserUse, createLoginFillExecutor, createLoginVault, validateVaultLoginValue } from 'handrail-agent-sdk/server';
import { fixture, bind, observation } from './helpers/browser-use-fixture.mjs';
const ok = value => ({ ok: true, value });
function setup(timeout = 1000) {
  const f = fixture();
  const state = { dispatches: 0, now: 2000, observeAllowed: true, raw: null, denied: false, currentAtDispatch: null };
  const host = { now: () => state.now, withAuthority: async (_r, _phase, run) => state.denied
    ? { ok: false, code: 'not_authorized' } : run({ authority: f.authority, context: () => f.context, canObserve: () => state.observeAllowed }) };
  const executor = { operationRef: 'browser-operation', bind,
    dispatch: async (_r, signal, current) => { state.dispatches++; state.currentAtDispatch = current(); return 'verified'; },
    reconcile: async () => state.dispatches ? 'verified' : 'not_applied', observe: async r => state.raw ?? observation(r) };
  // Boundary fixture only. The companion runtime suite uses the PostgreSQL ledger.
  const store = { admit: async () => ok({ admitted: true }),
    dispatch: async (_r, _a, read, run) => { const prior = await read(); return ok(prior.outcome === 'not_applied' ? await run() : prior); },
    reconcile: async (_r, run) => ok(await run()) };
  return { ...f, state, host, executor, store, make: () => createBrowserUse(host, store, [executor], timeout) };
}
test('browser execution returns a receipt and gated observation, with read-only recovery', async () => {
  const s = setup(), browser = s.make();
  assert.equal(s.state.dispatches, 0);
  assert.deepEqual(await browser.execute(s.request, s.fence), ok({ outcome: 'verified', receiptRef: 'effect' }));
  assert.equal(s.state.currentAtDispatch, true);
  assert.deepEqual(await browser.observe(s.request), ok(observation(s.request)));
  await browser.execute(s.request, s.fence);
  await browser.reconcile(s.request);
  assert.equal(s.state.dispatches, 1);
});
for (const [name, mutate] of Object.entries({
  'revoked profile': s => { s.context.profile.state = 'revoked'; },
  'expired lease': s => { s.state.now = s.request.lease.expiresAt; },
  'wrong account': s => { s.context.currentJob = structuredClone(s.context.currentJob); s.context.currentJob.identity.host.accountRef = 'other'; },
  'changed document': s => { s.request.document.navigationRevision++; },
  'typing without text authorization': s => { s.request.action = { kind: 'type', elementRef: 'field', textRef: 'text' }; s.context.admittedOperation = structuredClone(s.request); },
  'transfer without authorization': s => { s.request.action = { kind: 'download', elementRef: 'file', artifact: { artifactRef: 'artifact', revision: 1, scope: s.request.identity.host } }; s.context.admittedOperation = structuredClone(s.request); },
  'changed effect binding': s => { s.executor.bind = r => ({ ...bind(r), actionRef: 'wrong' }); },
  'forged fence': s => { s.fence.host = { ...s.fence.host, accountRef: 'other' }; },
  'host rejection': s => { s.state.denied = true; },
})) test(`browser denies ${name} before dispatch`, async () => {
  const s = setup();
  mutate(s);
  assert.equal((await s.make().execute(s.request, s.fence)).ok, false);
  assert.equal(s.state.dispatches, 0);
});
test('vault actions cannot dispatch through a generic browser registration', async () => {
  const s = setup(); s.request.action = { kind: 'vault_fill', grantRef: 'grant', grantRevision: 1 };
  assert.deepEqual(await s.make().execute(s.request, s.fence), { ok: false, code: 'invalid_payload' });
  assert.equal(s.state.dispatches, 0);
});
test('observation reauthorizes and rejects raw payloads, stale bindings and provider errors', async () => {
  const s = setup(), secret = randomBytes(24).toString('hex'), results = [];
  s.state.observeAllowed = false; results.push(await s.make().observe(s.request));
  s.state.observeAllowed = true;
  s.state.raw = { ...observation(s.request), text: secret }; results.push(await s.make().observe(s.request));
  s.state.raw = observation(structuredClone(s.request)); s.state.raw.request.document.navigationRevision++;
  results.push(await s.make().observe(s.request));
  s.executor.observe = async () => { throw Error(secret); }; results.push(await s.make().observe(s.request));
  assert.ok(results.every(r => !r.ok)); assert.equal(JSON.stringify(results).includes(secret), false);
});
test('timeouts stop late dispatch and observation release', async () => {
  const s = setup(5); let current, finish, signal;
  s.executor.dispatch = async (_r, sig, check) => { current = check; signal = sig; await new Promise(r => { finish = r; }); return 'verified'; };
  const browser = s.make();
  assert.deepEqual(await browser.execute(s.request, s.fence), ok({ outcome: 'unknown' }));
  assert.equal(signal.aborted, true); assert.equal(current(), false); finish();
  let release; s.executor.observe = async r => { await new Promise(resolve => { release = resolve; }); return observation(r); };
  assert.deepEqual(await s.make().observe(s.request), { ok: false, code: 'unavailable' }); release();
});
function login() {
  const { request: r } = fixture();
  return { identity: r.identity, jobRevision: 2, grantRef: 'grant', grantRevision: 1, effect: r.effect, operation: 'fill',
    item: { metadata: { kind: 'login', credential: 'password' }, reference: { kind: 'secret', itemRef: 'login', revision: 1 } },
    destination: { origin: r.document.origin, profileRef: 'profile', leaseEpoch: 1, documentRef: 'document', navigationRevision: 1,
      frames: r.document.frames, fieldRef: 'password', fieldKind: 'password', formEndpoint: 'https://fixture.example/login' } };
}
const registration = { operationRef: 'browser-operation', bind: () => { throw Error('UNUSED'); }, reconcile: async () => 'unknown' };
test('password fills only the exact private target and never appears in results', async () => {
  const request = login(), value = { password: randomBytes(32).toString('hex') }, controller = new AbortController();
  let fills = 0, current = true, change = () => {}, hook = () => {};
  const executor = createLoginFillExecutor(registration, { withTarget: async (r, _signal, run) => {
    hook(); const destination = structuredClone(r.destination); change(destination);
    return run({ destination, fill: async (password, live) => {
      assert.equal(live(), true); assert.equal(password === value.password, true); fills++; return 'verified';
    } });
  } });
  assert.equal(await executor.dispatch(request, value, controller.signal, () => current), 'verified');
  for (const key of ['origin', 'profileRef', 'leaseEpoch', 'documentRef', 'navigationRevision', 'fieldRef', 'fieldKind', 'formEndpoint']) {
    change = d => { d[key] = typeof d[key] === 'number' ? d[key] + 1 : `${d[key]}-other`; };
    assert.equal(await executor.dispatch(request, value, controller.signal, () => current), 'unknown');
  }
  change = d => { d.frames[0].origin = 'https://other.example'; };
  assert.equal(await executor.dispatch(request, value, controller.signal, () => current), 'unknown');
  change = () => {}; hook = () => { current = false; };
  assert.equal(await executor.dispatch(request, value, controller.signal, () => current), 'unknown');
  assert.equal(fills, 1);
});
test('login rejects spoofed success, duplicate and escaped callbacks, and raw exceptions', async () => {
  const request = login(), value = { password: randomBytes(32).toString('hex') }, signal = new AbortController().signal;
  let callback, fills = 0;
  const target = { destination: request.destination, fill: async () => { fills++; return 'verified'; } };
  const late = createLoginFillExecutor(registration, { withTarget: async (_r, _s, run) => { callback = run; return 'verified'; } });
  assert.equal(await late.dispatch(request, value, signal, () => true), 'unknown');
  assert.equal(await callback(target), 'unknown'); assert.equal(fills, 0);
  const twice = createLoginFillExecutor(registration, { withTarget: async (_r, _s, run) => {
    const results = await Promise.all([run(target), run(target)]); assert.deepEqual(results, ['verified', 'unknown']); return results[0];
  } });
  assert.equal(await twice.dispatch(request, value, signal, () => true), 'verified'); assert.equal(fills, 1);
  const broken = createLoginFillExecutor(registration, { withTarget: async () => { throw Error(value.password); } });
  assert.equal(await broken.dispatch(request, value, signal, () => true), 'unknown');
});
test('login entry rejects wrong kinds and extra private fields before host/storage', async () => {
  let calls = 0;
  const api = createLoginVault({ now: () => 2000, withAuthority: async () => { calls++; throw Error('UNEXPECTED'); } }, {});
  for (const value of [{ password: '' }, { password: 'valid', otp: '123456' }, { get password() { throw Error('GETTER'); } }, null]) {
    assert.equal(validateVaultLoginValue(value), false);
    assert.deepEqual(await api.capture({ sessionRef: 's'.repeat(32), revision: 1 }, value), { ok: false, code: 'invalid_payload' });
  }
  assert.equal(validateVaultLoginValue({ password: ' legitimate whitespace ' }), true);
  const request = { operation: 'vault.secure_entry', identity: fixture().request.identity, jobRevision: 2,
    requirement: { kind: 'secure_input', requirementRef: 'entry', revision: 1, actor: { kind: 'user', actorRef: 'user' } },
    origin: 'https://fixture.example', metadata: { kind: 'token', tokenType: 'api' }, effect: fixture().request.effect, issuedAt: 1000, expiresAt: 3000 };
  assert.deepEqual(await api.issue(request), { ok: false, code: 'invalid_payload' }); assert.equal(calls, 0);
});
