import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresHarness, migrations } from './fixtures/installed/database.mjs';
import { composition, start, empty, identity, ai, aiEntry, attribution } from './fixtures/observer-recovery/composition.mjs';
const within = async predicate => { const deadline = Date.now() + 6000; while (!await predicate()) { assert.ok(Date.now() < deadline, 'worker did not settle'); await delay(10); } };
const consume = async observation => { const frames = []; for await (const e of observation.events) frames.push(e); return { frames, result: await observation.result }; };
async function setup(t, options) {
  const harness = await createPostgresHarness(), key = randomBytes(32).toString('hex');
  const sql = await harness.client(); await migrations(t, harness);
  await sql.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY,receipt text NOT NULL,attempts integer NOT NULL DEFAULT 1)`);
  const s = await composition(harness.schema, key, options);
  t.after(async () => { await s.close(); await harness.cleanup(); });
  return { ...s, harness, key, sql };
}
async function idle(s) { await within(async () => (await s.document())?.record.attempt > 0 && s.durable.activeWorkerCount === 0); }
async function attempts(s) { return (await s.sql.query(`SELECT coalesce(sum(attempts),0)::int AS n FROM ${s.harness.table('synthetic_provider')}`)).rows[0].n; }
function cold(s) {
  return new Promise((resolve, reject) => {
    const p = fork(new URL('./fixtures/observer-recovery/process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const timer = setTimeout(() => { p.kill(); reject(Error('cold process timed out')); }, 10000);
    let result; p.on('message', value => { result = value; }); p.once('error', reject);
    p.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(result) : reject(Error('cold process failed')); });
    p.send({ schema: s.harness.schema, key: s.key });
  });
}

test('real Runner + PostgreSQL: provider failure after verified effect, cold same-turn recovery and truthful canonical projection', { timeout: 20000 }, async t => {
  let fault = false;
  const s = await setup(t, { modelHooks: { before: async request => {
    if (!fault && Array.isArray(request.input) && request.input.filter(i => i.type === 'function_call_result').length >= 2) {
      fault = true; throw Error('SIMULATED_PRIVATE_PROVIDER_FAILURE');
    }
  } } });
  const opened = await s.durable.startTurn(start); assert.ok(opened.ok);
  await idle(s); assert.ok(fault);
  const pending = await s.document();
  assert.equal(pending.record.status, 'pending'); assert.equal(pending.record.lease, null); assert.equal(pending.record.terminal, null);
  assert.equal((await consume(opened.value.observation)).result.status, 'disconnected');
  const journal = (await s.journal.load(identity)).value;
  assert.equal(journal.state, 'running'); assert.equal(journal.effects[0].outcome, 'verified'); assert.equal(await attempts(s), 1);
  await delay(550); assert.equal((await s.document()).version, pending.version);
  // Fresh scope authorization precedes recovery and cannot change retained facts.
  s.state.denied = true;
  assert.equal((await s.durable.recoverTurn(start.conversationId, start.conversationTurnId)).ok, false);
  assert.equal((await s.delegate.resumeTurn({ conversationId: 'foreign', turnId: start.conversationTurnId, resumeFrom: empty })).ok, false);
  assert.equal((await s.document()).version, pending.version); s.state.denied = false;
  await s.runtime.stop(); await s.durable.stopWorkers();
  const recovered = await cold(s);
  assert.deepEqual(recovered.recovery, { ok: true, value: { status: 'started' } }); assert.equal(recovered.status, 'completed');
  const saved = (await s.document()).record;
  assert.equal(saved.turnId, start.conversationTurnId); assert.equal(saved.mutationId, start.mutationId);
  assert.equal(saved.lease, null); assert.equal(saved.terminal.status, 'completed'); assert.equal(await attempts(s), 1);
  assert.deepEqual((await s.journal.load(identity)).value.identity, identity);
  assert.equal((await cold(s)).recovery.value.status, 'terminal'); assert.equal(await attempts(s), 1);
  // Exercise the actual gateway reconciler against real PostgreSQL events.
  const { reconcileDurableConversationTurn } = await import(aiEntry ? new URL('./server/reconcile-conversation.js', aiEntry).href
    : new URL('../node_modules/@handrail/ai-assistant/dist/server/reconcile-conversation.js', import.meta.url).href);
  await s.events.append({ conversationId: start.conversationId, expectedRevision: null, events: [ai.parseConversationEvent({
    version: 1, conversation_id: start.conversationId, event_id: 'admission', revision: 1,
    occurred_at: '2026-10-03T00:00:00Z', actor: { type: 'user' }, source: { type: 'runtime' },
    payload: { type: 'turn.started', turn_id: start.conversationTurnId, input_message_ids: ['input'] },
  })] });
  const projection = { conversationId: start.conversationId, turnId: start.conversationTurnId, events: s.events, turns: s.store, attribution };
  assert.equal(await reconcileDurableConversationTurn(projection), true);
  const revision = await s.events.getLatestRevision(start.conversationId);
  assert.equal(await reconcileDurableConversationTurn(projection), true);
  assert.equal(await s.events.getLatestRevision(start.conversationId), revision);
  const replay = await ai.replayConversation({ conversationId: start.conversationId, eventStore: s.events, checkpointPolicy: false });
  assert.equal(replay.state.turns.find(x => x.turn_id === start.conversationTurnId).status, 'completed');
  assert.ok(JSON.stringify(replay.state).includes('Reserved synthetic item.')); replay.store.destroy();
  assert.ok(!JSON.stringify([saved, s.diagnostics]).includes('SIMULATED_PRIVATE'));
  console.log(JSON.stringify({ scenario: 'verified-effect-provider-exit', database: 'disposable PostgreSQL 15', runner: 'actual', externalModel: 'simulated', coldProcess: true, effectDispatches: 1, canonical: 'completed', diagnostics: s.diagnostics }));
});

test('research consumer process shutdown disconnects and duplicate resumes recover without a mutation', { timeout: 15000 }, async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const s = await setup(t, { scenario: 'research', modelHooks: { before: async request => {
    entered(); await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); throw Error('SIMULATED_SHUTDOWN');
  } } });
  const opened = await s.durable.startTurn(start); await started;
  await s.runtime.stop(); await idle(s);
  assert.equal((await consume(opened.value.observation)).result.status, 'disconnected');
  const fresh = await composition(s.harness.schema, s.key, { scenario: 'research', worker: 'fresh' }); t.after(() => fresh.close());
  const results = await Promise.all([fresh.durable.recoverTurn(start.conversationId, start.conversationTurnId), fresh.durable.recoverTurn(start.conversationId, start.conversationTurnId)]);
  assert.deepEqual(results.map(r => r.value.status).sort(), ['already_running', 'started']);
  await idle(fresh); assert.equal((await fresh.document()).record.status, 'completed');
  const duplicate = await fresh.durable.startTurn(start); assert.ok(duplicate.ok);
  const output = await consume(duplicate.value.observation);
  assert.equal(output.result.status, 'completed'); assert.ok(output.frames.some(e => e.delta === 'Fallback quote: 21'));
  assert.equal(await attempts(s), 0);
});

for (const stop of [false, true]) test(`unknown effect and disconnected exit preserve receipts; explicit Stop=${stop}`, { timeout: 15000 }, async t => {
  // External mutation acknowledged as unknown; requirement adapter outage forces
  // a nonterminal exit rather than establishing a reconciliation wait.
  const s = await setup(t, { afterEffect: async () => { s.state.uncertain = true; },
    host: { requirement: () => { throw Error('SIMULATED_REQUIREMENT_OUTAGE'); } } });
  const opened = await s.durable.startTurn(start); assert.ok(opened.ok); await idle(s);
  assert.equal((await consume(opened.value.observation)).result.status, 'disconnected');
  assert.equal((await s.journal.load(identity)).value.effects[0].outcome, 'unknown'); assert.equal(await attempts(s), 1);
  if (stop) {
    const cancellation = await s.durable.capabilities.authoritativeCancellation.capability.cancelTurn({ conversationId: start.conversationId,
      turnId: start.conversationTurnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' });
    assert.ok(cancellation.ok); await idle(s);
    assert.equal((await s.document()).record.status, 'cancelled');
    assert.equal((await s.journal.load(identity)).value.state, 'cancelled');
  } else {
    const fresh = await composition(s.harness.schema, s.key, { state: { uncertain: true }, worker: 'unknown' }); t.after(() => fresh.close());
    assert.equal((await fresh.durable.recoverTurn(start.conversationId, start.conversationTurnId)).value.status, 'started'); await idle(fresh);
    assert.equal((await fresh.document()).record.status, 'waiting_for_approval');
    assert.equal((await fresh.journal.load(identity)).value.effects[0].outcome, 'unknown');
    const again = await fresh.delegate.resumeTurn({ conversationId: start.conversationId, turnId: start.conversationTurnId, resumeFrom: empty });
    assert.equal((await consume(again.value)).result.status, 'waiting_for_approval');
  }
  assert.equal(await attempts(s), 1);
});

for (const fence of ['stop', 'grant']) test(`nonterminal exit racing ${fence} keeps current authority`, { timeout: 15000 }, async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const s = await setup(t, { modelHooks: { before: async () => { enter(); await held; throw Error('SIMULATED_PROVIDER_EXIT'); } } });
  const opened = await s.durable.startTurn(start); await entered;
  if (fence === 'stop') {
    assert.ok((await s.durable.capabilities.authoritativeCancellation.capability.cancelTurn({ conversationId: start.conversationId,
      turnId: start.conversationTurnId, mutationId: 'race-stop', idempotencyKey: 'race-stop', reason: 'user' })).ok);
    await within(async () => (await s.journal.load(identity)).value.state === 'cancelled');
  } else s.state.grantRevision++;
  release(); await idle(s);
  const result = await consume(opened.value.observation);
  assert.equal(result.result.status, fence === 'stop' ? 'cancelled' : 'disconnected');
  assert.equal((await s.document()).record.status, fence === 'stop' ? 'cancelled' : 'pending');
  assert.equal(await attempts(s), 0);
  if (fence === 'grant') {
    const before = (await s.journal.load(identity)).value;
    const requests = s.model.requests;
    const delivery = await s.runtime.wake(identity);
    // The old lease can remain live until expiry after a grant change. Busy is
    // also a fenced non-execution result, not authorization to dispatch.
    assert.ok(!delivery.ok || delivery.value === 'busy');
    assert.equal(s.model.requests, requests);
    assert.equal((await s.states.load(identity, s.authority())).ok, false);
    assert.deepEqual((await s.journal.load(identity)).value, before);
  }
});
