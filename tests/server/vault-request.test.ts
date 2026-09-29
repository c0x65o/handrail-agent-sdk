import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createPostgresHarness } from '../helpers/postgres.js';
import { migrations } from '../helpers/migrations.mjs';
import { createVaultRequestExecutor } from '../../src/server/vault-request.js';
import type { VaultRequestRecipe, VaultTokenRequest, VaultHttpClient } from '../../src/server/vault-request.js';
import { createVaultUse } from '../../src/server/vault-use.js';
import type { VaultUseHost, VaultItemGrant } from '../../src/server/vault-use.js';
import { validateVaultOperationSchema } from '../../src/contracts/vault.js';
import type { JobStoreResult } from '../../src/server/job-store.js';
import { createJobLease } from '../../src/server/job-lease.js';
import { createJobLeaseStore } from '../../reference/node/job-lease.js';
import { createJobJournal } from '../../reference/node/job-journal.js';
import { createVaultStore } from '../../reference/node/vault-store.js';
import type { VaultValue } from '../../reference/node/vault-store.js';
import { createVaultGrants, vaultEffectRequest } from '../../reference/node/vault-grants.js';
import { journalTables, vaultTables } from '../../reference/node/db/schema.js';

// Never print private assertion operands, HTTP exceptions or driver errors to TAP.
function acceptance(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, async t => { try { await run(t); } catch { throw Error('VAULT_REQUEST_ACCEPTANCE_FAILED'); } });
}
function ok<T>(r: JobStoreResult<T>): T { if (!r.ok) throw Error('EXPECTED_SUCCESS'); return r.value; }
const identity = { jobId: 'request-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' } };

async function server(t: TestContext, run: http.RequestListener) {
  const s = http.createServer(run); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(async () => { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); });
  return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/operation`;
}
/** Disposable HTTP-only adapter. Connects without credentials, then uses the
 * exact inspected socket. Node's low-level client has no redirect/retry logic. */
function loopbackClient(): VaultHttpClient {
  return {
    resolve: async () => ['127.0.0.1'],
    async withConnection(endpoint, address, signal, run) {
      const url = new URL(endpoint);
      const socket = net.connect({ host: address, port: Number(url.port), signal });
      socket.on('error', () => {});
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const requests: http.ClientRequest[] = [];
      try {
        await once(socket, 'connect', { signal });
        return await run({ endpoint, address: socket.remoteAddress!, port: socket.remotePort!,
          async send(input, signal) {
            assert.equal(input.redirects, 'deny'); assert.equal(input.retries, 0);
            const req = http.request(url, { method: input.method, headers: input.headers, signal,
              agent, maxHeaderSize: input.maxHeaderBytes });
            requests.push(req); req.on('error', () => {});
            const response = once(req, 'response', { signal }); req.end(input.body);
            const [res] = await response as [http.IncomingMessage];
            return { status: res.statusCode!, body: res };
          } });
      } finally { for (const req of requests) req.destroy(); agent.destroy(); socket.destroy(); }
    },
  };
}

async function setup(t: TestContext, mode = 'success') {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const db = await harness.client(); await migrations(t, harness, db);
  const other = await harness.client();
  const tables = journalTables(harness.schema), journal = createJobJournal(db.database(), tables);
  const state = { now: Date.now(), calls: 0, diverted: 0, expectedAuth: false, privateReads: 0,
    reconciled: 'not_applied' as 'not_applied' | 'unknown' | 'verified', beforePhase: async (_phase: string) => {} };
  const host: VaultUseHost = { now: () => state.now, withAuthority: async (_r, phase, run) => {
    await state.beforePhase(phase);
    return run({ host: identity.host, actorRef: identity.host.userRef, grantRevision: 1, cancellationRevision: 0 });
  } };
  ok(await journal.append({ kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } }));
  const lease = createJobLease({ now: host.now, newOwnerToken: () => 'fixture-worker', withAuthority: async (_i, _o, run) =>
    run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 }) }, createJobLeaseStore(db.database(), tables));
  const fence = ok(await lease.claim(identity, 60_000))!;
  ok(await lease.append({ kind: 'started', previousRevision: 1, snapshot: { identity, revision: 2, state: 'running', effects: [] } }, fence));
  const secret = randomBytes(24).toString('hex'), key = createSecretKey(randomBytes(32));
  const keys = { active: async () => ({ keyHandle: 'fixture-key', keyVersion: 1 }), resolve: async () => { state.privateReads++; return key; } };
  const item: VaultTokenRequest['item'] = { metadata: { kind: 'token', tokenType: 'api' }, reference: { kind: 'secret', itemRef: 'token-item', revision: 1 } };
  ok(await createVaultStore(db.database(), { authorize: async () => identity.host }, keys, vaultTables(harness.schema)).create(item, { token: secret }));
  state.privateReads = 0;
  const destination: VaultTokenRequest['destination'] = { endpoint: 'https://fixture.invalid/operation', method: 'POST', resourceRef: 'account-alias', redirects: 'deny' };
  const request: VaultTokenRequest = { identity, jobRevision: 2, grantRef: 'request-grant', grantRevision: 1,
    effect: { effectRef: 'request-effect', actionRef: 'verify-action', operationRef: 'registered-request' }, operation: 'server_request', item, destination };
  const owner = { now: () => state.now, withOwner: async <T>(_item: unknown, _action: unknown, run: (s: typeof identity.host) => Promise<JobStoreResult<T>>) => run(identity.host) };
  const grants = createVaultGrants(db.database(), owner, keys, harness.schema), second = createVaultGrants(other.database(), owner, keys, harness.schema);
  const grant: VaultItemGrant = { request, issuedAt: state.now, expiresAt: state.now + 30_000, state: 'active',
    permissions: { use: true, reveal: false, export: false }, itemExpiresAt: state.now + 60_000, taskExpiresAt: state.now + 60_000 };
  ok(await grants.administration.put(grant, 0));
  const diverted = await server(t, (_req, res) => { state.diverted++; res.end(); });
  const endpoint = await server(t, (req, res) => {
    state.calls++; state.expectedAuth = req.headers.authorization === `Bearer ${secret}`; state.reconciled = 'unknown';
    req.resume(); res.setHeader('x-reflected-secret', secret);
    if (mode === 'redirect') { res.writeHead(302, { location: `${diverted}?reflected=${secret}` }); res.end(secret); }
    else if (mode === 'error') { res.writeHead(401); res.end(secret); }
    else if (mode === 'lost') req.socket.destroy();
    else if (mode === 'timeout') { /* Wait for client abort. */ }
    else if (mode === 'large') res.end('x'.repeat(8192));
    else res.end(JSON.stringify({ ready: true, raw: secret, encoded: Buffer.from(secret).toString('base64') }));
  });
  const recipe: VaultRequestRecipe<VaultValue> = { operationRef: request.effect.operationRef, recipeRevision: 1, destination,
    maxRequestBytes: 4096, maxResponseBytes: 1024, body: '{}',
    fixture: { kind: 'disposable_loopback', endpoint, environmentRef: 'fixture' },
    bind: (r, binding) => ({ ...vaultEffectRequest(r, 'fixture-account-namespace'),
      requestDigest: `sha256:${createHash('sha256').update(JSON.stringify([r, binding])).digest('hex')}` }),
    token: value => (value as { token: string }).token,
    verify: body => JSON.parse(new TextDecoder().decode(body)).ready === true,
    reconcile: async () => state.reconciled };
  const client = loopbackClient();
  const use = (r = recipe, c = client, timeout = 1000) => createVaultUse(host, grants.use, [createVaultRequestExecutor(r, c)], timeout);
  async function scan(...outputs: unknown[]) {
    const rows: unknown[] = [...outputs];
    for (const table of ['vault_access', 'vault_item_grants', 'job_effects', 'jobs', 'job_events']) rows.push((await db.query(`SELECT * FROM ${harness.table(table)}`)).rows);
    const text = JSON.stringify(rows);
    assert.equal([secret, Buffer.from(secret).toString('base64'), endpoint, diverted].some(v => text.includes(v)), false);
  }
  return { state, request, grant, grants, second, recipe, client, use, fence, scan, secret, endpoint, host, journal };
}

acceptance('registered destination alone receives authorization; reflected headers/body never enter receipts or SQL; durable replay dispatches once', async t => {
  const s = await setup(t), use = s.use();
  const result = ok(await use.execute(s.request, s.fence));
  assert.deepEqual(result, { outcome: 'verified', receiptRef: 'request-effect' });
  assert.equal(s.state.expectedAuth, true); assert.equal(s.state.diverted, 0);
  // Reconstruct the executor to prove replay is durable, not a process-local map.
  assert.deepEqual(ok(await s.use().execute(s.request, s.fence)), result); assert.equal(s.state.calls, 1);
  await s.scan(result, ok(await s.grants.administration.history(s.request.item)));
  t.diagnostic('Disposable HTTP + PostgreSQL receipt=request-effect; authorized_requests=1; redirect_target_requests=0; replay_requests=0; raw_output_fields=0.');
});

for (const mode of ['redirect', 'error', 'lost', 'timeout', 'large']) acceptance(`${mode}: unknown survives duplicate delivery; no forwarding or blind retry; reconciliation survives revoke`, async t => {
  const s = await setup(t, mode), use = s.use(s.recipe, s.client, mode === 'timeout' ? 100 : 1000);
  const first = ok(await use.execute(s.request, s.fence)); assert.deepEqual(first, { outcome: 'unknown' });
  assert.equal(s.state.calls, 1); assert.equal(s.state.expectedAuth, true); assert.equal(s.state.diverted, 0);
  assert.deepEqual(ok(await use.execute(s.request, s.fence)), first); assert.equal(s.state.calls, 1);
  ok(await s.second.administration.revoke(s.request.item, s.request.grantRef, 1));
  s.state.reconciled = 'verified';
  const reconciled = ok(await use.reconcile(s.request));
  assert.deepEqual(reconciled, { outcome: 'verified', receiptRef: 'request-effect' }); assert.equal(s.state.calls, 1);
  await s.scan(first, reconciled);
});

acceptance('revocation between admission and dispatch prevents custody and all HTTP requests', async t => {
  const s = await setup(t);
  s.state.beforePhase = async phase => { if (phase === 'dispatch') ok(await s.second.administration.revoke(s.request.item, s.request.grantRef, 1)); };
  assert.equal((await s.use().execute(s.request, s.fence)).ok, false);
  assert.equal(s.state.privateReads, 0); assert.equal(s.state.calls, 0); await s.scan();
});

acceptance('expiry during DNS preparation prevents transmission of the resolved token', async t => {
  const s = await setup(t);
  const client = { ...s.client, resolve: async () => { s.state.now = s.grant.expiresAt; return ['127.0.0.1']; } };
  await s.use(s.recipe, client).execute(s.request, s.fence);
  assert.equal(s.state.calls, 0); await s.scan();
});

acceptance('address policy rejects private, metadata, multicast, mapped IPv6, noncanonical and mixed DNS answers before connect', async t => {
  const s = await setup(t); let connects = 0;
  const recipe = { ...s.recipe, fixture: undefined };
  for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['172.16.0.1'], ['192.168.1.1'], ['169.254.169.254'], ['100.100.100.200'],
    ['0.0.0.0'], ['224.0.0.1'], ['198.18.0.1'], ['192.0.0.1'], ['168.63.129.16'], ['::1'], ['::ffff:127.0.0.1'], ['0177.0.0.1'], ['8.8.8.8', '10.0.0.1'], []]) {
    const client: VaultHttpClient = { resolve: async () => addresses, withConnection: async () => { connects++; throw Error('UNEXPECTED_CONNECT'); } };
    const executor = createVaultRequestExecutor(recipe, client);
    assert.equal(await executor.dispatch(s.request, { token: s.secret }, new AbortController().signal, () => true), 'unknown');
  }
  assert.equal(connects, 0); assert.equal(s.state.calls, 0);
});

acceptance('actual peer, scheme, host and port mismatches cannot receive credentials; client callbacks cannot dispatch twice', async t => {
  const s = await setup(t);
  let sends = 0;
  for (const change of [{ endpoint: 'http://attacker.invalid/operation' }, { endpoint: s.endpoint.replace('http:', 'https:') },
    { port: 1 }, { address: '169.254.169.254' }]) {
    const client: VaultHttpClient = { resolve: async () => ['127.0.0.1'], withConnection: async (_e, _a, _s, run) => run({
      endpoint: s.endpoint, address: '127.0.0.1', port: Number(new URL(s.endpoint).port), ...change,
      send: async () => { sends++; throw Error('UNEXPECTED_SEND'); } }) };
    assert.equal(await createVaultRequestExecutor(s.recipe, client).dispatch(s.request, { token: s.secret }, new AbortController().signal, () => true), 'unknown');
  }
  assert.equal(sends, 0);
  const client: VaultHttpClient = { ...s.client, withConnection: (e, a, signal, run) => s.client.withConnection(e, a, signal,
    async connection => { const result = await run(connection); await run(connection); return result; }) };
  assert.equal(ok(await s.use(s.recipe, client).execute(s.request, s.fence)).outcome, 'verified'); assert.equal(s.state.calls, 1);
});

acceptance('public HTTP override, model headers/body, unregistered destination, fixture environment and changed recipe cannot reuse an effect', async t => {
  const s = await setup(t);
  assert.equal(validateVaultOperationSchema({ ...s.request, destination: { ...s.request.destination, endpoint: s.endpoint } }).ok, false);
  for (const input of [{ ...s.request, body: 'model-body' }, { ...s.request, headers: { authorization: 'model-header' } },
    { ...s.request, destination: { ...s.request.destination, endpoint: 'https://other.invalid/operation' } }]) {
    assert.equal((await s.use().execute(input as VaultTokenRequest, s.fence)).ok, false);
  }
  const wrongEnvironment = { ...s.recipe, fixture: { ...s.recipe.fixture!, environmentRef: 'production' } };
  assert.equal((await s.use(wrongEnvironment).execute(s.request, s.fence)).ok, false); assert.equal(s.state.calls, 0);
  ok(await s.use().execute(s.request, s.fence));
  assert.equal((await s.use({ ...s.recipe, body: '{"changed":true}', recipeRevision: 2 }).execute(s.request, s.fence)).ok, false);
  assert.equal(s.state.calls, 1); await s.scan();
});

acceptance('reflected exceptions and payload-shaped verifier returns cannot escape or produce verified receipts', async t => {
  for (const mode of ['exception', 'payload']) {
    const s = await setup(t);
    const recipe = { ...s.recipe, verify: () => {
      if (mode === 'exception') throw Error(s.secret);
      return { ready: true, raw: s.secret } as unknown as boolean;
    } };
    const result = ok(await s.use(recipe).execute(s.request, s.fence)); assert.deepEqual(result, { outcome: 'unknown' }); await s.scan(result);
  }
});

acceptance('timeout while resolving never starts a late connection; request byte limit withholds oversized token', async t => {
  const s = await setup(t); let release!: (addresses: string[]) => void, connects = 0;
  const waiting = new Promise<string[]>(r => { release = r; });
  const client: VaultHttpClient = { resolve: () => waiting, withConnection: async () => { connects++; throw Error('LATE_CONNECT'); } };
  const result = ok(await s.use(s.recipe, client, 30).execute(s.request, s.fence)); assert.deepEqual(result, { outcome: 'unknown' });
  release(['127.0.0.1']); await new Promise(r => setTimeout(r, 20)); assert.equal(connects, 0);
  const bounded = createVaultRequestExecutor({ ...s.recipe, maxRequestBytes: 32 }, s.client);
  assert.equal(await bounded.dispatch(s.request, { token: s.secret }, new AbortController().signal, () => true), 'unknown');
  assert.equal(s.state.calls, 0); await s.scan(result);
});

acceptance('public HTTPS policy pins a canonical routable address and rejects a changed socket peer before sending', async t => {
  const s = await setup(t), recipe = { ...s.recipe, fixture: undefined }; let sends = 0, connected = 0;
  const client: VaultHttpClient = { resolve: async hostname => { assert.equal(hostname, 'fixture.invalid'); return ['8.8.8.8']; },
    async withConnection(endpoint, address, _signal, run) {
      connected++; assert.equal(endpoint, recipe.destination.endpoint); assert.equal(address, '8.8.8.8');
      return run({ endpoint, address: connected === 1 ? address : '127.0.0.1', port: 443,
        async send(input) {
          sends++; assert.equal(input.headers.authorization === `Bearer ${s.secret}`, true);
          assert.equal(input.effect.idempotencyRef, 'request-effect');
          return { status: 200, body: (async function* () { yield new TextEncoder().encode('{"ready":true}'); })() };
        } });
    } };
  const executor = createVaultRequestExecutor(recipe, client), signal = new AbortController().signal;
  assert.equal(await executor.dispatch(s.request, { token: s.secret }, signal, () => true), 'verified');
  assert.equal(await executor.dispatch(s.request, { token: s.secret }, signal, () => true), 'unknown');
  assert.equal(sends, 1); assert.equal(s.state.calls, 0);
  t.diagnostic('Public-address policy uses an injected transport fixture; no public network connection.');
});

acceptance('invalid fixture registrations, token header injection and secret-bearing client exceptions fail closed', async t => {
  const s = await setup(t);
  for (const endpoint of ['http://169.254.169.254/operation', 'http://localhost:1234/operation', 'https://127.0.0.1:1234/operation',
    'http://127.0.0.1:1234/operation?token=forbidden', 'http://user@127.0.0.1:1234/operation']) {
    let rejected = false;
    try { createVaultRequestExecutor({ ...s.recipe, fixture: { ...s.recipe.fixture!, endpoint } }, s.client); } catch { rejected = true; }
    assert.equal(rejected, true);
  }
  const executor = createVaultRequestExecutor(s.recipe, s.client);
  assert.equal(await executor.dispatch(s.request, { token: `${s.secret}\r\nx-extra: forbidden` }, new AbortController().signal, () => true), 'unknown');
  assert.equal(s.state.calls, 0);
  const client: VaultHttpClient = { ...s.client, withConnection: async () => { throw Error(`${s.endpoint}?secret=${s.secret}`); } };
  const result = ok(await s.use(s.recipe, client).execute(s.request, s.fence));
  assert.deepEqual(result, { outcome: 'unknown' }); await s.scan(result);
});
