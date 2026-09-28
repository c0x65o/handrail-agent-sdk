import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { createPaymentVault } from '../.reference-build/src/server/payment-vault.js';
import { createVaultEntry } from '../.reference-build/src/server/vault-entry.js';
import { createVaultEntryStore } from '../.reference-build/reference/node/vault-entry.js';
import { createVaultStore } from '../.reference-build/reference/node/vault-store.js';
import { createVaultLifecycle } from '../.reference-build/reference/node/vault-lifecycle.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
import { vaultTables } from '../.reference-build/reference/node/db/schema.js';
import { validateVaultEntryRequest, validateVaultItem, validateVaultOperationSchema } from '../.reference-build/src/contracts/vault.js';
import { migrations } from './helpers/migrations.mjs';
import { services, start, ok } from './helpers/effect-fixture.mjs';
import { identity, requirement, entryState, entryServices } from './helpers/vault-entry-fixture.mjs';

const denied = result => assert.equal(result.ok, false, 'operation denied without private details');
const registration = { adapterRef: 'synthetic-payment-boundary', version: 'fixture-1',
  environmentRef: identity.host.environmentRef, qualification: 'synthetic_boundary_only' };

// Explicit external-service fake. This is NOT a selected provider adapter and
// cannot establish its authentication, retention or production guarantees.
function syntheticAdapter(state) {
  const sessions = new Map();
  let authenticated;
  const custody = { adapterRef: randomUUID() };
  // Disposable canaries exist only in fixture memory, never in retained receipts.
  const pan = `9${Array.from(randomBytes(15), b => b % 10).join('')}`;
  const cvv = `0${Array.from(randomBytes(3), b => b % 10).join('')}`;
  const providerToken = randomBytes(32).toString('hex');
  const adapter = {
    async open(session) {
      const previous = sessions.get(session.handle.sessionRef);
      if (previous) assert.deepEqual(previous, session);
      sessions.set(session.handle.sessionRef, structuredClone(session));
    },
    async withCompletion(_session, run) {
      if (state.throwPrivate) throw Error(`${pan}/${cvv}/${providerToken}`);
      if (state.returnPrivate) return { ok: false, code: providerToken, pan, cvv };
      if (!authenticated || state.adapterRevoked) return { ok: false, code: 'not_authorized' };
      await state.completionHook?.();
      const result = await run(structuredClone(authenticated));
      if (state.mutateResult && result.ok) result.value.pan = pan;
      return result;
    },
    async withReference(_session, run) {
      return state.adapterRevoked ? { ok: false, code: 'not_authorized' } : run();
    },
  };
  return { adapter, custody,
    authenticate(handle, mutate = () => {}) {
      authenticated = { session: structuredClone(sessions.get(handle.sessionRef)),
        origin: state.request.origin, custody: structuredClone(custody) };
      mutate(authenticated);
    },
    poison(field) { return { [field]: field === 'cvv' ? cvv : field === 'providerToken' ? providerToken : pan }; },
    scan(value) {
      const serialized = JSON.stringify(value);
      // CVV is short: scan JSON values, not incidental random ID substrings.
      assert.equal(serialized.includes(pan) || serialized.includes(providerToken)
        || serialized.includes(JSON.stringify(cvv)), false, 'private canaries absent from sinks');
    },
  };
}
async function setup(t, source = 'new_input') {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(), other = await harness.client();
  await migrations(t, harness, client);
  const jobs = services(client.database(), harness.schema, {}, { state: { now: 1000 } });
  ok(await jobs.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity, state: 'queued', revision: 1, effects: [] } }));
  const fence = await start(jobs, 60_000);
  ok(await jobs.lease.append({ kind: 'waiting', previousRevision: 2,
    snapshot: { identity, state: 'waiting', revision: 3, requirement, effects: [] } }, fence));
  await jobs.lease.release(fence);
  const state = entryState('token', source);
  const metadata = { kind: 'payment_method', providerRef: 'fixture-provider', customerRef: 'fixture-customer', paymentAccountRef: 'fixture-account' };
  state.request.metadata = metadata;
  state.grant.request.item = { metadata, reference: { kind: 'payment_method', paymentRef: 'host-payment-alias', revision: 1 } };
  state.grant.request.destination = { endpoint: 'https://fixture.invalid/payment', method: 'POST', redirects: 'deny',
    providerRef: metadata.providerRef, customerRef: metadata.customerRef, paymentAccountRef: metadata.paymentAccountRef,
    merchantRef: 'merchant', payeeRef: 'payee', purposeRef: identity.host.purposeRef, action: 'verify' };
  const base = entryServices(client.database(), harness.schema, state);
  base.host.paymentMode = 'synthetic_sandbox';
  const fixture = syntheticAdapter(state);
  base.storage.authorize = async (op, _item, alias) => state.ownerAllowed
    && (op !== 'create' || alias === fixture.custody.adapterRef) ? identity.host : null;
  const outputs = [];
  const api = (host = base.host, db = client.database(), reg = registration) => {
    const store = createVaultEntryStore(db, base.storage, base.owner, base.keys, harness.schema);
    const payment = createPaymentVault(host, store, reg, fixture.adapter);
    return Object.fromEntries(Object.entries(payment).map(([key, call]) => [key, async (...args) => {
      const result = await call(...args); outputs.push(result); return result;
    }]));
  };
  const rows = async table => (await other.query(`SELECT * FROM ${harness.table(table)}`)).rows;
  const counts = async () => ({ items: (await rows('vault_items')).length,
    completions: (await rows('vault_entry_sessions')).filter(r => r.completion).length,
    answers: (await rows('job_answer_deliveries')).length, jobs: (await rows('jobs')).length });
  const scan = async (...extra) => {
    const durable = [];
    for (const table of ['vault_items', 'vault_states', 'vault_entry_sessions', 'vault_item_grants',
      'job_events', 'job_challenges', 'job_answer_deliveries']) durable.push(await rows(table));
    fixture.scan([durable, outputs, extra]);
  };
  const custody = createVaultStore(client.database(), base.storage, base.keys, vaultTables(harness.schema));
  if (source === 'existing_item') ok(await custody.create(state.grant.request.item, fixture.custody));
  return { ...base, ...jobs, host: base.host, state, fixture, api, payment: api(), second: api(base.host, other.database()),
    rows, counts, scan, custody, harness, client, other };
}

for (const source of ['new_input', 'existing_item']) test(`${source}: synthetic reference handoff, durable selection and original-job answer`, async t => {
  const s = await setup(t, source), h = ok(await s.payment.issue(s.state.request));
  assert.deepEqual(ok(await s.second.issue(s.state.request)), h);
  denied(await s.payment.complete(h)); // Client handle alone confers no authority.
  s.fixture.authenticate(h);
  const c = ok(await s.payment.complete(h));
  assert.deepEqual(c.item, s.state.grant.request.item);
  assert.equal(c.source, source);
  denied(await s.second.complete(h)); // Completion is one-shot, including after restart.
  const receipts = await Promise.all([s.payment.deliver(h), s.second.deliver(h)]);
  assert.deepEqual(receipts.map(r => ok(r).replayed).sort(), [false, true]);
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 1, jobs: 1 });
  const job = ok(await s.journal.load(identity));
  assert.deepEqual(job.identity, identity); assert.equal(job.answer.responseRef, h.sessionRef);
  assert.equal((await s.rows('vault_item_grants')).length, 1);
  assert.deepEqual((await s.rows('vault_entry_sessions'))[0].binding.paymentAdapter, registration);
  await s.scan(receipts);
});

const mismatch = {
  account: c => { c.session.binding.request.identity.host.accountRef = 'other'; },
  environment: c => { c.session.binding.request.identity.host.environmentRef = 'other'; },
  tenant: c => { c.session.binding.request.identity.host.tenantRef = 'other'; },
  purpose: c => { c.session.binding.request.identity.host.purposeRef = 'other'; },
  customer: c => { c.session.binding.grant.request.destination.customerRef = 'other'; },
  merchant: c => { c.session.binding.grant.request.destination.merchantRef = 'other'; },
  origin: c => { c.origin = 'https://other.invalid'; },
  session: c => { c.session.handle.sessionRef = 'a'.repeat(64); },
  revision: c => { c.session.handle.revision++; },
  adapter: c => { c.session.adapter.version = 'other'; },
  token: c => { c.custody = { providerToken: 'untrusted' }; },
  alias: c => { c.custody.adapterRef = randomUUID(); },
};
for (const [name, mutate] of Object.entries(mismatch)) test(`authenticated completion rejects wrong ${name}`, async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request));
  s.fixture.authenticate(h, mutate); denied(await s.payment.complete(h));
  assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 }); await s.scan();
});

test('concurrent adapter completions consume one session on PostgreSQL locks', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
  const results = await Promise.all([s.payment.complete(h), s.second.complete(h)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 0, jobs: 1 }); await s.scan();
});

const stale = {
  expired: async s => { s.state.now = 2000; },
  'expired during adapter await': async s => { s.state.completionHook = () => { s.state.now = 2000; }; },
  withdrawn: async (s, h) => { ok(await s.payment.withdraw(h)); },
  cancelled: async s => { ok(await createJobCancellationStore(s.other.database(), s.tables).cancel(
    { command: 'cancel', identity, expectedRevision: 3, reason: 'explicit_stop' }, identity.host.userRef,
    { host: identity.host, grantRevision: 1, cancellationRevision: 0 })); },
  'host authority revoked': async s => { s.state.denied = true; },
  'adapter reference revoked': async s => { s.state.adapterRevoked = true; },
  'scope revision changed': async s => { s.state.grantRevision++; },
  'consent changed': async s => { s.state.grant.request.destination.action = 'attach'; },
};
for (const [name, change] of Object.entries(stale)) test(`${name}: no late completion`, async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
  await change(s, h); denied(await s.payment.complete(h)); denied(await s.payment.deliver(h));
  assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 }); await s.scan();
});

test('revocation and expiry fence delivery of a captured reference', async t => {
  for (const kind of ['adapter', 'lifecycle', 'expiry']) await t.test(kind, async t => {
    const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
    ok(await s.payment.complete(h));
    if (kind === 'adapter') s.state.adapterRevoked = true;
    else if (kind === 'expiry') { s.state.now = 2000; ok(await s.payment.expire(h)); }
    else ok(await createVaultLifecycle(s.other.database(), s.storage, s.keys, vaultTables(s.harness.schema))
      .terminate(s.state.grant.request.item, 'revoked'));
    denied(await s.payment.deliver(h)); assert.equal((await s.counts()).answers, 0); await s.scan();
  });
});

test('selection rejects a substituted custody alias', async t => {
  const s = await setup(t, 'existing_item'), h = ok(await s.payment.issue(s.state.request));
  s.fixture.authenticate(h, c => { c.custody = { adapterRef: randomUUID() }; });
  denied(await s.payment.complete(h)); assert.equal((await s.counts()).completions, 0); await s.scan();
});

test('adapter registration is pinned durably and production remains unsupported', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
  denied(await s.api(s.host, s.client.database(), { ...registration, version: 'fixture-2' }).complete(h));
  denied(await s.api({ ...s.host, paymentMode: 'unsupported' }).issue(s.state.request));
  denied(await s.api(s.host, s.client.database(), { ...registration, qualification: 'production' }).complete(h));
  denied(await s.api(s.host, s.client.database(), { ...registration, environmentRef: 'other' }).complete(h));
  assert.equal((await s.counts()).completions, 0); await s.scan();
});

test('raw card, CVV and provider token fields are rejected without sink retention', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request));
  const generic = createVaultEntry(s.host, s.store), outputs = [];
  outputs.push(await generic.issue(s.state.request), await generic.capture(h, s.fixture.poison('pan')));
  for (const field of ['pan', 'cvv', 'providerToken']) {
    const extra = s.fixture.poison(field);
    const request = { ...s.state.request, ...extra }, item = { ...s.state.grant.request.item, ...extra };
    outputs.push(validateVaultEntryRequest(request), validateVaultItem(item),
      validateVaultOperationSchema({ ...s.state.grant.request, ...extra }),
      await s.payment.issue(request), await s.payment.complete({ ...h, ...extra }),
      await s.custody.create(s.state.grant.request.item, extra));
  }
  const purchase = structuredClone(s.state.grant.request); purchase.destination.action = 'purchase';
  outputs.push(validateVaultOperationSchema(purchase));
  outputs.forEach(denied);
  s.state.returnPrivate = true; denied(await s.payment.complete(h));
  s.state.throwPrivate = true; denied(await s.payment.complete(h));
  assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 }); await s.scan(outputs);
});

test('outbox failure rolls back reference custody and consent; fresh instance can retry', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
  const table = s.harness.table('vault_entry_sessions');
  await s.client.query(`ALTER TABLE ${table} ADD CONSTRAINT fixture_payment_rollback CHECK (state != 'captured')`);
  denied(await s.payment.complete(h));
  assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 });
  assert.equal((await s.rows('vault_item_grants')).length, 0);
  await s.client.query(`ALTER TABLE ${table} DROP CONSTRAINT fixture_payment_rollback`);
  ok(await s.second.complete(h)); ok(await s.second.deliver(h)); await s.scan();
});

test('unknown private fields in host consent cannot enter session persistence', async t => {
  const s = await setup(t);
  Object.assign(s.state.grant, s.fixture.poison('pan'));
  denied(await s.payment.issue(s.state.request));
  assert.equal((await s.rows('vault_entry_sessions')).length, 0); await s.scan();
});

test('adapter cannot append private data to an SDK completion result', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); s.fixture.authenticate(h);
  s.state.mutateResult = true; denied(await s.payment.complete(h));
  assert.equal((await s.counts()).completions, 1);
  ok(await s.payment.deliver(h)); await s.scan();
});
