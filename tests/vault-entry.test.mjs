import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { services, start, ok } from './helpers/effect-fixture.mjs';
import { identity, requirement, entryState, entryServices } from './helpers/vault-entry-fixture.mjs';
import { createVaultStore } from '../.reference-build/reference/node/vault-store.js';
import { createVaultGrants } from '../.reference-build/reference/node/vault-grants.js';
import { createVaultLifecycle } from '../.reference-build/reference/node/vault-lifecycle.js';
import { createLoginVault } from '../.reference-build/src/server/login-vault.js';
import { createJobCancellationStore } from '../.reference-build/reference/node/job-cancellation.js';
import { vaultTables } from '../.reference-build/reference/node/db/schema.js';
const denied = r => assert.equal(r.ok, false);
async function setup(t, kind = 'token', source = 'new_input', keepLease = false) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(), other = await harness.client(), observer = await harness.client();
  await migrations(t, harness, client);
  const s = services(client.database(), harness.schema, {}, { state: { now: 1000 } });
  ok(await s.journal.append({ kind: 'submitted', previousRevision: 0,
    snapshot: { identity, state: 'queued', revision: 1, effects: [] } }));
  const fence = await start(s, 60_000);
  ok(await s.lease.append({ kind: 'waiting', previousRevision: 2,
    snapshot: { identity, state: 'waiting', revision: 3, requirement, effects: [] } }, fence));
  if (!keepLease) ok(await s.lease.release(fence));
  const state = entryState(kind, source), api = entryServices(client.database(), harness.schema, state);
  const second = entryServices(other.database(), harness.schema, state, api.keys);
  if (kind === 'login') {
    api.entry = createLoginVault(api.host, api.store);
    second.entry = createLoginVault(second.host, second.store);
  }
  const privateCanary = randomBytes(32).toString('hex');
  const value = kind === 'token' ? { token: privateCanary } : kind === 'login' ? { password: privateCanary } : { value: privateCanary };
  const rows = async table => (await observer.query(`SELECT * FROM ${harness.table(table)}`)).rows;
  const counts = async () => ({ items: (await rows('vault_items')).length,
    completions: (await rows('vault_entry_sessions')).filter(r => r.completion).length,
    answers: (await rows('job_answer_deliveries')).length, jobs: (await rows('jobs')).length });
  const scan = async (...outputs) => {
    const durable = [];
    for (const table of ['vault_items', 'vault_states', 'vault_entry_sessions', 'vault_item_grants',
      'job_events', 'job_challenges', 'job_answer_deliveries']) durable.push(await rows(table));
    assert.equal(JSON.stringify([durable, outputs]).includes(privateCanary), false, 'private canary absent from durable and public output');
  };
  return { ...s, ...api, fence, harness, client, other, observer, state, second, rows, counts, scan, value,
    item: state.grant.request.item, grants: createVaultGrants(other.database(), api.owner, api.keys, harness.schema),
    lifecycle: createVaultLifecycle(other.database(), api.storage, api.keys, vaultTables(harness.schema)) };
}

for (const kind of ['token', 'login', 'identity']) test(`${kind}: concurrent capture and delivery produce one item, completion and original-job resume`, async t => {
  const s = await setup(t, kind, 'new_input', true);
  const h = ok(await s.entry.issue(s.state.request));
  assert.deepEqual(ok(await s.second.entry.issue(s.state.request)), h);
  assert.match(h.sessionRef, /^[a-f0-9]{64}$/);
  const captures = await Promise.all([s.entry.capture(h, s.value), s.second.entry.capture(h, s.value)]);
  assert.deepEqual(ok(captures[0]), ok(captures[1]));
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 0, jobs: 1 });
  assert.equal(ok(await s.journal.load(identity)).state, 'waiting');
  const deliveries = await Promise.all([s.entry.deliver(h), s.second.entry.deliver(h)]);
  assert.deepEqual(deliveries.map(r => ok(r).replayed).sort(), [false, true]);
  assert.deepEqual(deliveries.map(r => ok(r).eventCursor), [4, 4]);
  const waiting = ok(await s.journal.load(identity)); assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.answer.responseRef, h.sessionRef);
  assert.equal((await s.rows('vault_item_grants'))[0].revision, '1');
  const fence = s.fence;
  const resume = { kind: 'resumed', previousRevision: 4,
    command: { command: 'resume', identity, expectedRevision: 4, requirementRef: requirement.requirementRef,
      requirementRevision: 1, resolutionReceiptRef: h.sessionRef },
    snapshot: { identity, state: 'queued', revision: 5, effects: [] } };
  ok(await s.lease.append(resume, fence)); ok(await s.lease.append(resume, fence));
  await s.lease.release(fence);
  assert.equal((await s.rows('job_events')).filter(r => r.event.kind === 'resumed').length, 1);
  assert.deepEqual(ok(await s.journal.load(identity)).identity, identity);
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 1, jobs: 1 });
  await s.scan(captures, deliveries);
});

test('conflicting private retry and altered binding fail without orphaning another item', async t => {
  const s = await setup(t); const h = ok(await s.entry.issue(s.state.request));
  ok(await s.entry.capture(h, s.value));
  const result = await s.entry.capture(h, { token: randomBytes(32).toString('hex') });
  assert.deepEqual(result, { ok: false, code: 'conflict' });
  s.state.grant.request.item.reference.itemRef = 'different-item';
  denied(await s.entry.capture(h, s.value)); denied(await s.entry.issue(s.state.request));
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 0, jobs: 1 });
  await s.scan(result);
});

test('select an existing item only with current item-owner permission; persist consent revision before delivery', async t => {
  const s = await setup(t, 'token', 'existing_item');
  ok(await createVaultStore(s.client.database(), s.storage, s.keys, vaultTables(s.harness.schema)).create(s.item, s.value));
  const h = ok(await s.entry.issue(s.state.request));
  s.state.ownerAllowed = false; denied(await s.entry.capture(h));
  assert.equal((await s.rows('vault_item_grants')).length, 0);
  s.state.ownerAllowed = true; denied(await s.entry.capture(h, s.value));
  ok(await s.entry.capture(h));
  assert.equal((await s.rows('vault_item_grants'))[0].revision, '1');
  assert.equal((await s.rows('vault_entry_sessions'))[0].binding.grant.request.grantRevision, 1);
  ok(await s.grants.administration.revoke(s.item, 'entry-use-grant', 1));
  denied(await s.entry.deliver(h));
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 0, jobs: 1 });
  await s.scan();
});

const changes = {
  'wrong actor': s => { s.state.actorRef = 'other'; },
  'authentication revoked': s => { s.state.denied = true; },
  'wrong tenant': s => { s.state.scope.tenantRef = 'other'; },
  'wrong account': s => { s.state.scope.accountRef = 'other'; },
  'wrong environment': s => { s.state.scope.environmentRef = 'other'; },
  'wrong purpose': s => { s.state.scope.purposeRef = 'other'; },
  'scope revision changed': s => { s.state.grantRevision++; },
  'destination changed': s => { s.state.grant.request.destination.endpoint = 'https://other.invalid/setup'; },
  'origin changed': s => { s.state.request.origin = 'https://other.invalid'; },
  'session revision changed': (_s, h) => { h.revision++; },
  'expired': s => { s.state.now = 2000; },
  'withdrawn': async (s, h) => { ok(await s.entry.withdraw(h)); },
  'cancelled': async s => { ok(await createJobCancellationStore(s.other.database(), s.tables).cancel(
    { command: 'cancel', identity, expectedRevision: 3, reason: 'explicit_stop' }, identity.host.userRef,
    { host: identity.host, grantRevision: 1, cancellationRevision: 0 })); },
};
for (const phase of ['before capture', 'before delivery']) test(`${phase}: stale, unauthenticated, expired and withdrawn sessions cannot advance`, async t => {
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const s = await setup(t); const h = ok(await s.entry.issue(s.state.request));
    if (phase === 'before delivery') ok(await s.entry.capture(h, s.value));
    await change(s, h);
    denied(await s.entry.capture(h, s.value)); denied(await s.entry.deliver(h));
    assert.deepEqual(await s.counts(), { items: phase === 'before delivery' ? 1 : 0,
      completions: phase === 'before delivery' ? 1 : 0, answers: 0, jobs: 1 });
    if (name === 'expired') assert.equal((await s.rows('vault_entry_sessions'))[0].state, 'expired');
    await s.scan();
  });
});

test('surface dismissal has no job effect; explicit expiry and withdrawal survive fresh store instances', async t => {
  for (const reason of ['expire', 'withdraw']) await t.test(reason, async t => {
    const s = await setup(t); const h = ok(await s.entry.issue(s.state.request));
    assert.equal(ok(await s.journal.load(identity)).revision, 3);
    if (reason === 'expire') { denied(await s.entry.expire(h)); s.state.now = 2000; }
    ok(await s.entry[reason](h));
    denied(await s.second.entry.capture(h, s.value));
    const row = (await s.rows('vault_entry_sessions'))[0];
    assert.equal(row.state, reason === 'expire' ? 'expired' : 'withdrawn'); assert.equal(row.revision, '2');
    assert.equal(ok(await s.journal.load(identity)).state, 'waiting');
  });
});

test('custody failure, grant denial and expiry during key resolution roll back item, consent and outbox together', async t => {
  for (const reason of ['keys', 'grant', 'expiry']) await t.test(reason, async t => {
    const s = await setup(t); const h = ok(await s.entry.issue(s.state.request));
    s.state.resolveHook = async () => {
      if (reason === 'keys') throw Error('private-error-withheld');
      if (reason === 'grant') s.state.grantDenied = true;
      if (reason === 'expiry') s.state.now = 2000;
    };
    denied(await s.entry.capture(h, s.value));
    assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 });
    assert.equal((await s.rows('vault_states')).length, 0); assert.equal((await s.rows('vault_item_grants')).length, 0);
    await s.scan();
  });
});

test('lifecycle revocation and narrowed grant fence pending delivery', async t => {
  for (const mode of ['lifecycle', 'grant']) await t.test(mode, async t => {
    const s = await setup(t); const h = ok(await s.entry.issue(s.state.request)); ok(await s.entry.capture(h, s.value));
    if (mode === 'lifecycle') ok(await s.lifecycle.terminate(s.item, 'revoked'));
    else { const grant = structuredClone(s.state.grant); grant.request.grantRevision++;
      grant.request.destination.method = 'GET'; ok(await s.grants.administration.put(grant, 1)); }
    denied(await s.entry.deliver(h)); assert.equal((await s.counts()).answers, 0);
  });
});

async function child(t, schema, mode, handle) {
  const process = fork(new URL('./helpers/vault-entry-process.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (process.exitCode === null) process.kill('SIGKILL'); });
  let bytes = 0; process.stdout.on('data', b => { bytes += b.length; }); process.stderr.on('data', b => { bytes += b.length; });
  const received = once(process, 'message'); process.send({ schema, mode, handle });
  const [message] = await received;
  assert.notEqual(message.event, 'error', 'private child fixture succeeded');
  const exited = once(process, 'exit'); if (mode === 'capture') process.kill('SIGKILL'); await exited;
  assert.equal(bytes, 0, 'child emits no logs');
  return { message, pid: process.pid };
}
test('killed capture process leaves a durable completion; fresh keyless process delivers the same reference', { timeout: 20_000 }, async t => {
  const s = await setup(t);
  const first = await child(t, s.harness.schema, 'capture');
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 0, jobs: 1 });
  const second = await child(t, s.harness.schema, 'deliver', first.message.handle);
  assert.notEqual(first.pid, second.pid); assert.equal(second.message.receipt.eventCursor, 4);
  const third = await child(t, s.harness.schema, 'deliver', first.message.handle);
  assert.equal(third.message.receipt.replayed, true);
  assert.equal(ok(await s.journal.load(identity)).answer.responseRef, first.message.completion.answer.responseRef);
  assert.deepEqual(await s.counts(), { items: 1, completions: 1, answers: 1, jobs: 1 });
  t.diagnostic('Fixture-only receipt: killed capture process -> fresh keyless delivery -> replay; items=1; completions=1; answers=1; original jobs=1.');
});

test('outbox write failure rolls back ciphertext and grant; delivery write failure rolls back the existing answer service', async t => {
  const s = await setup(t); const h = ok(await s.entry.issue(s.state.request));
  const table = s.harness.table('vault_entry_sessions');
  await s.client.query(`ALTER TABLE ${table} ADD CONSTRAINT fixture_fail_capture CHECK (state != 'captured')`);
  denied(await s.entry.capture(h, s.value));
  assert.deepEqual(await s.counts(), { items: 0, completions: 0, answers: 0, jobs: 1 });
  assert.equal((await s.rows('vault_states')).length, 0); assert.equal((await s.rows('vault_item_grants')).length, 0);
  await s.client.query(`ALTER TABLE ${table} DROP CONSTRAINT fixture_fail_capture`);
  ok(await s.entry.capture(h, s.value));
  await s.client.query(`ALTER TABLE ${table} ADD CONSTRAINT fixture_fail_delivery CHECK (state != 'delivered')`);
  denied(await s.entry.deliver(h));
  assert.equal(ok(await s.journal.load(identity)).revision, 3);
  assert.equal((await s.rows('job_challenges'))[0].consumed, 0);
  assert.equal((await s.rows('job_answer_deliveries')).length, 0);
  await s.client.query(`ALTER TABLE ${table} DROP CONSTRAINT fixture_fail_delivery`);
  ok(await s.second.entry.deliver(h)); await s.scan();
});

test('superseded challenge/job revision cannot capture or deliver to a later wait', async t => {
  for (const captured of [false, true]) await t.test(captured ? 'captured' : 'open', async t => {
    const s = await setup(t, 'token', 'new_input', true); const h = ok(await s.entry.issue(s.state.request));
    if (captured) ok(await s.entry.capture(h, s.value));
    ok(await s.lease.append({ kind: 'resumed', previousRevision: 3,
      command: { command: 'resume', identity, expectedRevision: 3, requirementRef: requirement.requirementRef,
        requirementRevision: 1, resolutionReceiptRef: 'separately-verified-resolution' },
      snapshot: { identity, revision: 4, state: 'queued', effects: [] } }, s.fence));
    ok(await s.lease.append({ kind: 'started', previousRevision: 4,
      snapshot: { identity, revision: 5, state: 'running', effects: [] } }, s.fence));
    ok(await s.lease.append({ kind: 'waiting', previousRevision: 5,
      snapshot: { identity, revision: 6, state: 'waiting', requirement: { ...requirement, revision: 2 }, effects: [] } }, s.fence));
    denied(await s.entry.capture(h, s.value)); denied(await s.entry.deliver(h));
    assert.equal(ok(await s.journal.load(identity)).revision, 6);
    assert.equal((await s.counts()).items, captured ? 1 : 0); assert.equal((await s.counts()).answers, 0);
  });
});

test('delivery and withdrawal serialize on real SQL locks; no later delivery after withdrawal', async t => {
  const s = await setup(t); const h = ok(await s.entry.issue(s.state.request)); ok(await s.entry.capture(h, s.value));
  let entered, release;
  const gate = new Promise(r => { entered = r; }); const unblock = new Promise(r => { release = r; });
  t.after(() => release());
  s.owner.withOwner = async (_item, _action, run) => { entered(); await unblock; return run(identity.host); };
  const delivering = s.entry.deliver(h); await gate;
  let withdrawn = false;
  const withdrawing = s.second.entry.withdraw(h).then(r => { withdrawn = true; return r; });
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const result = await s.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (result.rows.length) { waiting = true; break; } await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(waiting, true); assert.equal(withdrawn, false); release();
  ok(await delivering); denied(await withdrawing); assert.equal((await s.counts()).answers, 1);
});

test('changed frame and stored item metadata cannot be selected; payment input is deferred', async t => {
  const s = await setup(t, 'login', 'existing_item');
  ok(await createVaultStore(s.client.database(), s.storage, s.keys, vaultTables(s.harness.schema)).create(s.item, s.value));
  const h = ok(await s.entry.issue(s.state.request));
  s.state.grant.request.destination.frames[0].frameRef = 'other-frame';
  denied(await s.entry.capture(h));
  const mismatched = structuredClone(s.state.grant);
  mismatched.request.item.metadata = { kind: 'token', tokenType: 'api' }; mismatched.request.operation = 'capture';
  mismatched.request.destination.fieldKind = 'token';
  denied(await s.grants.administration.put(mismatched, 0));
  denied(await s.entry.issue({ ...s.state.request, metadata: { kind: 'payment_method', providerRef: 'provider', customerRef: 'customer', paymentAccountRef: 'account' } }));
  assert.equal((await s.counts()).completions, 0); await s.scan();
});
