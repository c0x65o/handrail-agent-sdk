import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { createPaymentVault } from '../.reference-build/src/server/payment-vault.js';
import { createVaultStore } from '../.reference-build/reference/node/vault-store.js';
import { createVaultLifecycle } from '../.reference-build/reference/node/vault-lifecycle.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
import { vaultTables } from '../.reference-build/reference/node/db/schema.js';
import { validateVaultEntryRequest, validateVaultItem, validateVaultOperationSchema } from '../.reference-build/src/contracts/vault.js';
import { migrations } from './helpers/migrations.mjs';
import { services, start, ok } from './helpers/effect-fixture.mjs';
import { identity, requirement, entryState, entryServices } from './helpers/vault-entry-fixture.mjs';
const denied = r => assert.equal(r.ok, false, 'private operation denied');
const card = () => ({ pan: `9${Array.from(randomBytes(15), b => b % 10).join('')}`,
  cardholderName: randomBytes(24).toString('hex'), expiryMonth: '12', expiryYear: '2099' });
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
  const state = entryState('payment_method', source), base = entryServices(client.database(), harness.schema, state);
  const second = entryServices(other.database(), harness.schema, state, base.keys);
  base.storage.authorize = async () => state.ownerAllowed ? state.scope : null;
  const value = card(), item = state.grant.request.item;
  const custody = createVaultStore(client.database(), base.storage, base.keys, vaultTables(harness.schema));
  const rows = async table => (await other.query(`SELECT * FROM ${harness.table(table)}`)).rows;
  const scan = async (...outputs) => {
    const durable = [];
    for (const table of ['vault_items', 'vault_states', 'vault_entry_sessions', 'vault_item_grants', 'job_events', 'job_challenges', 'job_answer_deliveries', 'job_effects', 'vault_access']) durable.push(await rows(table));
    const text = JSON.stringify([durable, outputs]);
    for (const v of [value.pan, value.cardholderName]) for (const encoded of [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64')])
      assert.equal(text.includes(encoded), false, 'card canary absent from public and persisted sinks');
  };
  if (source === 'existing_item') ok(await custody.create(item, value));
  return { ...base, ...jobs, state, fence, harness, client, other, rows, scan, custody, value, item,
    payment: createPaymentVault(base.host, base.store), second: createPaymentVault(second.host, second.store),
    lifecycle: createVaultLifecycle(other.database(), base.storage, base.keys, vaultTables(harness.schema)) };
}
for (const source of ['new_input', 'existing_item']) test(`${source}: encrypted card entry, concurrent one-shot completion and same-job delivery`, async t => {
  const s = await setup(t, source), h = ok(await s.payment.issue(s.state.request));
  assert.deepEqual(ok(await s.second.issue(s.state.request)), h);
  s.state.denied = true; denied(await s.payment.capture(h, source === 'new_input' ? s.value : undefined));
  s.state.denied = false;
  if (source === 'existing_item') denied(await s.payment.capture(h, s.value));
  const captures = await Promise.all([s.payment.capture(h, source === 'new_input' ? s.value : undefined), s.second.capture(h, source === 'new_input' ? s.value : undefined)]);
  assert.equal(captures.filter(r => r.ok).length, 1);
  denied(await s.payment.capture(h, card()));
  const deliveries = await Promise.all([s.payment.deliver(h), s.second.deliver(h)]);
  assert.deepEqual(deliveries.map(r => ok(r).replayed).sort(), [false, true]);
  assert.equal((await s.rows('vault_items')).length, 1);
  assert.equal((await s.rows('job_answer_deliveries')).length, 1);
  assert.equal((await s.rows('jobs')).length, 1);
  assert.equal(ok(await s.custody.readForExecutor(s.item)).pan === s.value.pan, true, 'encrypted value recovered privately');
  const resume = { kind: 'resumed', previousRevision: 4,
    command: { command: 'resume', identity, expectedRevision: 4, requirementRef: requirement.requirementRef, requirementRevision: 1, resolutionReceiptRef: h.sessionRef },
    snapshot: { identity, state: 'queued', revision: 5, effects: [] } };
  ok(await s.lease.append(resume, s.fence)); ok(await s.lease.append(resume, s.fence));
  assert.equal((await s.rows('job_events')).filter(r => r.event.kind === 'resumed').length, 1);
  denied(await s.payment.deliver(h)); // No stale completion into a resumed task.
  ok(await s.lease.release(s.fence));
  const useFence = await start(s, 60_000);
  const { createVaultUse } = await import('../.reference-build/src/server/vault-use.js');
  const { createPaymentFillExecutor } = await import('../.reference-build/src/server/payment-vault.js');
  const { createVaultGrants, vaultEffectRequest } = await import('../.reference-build/reference/node/vault-grants.js');
  const grants = createVaultGrants(s.client.database(), s.owner, s.keys, s.harness.schema);
  let fills = 0;
  const executor = createPaymentFillExecutor({ operationRef: s.state.grant.request.effect.operationRef,
    bind: r => vaultEffectRequest(r, 'private-card-fixture'), reconcile: async () => 'not_applied',
  }, { withTarget: async (_r, signal, run) => run({ destination: structuredClone(s.state.grant.request.destination),
    fill: async (value, isCurrent) => {
      assert.equal(!signal.aborted && isCurrent(), true);
      assert.equal(value === s.value.pan, true, 'same-job private card fill'); fills++; return 'verified';
    } }) });
  const use = createVaultUse({ now: () => s.state.now, withAuthority: async (_r, _phase, run) => run({
    host: s.state.scope, grantRevision: s.state.grantRevision, cancellationRevision: s.state.cancellationRevision, actorRef: s.state.actorRef,
  }) }, grants.use, [executor]);
  const used = ok(await use.execute(s.state.grant.request, useFence));
  assert.equal(used.outcome, 'verified');
  assert.deepEqual(ok(await use.execute(s.state.grant.request, useFence)), used);
  assert.equal(fills, 1);
  await s.scan(captures, deliveries, used);
});

const changes = {
  actor: s => { s.state.actorRef = 'other'; },
  ...Object.fromEntries(['tenantRef', 'userRef', 'projectRef', 'accountRef', 'environmentRef', 'purposeRef'].map(k => [k, s => { s.state.scope[k] = 'other'; }])),
  origin: s => { s.state.request.origin = 'https://other.invalid'; },
  field: s => { s.state.grant.request.destination.fieldRef = 'other'; },
  frame: s => { s.state.grant.request.destination.frames[0].frameRef = 'other'; },
  revision: s => { s.state.grantRevision++; },
  expiry: s => { s.state.now = 2000; },
  cancelled: async s => { ok(await createJobCancellationStore(s.other.database(), s.tables).cancel(
    { command: 'cancel', identity, expectedRevision: 3, reason: 'explicit_stop' }, identity.host.userRef,
    { host: identity.host, grantRevision: 1, cancellationRevision: 0 })); },
};
for (const [name, mutate] of Object.entries(changes)) test(`card entry rejects changed ${name}`, async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); await mutate(s);
  denied(await s.payment.capture(h, s.value)); denied(await s.payment.deliver(h));
  assert.equal((await s.rows('vault_items')).length, 0); await s.scan();
});
for (const change of ['expiry', 'scope', 'revocation']) test(`card capture ${change} during key await rolls back`, async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request));
  s.state.resolveHook = () => { if (change === 'expiry') s.state.now = 2000; else if (change === 'scope') s.state.scope.accountRef = 'other'; else s.state.ownerAllowed = false; };
  denied(await s.payment.capture(h, s.value)); assert.equal((await s.rows('vault_items')).length, 0); await s.scan();
});
for (const change of ['revoke', 'expiry', 'withdraw']) test(`${change} prevents card reference delivery`, async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); ok(await s.payment.capture(h, s.value));
  if (change === 'revoke') ok(await s.lifecycle.terminate(s.item, 'revoked'));
  else if (change === 'expiry') { s.state.now = 2000; ok(await s.payment.expire(h)); }
  else ok(await s.payment.withdraw(h));
  denied(await s.payment.deliver(h)); assert.equal((await s.rows('job_answer_deliveries')).length, 0); await s.scan();
});
test('card codes, extra private fields and public card payloads are rejected without retention', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request));
  for (const field of ['cvv', 'cvc', 'securityCode', 'providerToken']) {
    const bad = { ...s.value, [field]: randomBytes(16).toString('hex') };
    denied(await s.payment.capture(h, bad)); denied(await s.custody.create(s.item, bad));
  }
  for (const v of [s.state.request, s.item, s.state.grant.request]) {
    const check = v === s.item ? validateVaultItem : v === s.state.request ? validateVaultEntryRequest : validateVaultOperationSchema;
    denied(check({ ...v, ...s.value }));
  }
  s.state.grant.pan = s.value.pan; denied(await s.payment.issue(s.state.request));
  assert.equal((await s.rows('vault_items')).length, 0); await s.scan();
});
test('fresh process recovers reference and delivers with no card or key access', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request)); ok(await s.payment.capture(h, s.value));
  const child = fork(new URL('./helpers/vault-entry-process.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const received = once(child, 'message'), closed = once(child, 'exit');
  child.send({ schema: s.harness.schema, mode: 'deliver', handle: h, kind: 'payment_method' });
  const [message] = await received; await closed;
  assert.equal(message.event, 'delivered'); assert.equal(message.receipt.replayed, false);
  await s.scan(message);
});
test('capture outbox failure rolls back card ciphertext and consent atomically', async t => {
  const s = await setup(t), h = ok(await s.payment.issue(s.state.request));
  const table = s.harness.table('vault_entry_sessions');
  await s.client.query(`ALTER TABLE ${table} ADD CONSTRAINT fixture_card_rollback CHECK (state != 'captured')`);
  denied(await s.payment.capture(h, s.value)); assert.equal((await s.rows('vault_items')).length, 0);
  assert.equal((await s.rows('vault_item_grants')).length, 0);
  await s.client.query(`ALTER TABLE ${table} DROP CONSTRAINT fixture_card_rollback`);
  ok(await s.second.capture(h, s.value)); ok(await s.second.deliver(h)); await s.scan();
});

test('card executor selects one field and fences live destination, expiry, abort and output spoofing', async () => {
  const { createPaymentFillExecutor } = await import('../.reference-build/src/server/payment-vault.js');
  const state = entryState('payment_method'), value = card(), request = state.grant.request;
  let current = true, calls = 0, hook = () => {}, changed = d => d;
  const observed = [];
  let expected;
  const registration = { operationRef: request.effect.operationRef, bind: () => { throw Error('UNUSED_BIND'); }, reconcile: async () => 'unknown' };
  const boundary = { withTarget: async (r, signal, run) => {
    hook();
    return run({ destination: changed(structuredClone(r.destination)), fill: async (field, isCurrent) => {
      if (signal.aborted || !isCurrent()) return 'unknown';
      assert.equal(field === expected, true, 'only selected private field'); calls++; return 'verified';
    } });
  } };
  const executor = createPaymentFillExecutor(registration, boundary);
  for (const [field, key] of Object.entries({ card_number: 'pan', cardholder_name: 'cardholderName', card_expiry_month: 'expiryMonth', card_expiry_year: 'expiryYear' })) {
    request.destination.fieldKind = field; expected = value[key];
    const result = await executor.dispatch(request, value, new AbortController().signal, () => current);
    assert.equal(result, 'verified'); observed.push(result);
  }
  const before = calls;
  for (const mutate of [d => { d.origin = 'https://wrong.invalid'; }, d => { d.frames[0].frameRef = 'wrong'; },
    d => { d.fieldRef = 'wrong'; }, d => { d.fieldKind = 'card_number'; }, d => { d.leaseEpoch++; },
    d => { d.navigationRevision++; }, d => { d.documentRef = 'wrong'; }, d => { d.formEndpoint = 'https://wrong.invalid/'; }]) {
    changed = d => { mutate(d); return d; };
    assert.equal(await executor.dispatch(request, value, new AbortController().signal, () => current), 'unknown');
  }
  changed = d => d; hook = () => { current = false; };
  assert.equal(await executor.dispatch(request, value, new AbortController().signal, () => current), 'unknown');
  current = true; hook = () => {};
  const abort = new AbortController(); hook = () => abort.abort();
  assert.equal(await executor.dispatch(request, value, abort.signal, () => current), 'unknown');
  const spoof = createPaymentFillExecutor(registration, { withTarget: async () => 'verified' });
  assert.equal(await spoof.dispatch(request, value, new AbortController().signal, () => current), 'unknown');
  const failure = createPaymentFillExecutor(registration, { withTarget: async () => { throw Error(value.pan); } });
  observed.push(await failure.dispatch(request, value, new AbortController().signal, () => current));
  assert.equal(calls, before); assert.equal(JSON.stringify(observed).includes(value.pan), false);
});
