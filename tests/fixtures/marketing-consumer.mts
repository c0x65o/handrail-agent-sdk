import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Setup, Grant } from '@handrail/marketing/core';
import { MarketingServer, Store } from '@handrail/marketing/server';
import type { AgentPort, ProviderPort, GenerationPort } from '@handrail/marketing/server';
import type { ConnectionSnapshot, ConnectionStore, createVaultEntry } from 'handrail-agent-sdk/server';
import type { MarketingOnboardingResult } from 'handrail-agent-sdk/marketing';
import type { MarketingOnboardingHost, MetaRecipe, MetaPrivateValue } from 'handrail-agent-sdk/server/marketing';
import { marketingAgentPort, marketingExtension } from './marketing-onboarding.mjs';

const setup: Setup = { id: 'setup', projectId: 'project', revision: 1, grantId: 'grant', state: 'requested',
  reason: null, checkpoint: 'native_account_verification', verifiedAt: null, capabilities: [], accountId: '123', handoffUrl: null };
const grant: Grant = { id: 'grant', projectId: 'project', revision: 1, provider: 'meta', accountId: '123',
  label: 'Synthetic', currency: 'USD', timezone: 'UTC', permissions: ['setup', 'report'],
  expiresAt: '2030-01-01T00:00:00Z', revokedAt: null, secretRef: 'private-vault-reference' };
const originalSetup = structuredClone(setup), originalGrant = structuredClone(grant);
Object.freeze(setup.capabilities); Object.freeze(setup);
Object.freeze(grant.permissions); Object.freeze(grant);
test.afterEach(() => {
  assert.deepEqual(setup, originalSetup);
  assert.deepEqual(grant, originalGrant);
});
const recipe: MetaRecipe = {
  connection: { operation: 'connection.ensure', connectionRef: 'connection', providerRef: 'meta',
    prerequisiteVersion: 'meta-v1.2026-09-28', minimumCapabilities: ['meta.account.read', 'meta.report.read'], evidenceMode: 'fixture',
    effect: { effectRef: 'original-effect', actionRef: 'original-action', operationRef: 'original-operation' },
    identity: { jobId: 'job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1,
      host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'report' },
      native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
      origin: { channelRef: 'web', routeRef: 'owner', correlationRef: 'original' } } },
  provider: 'meta', appId: '456', appScopedUserId: '789', adAccountId: '123', permission: 'ads_read', apiVersion: 'v25.0',
  destination: { endpoint: 'https://graph.facebook.com/v25.0/act_123/insights', method: 'GET', resourceRef: 'account', redirects: 'deny' },
  redirectUri: 'https://host.invalid/private/meta/callback', expiresAt: 200_000,
};
const opaque = 'h'.repeat(32);
const handoffUrl = `https://host.invalid/marketing/connect/${opaque}`;
const unexpected = async (): Promise<never> => { throw Error('UNEXPECTED_PORT_CALL'); };
// Narrow call/response boundary fixtures, not a persistence implementation.
// Real encryption, SQL CAS, leases and unknown retention run in marketing-postgres.
function fixture() {
  const state: { approved: boolean; authenticated: boolean; approvals: number; issues: number; fences: string[];
    handoff: string | null; projection: MarketingOnboardingResult | null } = {
    approved: false, authenticated: true, approvals: 0, issues: 0, fences: [], handoff: null, projection: null };
  let snapshot: ConnectionSnapshot = { revision: 1, result: { request: recipe.connection,
    state: 'requested', authorization: { state: 'unverified' } }, credentials: null, verification: null, locallyRevoked: false };
  const host: MarketingOnboardingHost<Setup, Grant> = {
    now: () => 1000, handoffOrigin: 'https://host.invalid', isCurrent: () => state.authenticated,
    async withAuthority(s, g, _op, run) {
      assert.equal(s.id, setup.id); assert.equal(s.projectId, setup.projectId); assert.deepEqual(g, grant);
      if (!state.authenticated) return { state: 'blocked', reason: 'not_authorized' };
      return state.projection ?? run(recipe);
    },
    async approvePersistentAccess() { state.approvals++; return state.approved; },
    async entryRequest(r) { return { operation: 'vault.secure_entry', identity: r.connection.identity,
      jobRevision: 1, requirement: { kind: 'secure_input', requirementRef: 'consent', revision: 1, actor: { kind: 'user', actorRef: 'actor' } },
      origin: 'https://host.invalid', metadata: { kind: 'token', tokenType: 'api' }, effect: r.connection.effect,
      issuedAt: 1000, expiresAt: 100_000 }; },
    async handoff(_r, handle) { return handle ? opaque : state.handoff; },
    async fence(_r, reason) { state.fences.push(reason); return snapshot.revision; },
  };
  const connections: ConnectionStore = { admit: unexpected, reconnect: unexpected, rotate: unexpected,
    async load(r) { assert.deepEqual(r, recipe.connection); return { ok: true, value: snapshot }; },
    async revoke(r, revision) { assert.deepEqual(r, recipe.connection); assert.equal(revision, snapshot.revision);
      assert.ok(state.fences.length > 0); return { ok: true, value: snapshot }; } };
  const entry: Pick<ReturnType<typeof createVaultEntry<MetaPrivateValue>>, 'issue'> = {
    async issue(request) { state.issues++; assert.deepEqual(request.effect, recipe.connection.effect);
      return { ok: true, value: { sessionRef: 'e'.repeat(32), revision: 1 } }; },
  };
  return { state, host, connections, entry, setSnapshot: (value: ConnectionSnapshot) => { snapshot = value; },
    ...marketingAgentPort(host, connections, entry) };
}

// Public MarketingServer constructor accepts both example compositions, with
// no compatibility casts. This function is a compile-time integration witness.
function composeServer(store: ConstructorParameters<typeof MarketingServer>[0],
  providers: ConstructorParameters<typeof MarketingServer>[1], generation: ConstructorParameters<typeof MarketingServer>[2],
  native: Parameters<typeof marketingExtension>[0]) {
  return new MarketingServer(store, providers, generation, marketingExtension(native).agentPort, 'fixture');
}
void composeServer;

test('installed runtime exports and actual AgentPort compile and import without provider IO', async () => {
  for (const name of ['@handrail/marketing/core', '@handrail/marketing/server', '@handrail/marketing/react',
    'handrail-agent-sdk', 'handrail-agent-sdk/server', 'handrail-agent-sdk/marketing', 'handrail-agent-sdk/server/marketing'])
    await import(name);
  assert.deepEqual(Object.keys(await import('handrail-agent-sdk/marketing')), []);
  assert.deepEqual(Object.keys(await import('handrail-agent-sdk/server/marketing')).sort(),
    ['createMarketingOnboarding', 'createMetaOAuthCallback', 'createMetaVaultExecutor']);
  assert.equal((await import('@handrail/marketing/server')).MarketingServer, MarketingServer);
  const f = fixture();
  const port: AgentPort = f.agentPort;
  assert.deepEqual(await port.inspect(setup, grant), { state: 'blocked', reason: 'requires_consent', handoffUrl: null });
  assert.equal(f.state.approvals, 0); assert.equal(f.state.issues, 0);
});

test('all blocked reasons and read capability projection preserve the concrete Marketing vocabulary', async () => {
  const f = fixture();
  type Reason = Extract<MarketingOnboardingResult, { state: 'blocked' }>['reason'];
  const reasons: { [R in Reason]: R } = {
    not_authorized: 'not_authorized', unavailable: 'unavailable', requires_consent: 'requires_consent',
    provider_pending: 'provider_pending', reauthorization_required: 'reauthorization_required',
    unknown_effect: 'unknown_effect', synthetic_only: 'synthetic_only' };
  for (const reason of Object.values(reasons)) {
    f.state.projection = { state: 'blocked', reason };
    assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'blocked', reason, handoffUrl: null });
  }
  // Vocabulary-only seam probe, not provider evidence or a ready native store.
  f.state.projection = { state: 'ready', capabilities: ['meta.account.read', 'meta.report.read'] };
  assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'ready', reason: null, handoffUrl: null });
  assert.deepEqual(grant.permissions, ['setup', 'report']); assert.deepEqual(setup.capabilities, []);
});

test('ready projection requires both read capabilities and never emits authority', async () => {
  const f = fixture();
  for (const capabilities of [[], ['meta.account.read'], ['meta.report.read'], ['prepare', 'activate', 'billing']]) {
    f.state.projection = { state: 'ready', capabilities: ['meta.account.read', 'meta.report.read'] };
    // Deliberately malformed runtime host response, without a declaration cast.
    Reflect.set(f.state.projection, 'capabilities', capabilities);
    assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'unavailable', handoffUrl: null });
  }
  f.state.projection = { state: 'ready', capabilities: ['meta.account.read', 'meta.report.read'] };
  Reflect.set(f.state.projection, 'secretRef', grant.secretRef);
  assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'ready', reason: null, handoffUrl: null });
});

test('actual wrapper snapshots handoff inputs and rechecks authority after asynchronous reads', async () => {
  const f = fixture(), originalRecipe = structuredClone(recipe);
  f.state.approved = true;
  const issuedHandle = { sessionRef: 'e'.repeat(32), revision: 1 };
  f.entry.issue = async () => ({ ok: true, value: issuedHandle });
  f.host.handoff = async (r, handle) => {
    assert.notEqual(r, recipe); assert.notEqual(r.connection, recipe.connection);
    assert.notEqual(handle, issuedHandle);
    Reflect.set(r.connection.effect, 'effectRef', 'replacement-effect');
    if (handle) Reflect.set(handle, 'sessionRef', 'replacement-entry');
    await Promise.resolve();
    return opaque;
  };
  assert.deepEqual(await f.onboarding.requestAccess(setup, grant), { state: 'waiting_human', handoffUrl });
  assert.deepEqual(recipe, originalRecipe);
  assert.deepEqual(issuedHandle, { sessionRef: 'e'.repeat(32), revision: 1 });
  f.host.handoff = async () => { f.state.authenticated = false; return opaque; };
  assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'not_authorized', handoffUrl: null });
  const lost = fixture(), load = lost.connections.load;
  lost.connections.load = async r => { const result = await load(r); lost.state.authenticated = false; return result; };
  assert.deepEqual(await lost.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'not_authorized', handoffUrl: null });
});

test('real MarketingServer persists the adapter projection and independently verifies read capabilities', async t => {
  // Marketing's existing public SQL Store, no fake repository or reference host.
  // This SQLite composition check complements the separate Agent PostgreSQL/Vault suite.
  const dir = await mkdtemp(join(process.cwd(), 'marketing-sql-'));
  const store = new Store(join(dir, 'fixture.sqlite'));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true }); });
  await store.db.prepare('INSERT INTO projects VALUES(?,?)').run(setup.projectId, 'Synthetic bridge');
  const principal = await store.bindExternalPrincipal(setup.projectId, { issuer: 'fixture', subject: 'actor' }, 'admin');
  await store.put(setup.projectId, 'setup', setup.id, setup);
  await store.put(setup.projectId, 'grant', grant.id, grant);
  const f = fixture();
  let verifications = 0, reportAllowed = false;
  const provider: ProviderPort = {
    evidence: 'fixture', async verify(g) {
      verifications++; assert.deepEqual(g, grant);
      return { accountId: g.accountId, currency: g.currency, timezone: g.timezone,
        permissions: reportAllowed ? ['setup', 'report'] : ['setup'] };
    }, plan: unexpected, prepare: unexpected, activate: unexpected, pause: unexpected, reconcile: unexpected, metrics: unexpected,
  };
  const generation: GenerationPort = { evidence: 'fixture', validate: () => { throw Error('UNEXPECTED_GENERATION'); },
    submit: unexpected, reconcile: unexpected };
  const server = new MarketingServer(store, { meta: provider, google: provider, linkedin: provider }, generation, f.agentPort, 'fixture', () => 1000);
  let revision = setup.revision;
  async function resume() {
    const result = await server.resumeSetup(principal, setup.projectId, { setupId: setup.id, expectedRevision: revision });
    revision = result.revision;
    assert.deepEqual(await store.get<Setup>(setup.projectId, 'setup', setup.id), result);
    assert.deepEqual(await store.get<Grant>(setup.projectId, 'grant', grant.id), grant);
    assert.equal(JSON.stringify(result).includes(grant.secretRef), false);
    return result;
  }
  assert.equal((await resume()).reason, 'requires_consent');
  f.state.handoff = opaque;
  const waiting = await resume();
  assert.equal(waiting.state, 'waiting_human'); assert.equal(waiting.reason, 'provider_consent_required');
  assert.equal(waiting.handoffUrl, handoffUrl); assert.deepEqual(waiting.capabilities, []);
  assert.equal(verifications, 0);
  // Vocabulary-only ready seam; the fixture/native executor is still synthetic-only.
  f.state.projection = { state: 'ready', capabilities: ['meta.account.read', 'meta.report.read'] };
  const denied = await resume();
  assert.equal(denied.state, 'blocked'); assert.equal(denied.reason, 'provider_capability_missing');
  assert.deepEqual(denied.capabilities, []); assert.equal(denied.handoffUrl, null);
  reportAllowed = true;
  const ready = await resume();
  assert.equal(ready.state, 'ready'); assert.equal(ready.reason, null); assert.equal(ready.handoffUrl, null);
  assert.deepEqual(ready.capabilities, ['setup', 'report']); assert.equal(verifications, 2);
  f.state.projection = { state: 'blocked', reason: 'unknown_effect' };
  assert.equal((await resume()).reason, 'unknown_effect'); assert.equal(verifications, 2);
  f.state.authenticated = false;
  assert.equal((await resume()).reason, 'not_authorized'); assert.equal(verifications, 2);
  await assert.rejects(server.resumeSetup(principal, setup.projectId, { setupId: setup.id, expectedRevision: 1 }), /revision_conflict/);
});

test('synthetic human approval denial/acceptance and opaque authenticated waiting route', async () => {
  const f = fixture();
  assert.deepEqual(await f.onboarding.requestAccess(setup, grant), { state: 'blocked', reason: 'not_authorized' });
  assert.equal(f.state.issues, 0);
  f.state.approved = true;
  assert.deepEqual(await f.onboarding.requestAccess(setup, grant), { state: 'waiting_human', handoffUrl });
  assert.equal(f.state.approvals, 2); assert.equal(f.state.issues, 1);
  f.state.handoff = opaque;
  assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'waiting_human', reason: 'provider_consent_required', handoffUrl });
  assert.equal(f.state.issues, 1);
  f.state.authenticated = false;
  assert.equal((await f.agentPort.inspect(setup, grant)).reason, 'not_authorized');
});

test('cancel and revoke fence first; original unknown cannot be reset by reconnect or fresh wrapper', async () => {
  const f = fixture();
  assert.equal((await f.onboarding.cancel(setup, grant)).state, 'blocked');
  const unknown: ConnectionSnapshot = { revision: 2, result: { request: recipe.connection, state: 'unknown_effect', authorization: { state: 'unverified' },
    effect: { ...recipe.connection.effect, outcome: 'unknown' }, reconciliationRef: 'original-reconcile' },
    locallyRevoked: false, credentials: null, verification: null };
  const originalUnknown = structuredClone(unknown);
  f.setSnapshot(unknown);
  for (const method of ['inspect', 'reconnect', 'requestAccess', 'cancel', 'revoke'] as const)
    assert.deepEqual(await f.onboarding[method](setup, grant), { state: 'blocked', reason: 'unknown_effect' });
  const fresh = marketingAgentPort(f.host, f.connections, f.entry);
  assert.deepEqual(await fresh.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'unknown_effect', handoffUrl: null });
  assert.deepEqual(f.state.fences, ['cancel', 'cancel', 'revoke']); assert.equal(f.state.issues, 0);
  assert.deepEqual(unknown, originalUnknown);
});

test('fixture readiness stays blocked and raw state/code/token/redirects never enter output', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 1, locallyRevoked: false,
    credentials: { tokenRef: 'opaque-token', credentialRevision: 1, credentialExpiresAt: 100_000, grantRef: 'grant', grantRevision: 1, grantExpiresAt: 100_000 },
    verification: { credentialRevision: 1, grantRevision: 1 },
    result: { request: recipe.connection, state: 'ready', authorization: { state: 'active', expiresAt: 100_000 },
      evidence: { kind: 'api_capabilities', receiptRef: 'fixture-receipt', provenance: { kind: 'fixture', fixtureRef: 'fixture' },
        scope: recipe.connection.identity.host, providerRef: 'meta', prerequisiteVersion: recipe.connection.prerequisiteVersion,
        verifiedCapabilities: ['meta.account.read', 'meta.report.read'], verifiedAt: 1000, expiresAt: 100_000 } } });
  assert.deepEqual(await f.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'synthetic_only', handoffUrl: null });
  const privateValues = ['PRIVATE_CODE', 'PRIVATE_TOKEN', 's'.repeat(32), recipe.redirectUri, grant.secretRef];
  const errors = fixture();
  for (const value of privateValues) {
    errors.host.handoff = async () => { throw Error(value); };
    const output = await errors.agentPort.inspect(setup, grant);
    assert.deepEqual(output, { state: 'blocked', reason: 'unavailable', handoffUrl: null });
    assert.equal(JSON.stringify(output).includes(value), false);
    errors.host.handoff = async () => `https://provider.invalid/oauth?state=${value}`;
    assert.deepEqual(await errors.agentPort.inspect(setup, grant), { state: 'blocked', reason: 'unavailable', handoffUrl: null });
  }
});
