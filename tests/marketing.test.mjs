import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createMarketingOnboarding, createMetaOAuthCallback, createMetaVaultExecutor } from 'handrail-agent-sdk/server/marketing';
import { binding, fixture, clone, entryRequest } from './helpers/marketing-fixture.mjs';

test('optional imports are inert and browser contract contains no runtime exports', async () => {
  assert.deepEqual(Object.keys(await import('handrail-agent-sdk/marketing')), []);
  const untouched = new Proxy({}, { get() { throw Error('UNEXPECTED_IO'); } });
  createMarketingOnboarding(untouched, untouched, untouched);
  createMetaOAuthCallback(untouched, untouched);
});

test('distribution-only consumer resolves optional runtime and declarations through package exports', async t => {
  await mkdir('.reference-build', { recursive: true });
  const dir = await mkdtemp(resolve('.reference-build/marketing-consumer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = `${dir}/node_modules/handrail-agent-sdk`;
  await mkdir(pkg, { recursive: true });
  await writeFile(`${dir}/package.json`, JSON.stringify({ name: 'marketing-consumer-fixture', private: true, type: 'module' }));
  await cp('dist', `${pkg}/dist`, { recursive: true });
  await writeFile(`${pkg}/package.json`, await readFile('package.json'));
  await cp('examples/marketing-onboarding.mts', `${dir}/marketing-onboarding.mts`);
  await writeFile(`${dir}/consumer.mts`, `
    import { createMarketingOnboarding, createMetaOAuthCallback, createMetaVaultExecutor } from 'handrail-agent-sdk/server/marketing';
    import type { MarketingOnboardingPort } from 'handrail-agent-sdk/marketing';
    import type { ConnectionStore, VaultEntryStore } from 'handrail-agent-sdk/server';
    import type { MetaPrivateValue } from 'handrail-agent-sdk/server/marketing';
    import type { NativeMarketingPorts } from './marketing-onboarding.mjs';
    import { marketingExtension } from './marketing-onboarding.mjs';
    const compose = (native: NativeMarketingPorts<unknown, unknown>) => marketingExtension(native);
    void compose;
    const functions: readonly Function[] = [createMarketingOnboarding, createMetaOAuthCallback, createMetaVaultExecutor];
    const port: MarketingOnboardingPort<unknown, unknown> = { inspect: async () => ({state: 'blocked', reason: 'requires_consent'}) };
    function nativeStores(connection: ConnectionStore, entry: VaultEntryStore<MetaPrivateValue>) { return {connection, entry}; }
    void [functions, port, nativeStores];
  `);
  const compiled = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--strict',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--rootDir', dir, '--outDir', `${dir}/out`, `${dir}/consumer.mts`],
  { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  const imported = spawnSync(process.execPath, [`${dir}/out/consumer.mjs`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(imported.status, 0, imported.stderr);
});

test('synthetic exchange privately validates and bounds ads_read; only enums leave executor', async () => {
  const f = fixture();
  assert.equal(await f.dispatch(), 'verified');
  assert.deepEqual(f.state.calls, ['exchange', 'inspect', 'read']);
  assert.equal(f.state.expiresAt, 110_000);
  assert.equal(await f.executor().reconcile(f.b.request, f.controller.signal), 'verified');
  assert.equal(await f.dispatch(), 'unknown');
  assert.equal(f.state.calls.length, 3);
});

test('read-only token verification never exchanges or expands scope', async () => {
  const b = binding(); b.action = 'verify_read'; b.request.destination = clone(b.recipe.destination);
  const f = fixture(b);
  assert.equal(await f.executor().dispatch(b.request, { token: f.privateToken }, f.controller.signal, () => true), 'verified');
  assert.deepEqual(f.state.calls, ['inspect', 'read']);
});

for (const [name, mutate] of [
  ['wrong app', f => { f.inspection.appId = '999'; }],
  ['wrong provider user', f => { f.inspection.userId = '999'; }],
  ['wrong account', f => { f.read.accountId = '999'; }],
  ['wrong report account', f => { f.read.reportAccountIds = ['999']; }],
  ['missing scope', f => { f.inspection.scopes = ['public_profile']; }],
  ['revoked scope', f => { f.inspection.adsReadGranted = false; }],
  ['revoked token', f => { f.inspection.valid = false; }],
  ['wrong token class', f => { f.inspection.type = 'SYSTEM_USER'; }],
  ['expired token', f => { f.inspection.expiresAt = f.state.now; }],
  ['expired data access', f => { f.inspection.dataAccessExpiresAt = f.state.now; }],
  ['missing expiry', f => { delete f.inspection.expiresAt; }],
  ['nonfinite expiry', f => { f.inspection.expiresAt = Infinity; }],
  ['unbounded report', f => { f.read.reportAccountIds = ['123', '123']; }],
]) test(`private inspection denies ${name}`, async () => {
  const f = fixture(); mutate(f);
  assert.equal(await f.dispatch(), 'unknown'); assert.equal(f.state.retained, false);
  assert.ok(['provider_rejected', 'expired', 'scope_changed'].includes(f.state.invalidated));
});

test('explicit no-time-expiry metadata remains bounded by host approval', async () => {
  const f = fixture(); f.inspection.expiresAt = null; f.inspection.dataAccessExpiresAt = null;
  f.client.exchangeCode = async () => ({ token: f.privateToken, expiresAt: null });
  assert.equal(await f.dispatch(), 'verified'); assert.equal(f.state.expiresAt, f.b.recipe.expiresAt);
});

for (const dimension of ['tenantRef', 'userRef', 'projectRef', 'accountRef', 'environmentRef', 'purposeRef']) {
  test(`immutable executor rejects wrong ${dimension} before custody`, async () => {
    const f = fixture(), wrong = clone(f.b.request); wrong.identity.host[dimension] = 'other';
    assert.throws(() => f.executor().bind(wrong), { message: 'INVALID_META_BINDING' });
    assert.equal(await f.executor().dispatch(wrong, { token: f.privateCode }, f.controller.signal, () => true), 'unknown');
    assert.deepEqual(f.state.calls, []); assert.equal(f.state.attempted, false);
  });
}

for (const change of [
  b => { b.request.destination.endpoint += '?access_token=secret'; },
  b => { b.request.destination.method = 'POST'; },
  b => { b.recipe.permission = 'ads_management'; },
  b => { b.recipe.adAccountId = '../me'; },
  b => { b.recipe.redirectUri += '?code=secret'; },
  b => { b.recipe.connection.evidenceMode = 'provider'; },
  b => { b.qualification = 'provider'; },
]) test('unqualified or widened registration is rejected', () => {
  const f = fixture(); change(f.b);
  assert.throws(f.executor, { message: 'INVALID_META_BINDING' });
});

for (const phase of ['exchange', 'inspect', 'read', 'retain']) {
  test(`cancellation during ${phase} suppresses late success and reconnect never exchanges`, async () => {
    const f = fixture(); f.state.hook = async p => { if (p === phase) { f.state.current = false; f.controller.abort(); } };
    assert.equal(await f.dispatch(), 'unknown'); assert.equal(f.state.retained, false);
    assert.equal(await f.executor().reconcile(f.b.request, new AbortController().signal), 'unknown');
    f.state.current = true; f.controller = new AbortController();
    assert.equal(await f.executor().dispatch(f.b.request, { token: f.privateCode }, f.controller.signal, () => true), 'unknown');
    assert.equal(f.state.calls.filter(v => v === 'exchange').length, 1);
  });
}

test('unknown exchange and thrown errors are redacted and survive executor reconstruction', async () => {
  const f = fixture(); f.client.exchangeCode = async () => { f.state.calls.push('exchange'); throw Error(f.privateToken); };
  assert.equal(await f.dispatch(), 'unknown');
  const restarted = createMetaVaultExecutor(f.b, f.host, f.client, f.custody);
  assert.equal(await restarted.reconcile(f.b.request, f.controller.signal), 'unknown');
  assert.equal(await restarted.dispatch(f.b.request, { token: f.privateCode }, f.controller.signal, () => true), 'unknown');
  assert.equal(f.state.calls.length, 1);
  f.host.bind = () => { throw Error(f.privateToken); };
  assert.throws(() => restarted.bind(f.b.request), { message: 'INVALID_META_BINDING' });
});

test('private invalidation errors never escape the executor', async () => {
  const f = fixture(); f.inspection.valid = false;
  f.custody.invalidate = async () => { throw Error(f.privateToken); };
  assert.equal(await f.dispatch(), 'unknown'); assert.equal(f.state.retained, false);
});

function callbackFixture() {
  const b = binding(), request = entryRequest(b), state = { captures: 0, deliveries: 0, withdrawals: 0, now: 1000 };
  const session = { recipe: b.recipe, entryRequest: request, actorRef: 'actor', state: 's'.repeat(32), expiresAt: 100_000,
    entry: { sessionRef: 'e'.repeat(32), revision: 1 } };
  const host = { now: () => state.now, isCurrent: () => state.current !== false, withSession: async run => run(session) };
  const entry = { capture: async () => { state.captures++; return { ok: true, value: { request } }; },
    deliver: async () => { state.deliveries++; return { ok: true }; },
    withdraw: async () => { state.withdrawals++; return { ok: true }; } };
  return { session, state, host, entry, callback: createMetaOAuthCallback(host, entry),
    parameters: { state: session.state, code: 'SYNTHETIC_CODE' } };
}
test('private OAuth callback captures then delivers through existing Vault entry', async () => {
  const f = callbackFixture();
  assert.equal(await f.callback(f.session.recipe.redirectUri, f.parameters), 'captured');
  assert.equal(f.state.captures, 1); assert.equal(f.state.deliveries, 1);
});
for (const [name, change] of [
  ['wrong state', f => { f.parameters.state = 'wrong'; }],
  ['wrong redirect', f => { f.session.recipe.redirectUri += '/other'; }],
  ['wrong actor', f => { f.session.actorRef = 'other'; }],
  ['wrong project', f => { f.session.recipe.connection.identity.host.projectRef = 'other'; }],
  ['expired state', f => { f.state.now = f.session.expiresAt; }],
  ['code injection', f => { f.parameters.code = 'code\nsecret'; }],
]) test(`OAuth ${name} never captures`, async () => {
  const f = callbackFixture(), redirect = f.session.recipe.redirectUri; change(f);
  assert.equal(await f.callback(redirect, f.parameters), 'denied'); assert.equal(f.state.captures, 0);
});
test('denied consent closes private entry without interpreting provider error', async () => {
  const f = callbackFixture(); f.parameters.error = 'PRIVATE_PROVIDER_ERROR';
  assert.equal(await f.callback(f.session.recipe.redirectUri, f.parameters), 'denied');
  assert.equal(f.state.withdrawals, 1); assert.equal(f.state.captures, 0);
});

function bridgeFixture() {
  const b = binding(), state = { approvals: 0, issues: 0, fences: [], handoff: null, allow: true, now: 1000 };
  const snapshot = { revision: 1, result: { request: clone(b.recipe.connection), state: 'requested', authorization: { state: 'unverified' } },
    credentials: null, verification: null, locallyRevoked: false };
  const host = { now: () => state.now, isCurrent: () => state.allow, handoffOrigin: 'https://host.invalid',
    withAuthority: async (_s, _g, _op, run) => state.allow ? run(b.recipe) : { state: 'blocked', reason: 'not_authorized' },
    approvePersistentAccess: async () => { state.approvals++; return state.approved === true; },
    entryRequest: async () => entryRequest(b), handoff: async (_r, h) => h ? 'h'.repeat(32) : state.handoff,
    fence: async (_r, reason) => { state.fences.push(reason); return snapshot.revision; } };
  const connections = { load: async () => ({ ok: true, value: clone(snapshot) }),
    revoke: async () => ({ ok: true, value: clone(snapshot) }) };
  const entry = { issue: async () => { state.issues++; return { ok: true, value: { sessionRef: 'e'.repeat(32), revision: 1 } }; } };
  return { b, state, snapshot, host, connections, entry, bridge: createMarketingOnboarding(host, connections, entry) };
}
test('Marketing inspect is optional/read-only; persistent access needs explicit approval', async () => {
  const f = bridgeFixture();
  assert.equal((await f.bridge.inspect({}, {})).reason, 'requires_consent');
  assert.equal(f.state.approvals, 0); assert.equal(f.state.issues, 0);
  assert.equal((await f.bridge.requestAccess({}, {})).reason, 'not_authorized');
  assert.equal(f.state.issues, 0); f.state.approved = true;
  assert.deepEqual(await f.bridge.requestAccess({}, {}), { state: 'waiting_human', handoffUrl: `https://host.invalid/marketing/connect/${'h'.repeat(32)}` });
  assert.equal(f.state.issues, 1);
});
test('native denial wins over caller setup/grant strings', async () => {
  const f = bridgeFixture(); f.state.allow = false;
  assert.equal((await f.bridge.requestAccess({ approved: true }, { state: 'active' })).reason, 'not_authorized');
  assert.equal(f.state.approvals, 0);
});
test('unknown original effect survives reconnect, cancel and local revoke without approval or exchange', async () => {
  const f = bridgeFixture(); f.snapshot.result = { ...f.snapshot.result, state: 'unknown_effect',
    effect: { ...f.b.request.effect, outcome: 'unknown' }, reconciliationRef: 'original-reconcile' };
  for (const method of ['inspect', 'reconnect', 'requestAccess', 'cancel', 'revoke'])
    assert.equal((await f.bridge[method]({}, {})).reason, 'unknown_effect');
  assert.deepEqual(f.state.fences, ['cancel', 'revoke']); assert.equal(f.state.approvals, 0);
});
test('synthetic evidence never makes a Marketing connection ready', async () => {
  const f = bridgeFixture(); f.snapshot.credentials = { tokenRef: 'opaque-token', credentialRevision: 1, credentialExpiresAt: 100_000,
    grantRef: 'grant', grantRevision: 1, grantExpiresAt: 100_000 };
  f.snapshot.verification = { credentialRevision: 1, grantRevision: 1 };
  f.snapshot.result = { request: clone(f.b.recipe.connection), state: 'ready', authorization: { state: 'active', expiresAt: 100_000 },
    evidence: { kind: 'api_capabilities', receiptRef: 'receipt', provenance: { kind: 'fixture', fixtureRef: 'fixture' },
      scope: clone(f.b.request.identity.host), providerRef: 'meta', prerequisiteVersion: f.b.recipe.connection.prerequisiteVersion,
      verifiedCapabilities: ['meta.account.read', 'meta.report.read'], verifiedAt: 1000, expiresAt: 100_000 } };
  assert.equal((await f.bridge.inspect({}, {})).reason, 'synthetic_only');
  f.snapshot.credentials.grantExpiresAt = 1000;
  assert.equal((await f.bridge.inspect({}, {})).reason, 'reauthorization_required');
});
test('cancel/revoke remain available after approval expiry', async () => {
  const f = bridgeFixture(); f.state.now = f.b.recipe.expiresAt;
  assert.equal((await f.bridge.revoke({}, {})).reason, 'reauthorization_required'); assert.deepEqual(f.state.fences, ['revoke']);
});

test('browser conditions reject the server entrypoint while public contracts stay inert', () => {
  const result = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    assert.deepEqual(Object.keys(await import('handrail-agent-sdk/marketing')), []);
    await assert.rejects(import('handrail-agent-sdk/server/marketing'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

for (const phase of ['load', 'approval', 'entryRequest', 'issue', 'handoff']) {
  test(`onboarding rejects authority lost during ${phase}`, async () => {
    const f = bridgeFixture(); f.state.approved = true;
    const [port, name] = phase === 'load' ? [f.connections, 'load']
      : phase === 'approval' ? [f.host, 'approvePersistentAccess']
      : phase === 'issue' ? [f.entry, 'issue'] : [f.host, phase];
    const original = port[name];
    port[name] = async (...args) => { const result = await original(...args); f.state.allow = false; return result; };
    assert.equal((await f.bridge.requestAccess({ approved: true }, {})).reason, 'not_authorized');
    assert.equal(f.state.issues, ['issue', 'handoff'].includes(phase) ? 1 : 0);
  });
}
for (const phase of ['capture', 'deliver']) {
  for (const reason of ['revocation', 'expiry']) {
    test(`OAuth ${reason} during ${phase} suppresses delivery or late success`, async () => {
      const f = callbackFixture(), original = f.entry[phase];
      f.entry[phase] = async (...args) => {
        const result = await original(...args);
        if (reason === 'expiry') f.state.now = f.session.expiresAt; else f.state.current = false;
        return result;
      };
      assert.equal(await f.callback(f.session.recipe.redirectUri, f.parameters), 'denied');
      assert.equal(f.state.deliveries, phase === 'capture' ? 0 : 1);
    });
  }
}
test('OAuth snapshots original session and entry through asynchronous capture', async () => {
  const f = callbackFixture(), original = clone(f.session), delivered = [];
  f.entry.capture = async handle => {
    f.session.entry.sessionRef = 'x'.repeat(32);
    f.session.recipe.connection.effect.effectRef = 'replacement';
    handle.sessionRef = 'y'.repeat(32);
    return { ok: true, value: { request: original.entryRequest } };
  };
  f.host.isCurrent = s => { assert.deepEqual(s, original); return true; };
  f.entry.deliver = async handle => { delivered.push(handle); return { ok: true }; };
  assert.equal(await f.callback(original.recipe.redirectUri, f.parameters), 'captured');
  assert.deepEqual(delivered, [original.entry]);
});
test('OAuth snapshots query parameters before asynchronous session lookup', async () => {
  const f = callbackFixture();
  f.host.withSession = async run => { f.parameters.state = 'changed'; f.parameters.code = 'changed'; return run(f.session); };
  f.entry.capture = async (_h, value) => {
    assert.equal(value.token, 'SYNTHETIC_CODE'); return { ok: true, value: { request: f.session.entryRequest } };
  };
  assert.equal(await f.callback(f.session.recipe.redirectUri, f.parameters), 'captured');
});
for (const phase of ['before', 'after']) {
  test(`reconciliation rechecks factual-read authority ${phase} private I/O`, async () => {
    const f = fixture(); f.state.retained = true; let reads = 0;
    f.host.isCurrent = (_binding, mode) => { assert.equal(mode, 'reconcile'); return f.state.current; };
    if (phase === 'before') f.state.current = false;
    f.custody.reconcile = async () => { reads++; f.state.current = false; return 'verified'; };
    assert.equal(await f.executor().reconcile(f.b.request, f.controller.signal), 'unknown');
    assert.equal(reads, phase === 'before' ? 0 : 1);
  });
}
test('factual reconciliation after Stop/expiry never permits another dispatch', async () => {
  const f = fixture(); assert.equal(await f.dispatch(), 'verified');
  f.state.now = f.b.recipe.expiresAt; f.state.current = false;
  f.host.isCurrent = (_binding, phase) => phase === 'reconcile';
  assert.equal(await f.executor().reconcile(f.b.request, f.controller.signal), 'verified');
  assert.equal(await f.dispatch(), 'unknown'); assert.equal(f.state.calls.length, 3);
});
test('private input and exchange result cannot be swapped across custody/client awaits', async () => {
  const f = fixture(), value = { token: f.privateCode }, exchange = { token: f.privateToken, expiresAt: 130_000 };
  f.custody.claimDispatch = async () => { value.token = 'SWAPPED_CODE'; return true; };
  f.client.exchangeCode = async (_recipe, token) => { assert.equal(token, f.privateCode); return exchange; };
  f.client.inspectToken = async () => { exchange.token = 'SWAPPED_TOKEN'; return f.inspection; };
  f.client.verifyAdsRead = async (_recipe, token) => { assert.equal(token, f.privateToken); return f.read; };
  assert.equal(await f.executor().dispatch(f.b.request, value, f.controller.signal, () => true), 'verified');
});
test('refresh tokens and extra recipe payloads cannot register as the code/API-token adapter', () => {
  for (const change of [b => { b.request.item.metadata.tokenType = 'refresh'; }, b => { b.recipe.secret = 'UNEXPECTED'; }]) {
    const f = fixture(); change(f.b); assert.throws(f.executor, { message: 'INVALID_META_BINDING' });
  }
});
test('missing or nonboolean current-authority guards fail closed', async () => {
  const f = bridgeFixture(); delete f.host.isCurrent;
  assert.equal((await f.bridge.inspect({}, {})).reason, 'unavailable');
  const c = callbackFixture(); c.host.isCurrent = () => 'true';
  assert.equal(await c.callback(c.session.recipe.redirectUri, c.parameters), 'denied');
  assert.equal(c.state.captures, 0);
  const e = fixture(); e.host.isCurrent = () => 'true';
  assert.equal(await e.dispatch(), 'unknown'); assert.deepEqual(e.state.calls, []);
});

function readyBridgeFixture() {
  const f = bridgeFixture(); f.b.recipe.connection.evidenceMode = 'provider';
  f.snapshot.credentials = { tokenRef: 'opaque-token', credentialRevision: 1, credentialExpiresAt: 100_000,
    grantRef: 'grant', grantRevision: 1, grantExpiresAt: 100_000 };
  f.snapshot.verification = { credentialRevision: 1, grantRevision: 1 };
  // Synthetic host-contract fixture only; never stored as live provider evidence.
  f.snapshot.result = { request: clone(f.b.recipe.connection), state: 'ready', authorization: { state: 'active', expiresAt: 100_000 },
    evidence: { kind: 'api_capabilities', receiptRef: 'receipt', provenance: { kind: 'provider', verificationRef: 'synthetic-host-receipt' },
      scope: clone(f.b.request.identity.host), providerRef: 'meta', prerequisiteVersion: f.b.recipe.connection.prerequisiteVersion,
      verifiedCapabilities: ['meta.account.read', 'meta.report.read'], verifiedAt: 1000, expiresAt: 100_000 } };
  return f;
}
test('ready projection requires current native credential facts, not just a receipt shape', async () => {
  assert.equal((await readyBridgeFixture().bridge.inspect({}, {})).state, 'ready');
  for (const change of [
    s => { delete s.credentials.credentialExpiresAt; },
    s => { s.credentials.grantExpiresAt = Infinity; },
    s => { s.credentials.credentialRevision = s.verification.credentialRevision = 0; },
    s => { delete s.credentials.tokenRef; },
    s => { delete s.locallyRevoked; },
  ]) {
    const f = readyBridgeFixture(); change(f.snapshot);
    assert.equal((await f.bridge.inspect({}, {})).reason, 'reauthorization_required');
  }
});
test('ready projection cannot escape authority loss during the native connection read', async () => {
  const f = readyBridgeFixture(), load = f.connections.load;
  f.connections.load = async () => { const result = await load(); f.state.allow = false; return result; };
  assert.equal((await f.bridge.inspect({}, {})).reason, 'not_authorized');
});
test('failed or ambiguous durable claims never dispatch, and concurrent attempts have one winner', async () => {
  for (const claim of [false, undefined, 'true']) {
    const f = fixture(); f.custody.claimDispatch = async () => claim;
    assert.equal(await f.dispatch(), 'unknown'); assert.deepEqual(f.state.calls, []);
  }
  const f = fixture();
  assert.deepEqual((await Promise.all([f.dispatch(), f.dispatch()])).sort(), ['unknown', 'verified']);
  assert.equal(f.state.calls.filter(c => c === 'exchange').length, 1);
});

test('entry expiry during issue prevents even creating a handoff', async () => {
  const f = bridgeFixture(); f.state.approved = true;
  f.entry.issue = async request => {
    f.state.now = request.expiresAt;
    request.expiresAt = f.b.recipe.expiresAt;
    return { ok: true, value: { sessionRef: 'e'.repeat(32), revision: 1 } };
  };
  let handoffs = 0; f.host.handoff = async () => { handoffs++; return 'h'.repeat(32); };
  assert.equal((await f.bridge.requestAccess({}, {})).reason, 'not_authorized');
  assert.equal(handoffs, 0);
});

test('malformed exchange deadlines cannot normalize to the explicit no-expiry sentinel', async () => {
  for (const expiresAt of [undefined, NaN, Infinity, -Infinity]) {
    const f = fixture(); f.client.exchangeCode = async () => ({ token: f.privateToken, expiresAt });
    assert.equal(await f.dispatch(), 'unknown'); assert.equal(f.state.retained, false);
    assert.equal(f.state.invalidated, 'provider_rejected');
  }
});
