import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createBrowserUse } from 'handrail-agent-sdk/server';
import { createEffectStore } from 'handrail-agent-sdk/server/postgres';
import { createPostgresHarness, migrations } from './fixtures/installed/database.mjs';
import { services, identity, requirement } from './fixtures/installed/host.mjs';
import { fixture, bind, observation } from './helpers/browser-use-fixture.mjs';
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };

async function setup(t, mode = 'sanitized') {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  await migrations(t, harness);
  let s, browser, original, dispatches = 0, projections = 0;
  const f = fixture(identity, Date.now());
  const reserve = { name: 'reserve', kind: 'browser', description: 'Inspect synthetic account points.',
    parameters: z.object({ itemRef: z.literal('synthetic-item') }).strict(),
    bind: async call => {
      if (!original) {
        const job = ok(await s.journal.load(identity));
        original = { ...f.request, jobRevision: job.revision, effect: { ...f.request.effect, effectRef: call.effectRef } };
      }
      return structuredClone(original);
    },
    browser: { execute: (...args) => browser.execute(...args), observe: (...args) => browser.observe(...args) },
    readResult: async () => { projections++; return JSON.stringify({ points: 12345 }); },
  };
  s = await services(harness.schema, randomBytes(32).toString('hex'), { reserve }); t.after(() => s.close());
  browser = createBrowserUse({ now: Date.now, withAuthority: async (request, phase, run) => {
    const current = ok(await s.journal.load(identity));
    // The fixture owns this immutable operation and normalizes only its own
    // effect-ledger revision. Production hosts must hold native fences here.
    const context = { ...f.context, currentJob: { ...current, revision: request.jobRevision,
      effects: current.effects.filter(e => e.effectRef !== request.effect.effectRef) }, admittedOperation: original };
    return run({ authority: s.authority(), context: () => context,
      canObserve: o => !s.state.denied && o.request.effect.effectRef === original.effect.effectRef });
  } }, createEffectStore(s.pool, harness.schema), [{ operationRef: 'browser-operation', bind,
    dispatch: async (_r, _signal, current) => { assert.equal(current(), true); dispatches++; return 'verified'; },
    reconcile: async () => mode === 'unknown' ? 'unknown' : dispatches ? 'verified' : 'not_applied',
    observe: async r => mode === 'takeover'
      ? { request: r, effect: { ...r.effect, outcome: 'verified' }, kind: 'takeover', requirement: requirement('approval') }
      : mode === 'redacted' ? { request: r, effect: { ...r.effect, outcome: 'verified' }, kind: 'redacted', status: 'observation_withheld' }
      : observation(r),
  }]);
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'browser-task', inputRefs: {} }, event: { kind: 'submitted', previousRevision: 0,
      snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  return { ...s, harness, counts: () => ({ dispatches, projections }) };
}
test('browser tool runs through the real Runner and PostgreSQL effect ledger', async t => {
  const s = await setup(t);
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.counts(), { dispatches: 1, projections: 1 });
  const job = ok(await s.journal.load(identity));
  assert.equal(job.effects.length, 1); assert.equal(job.effects[0].outcome, 'verified');
  const checkpoint = ok(await s.states.load(identity, s.authority()));
  assert.ok(Object.values(checkpoint.results).some(r => r.output === '{"points":12345}'));
});
test('browser takeover waits on the original job and handback does not replay the action', async t => {
  const s = await setup(t, 'takeover');
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  const waiting = ok(await s.journal.load(identity));
  assert.equal(waiting.requirement.kind, 'approval'); assert.equal(waiting.identity.jobId, identity.jobId);
  assert.deepEqual(s.counts(), { dispatches: 1, projections: 0 });
  s.state.resolution = { receiptRef: 'verified-handback', input: 'Human verification complete; use fresh browser admissions for further actions.' };
  ok(await s.answer.issue({ identity, requirement: waiting.requirement, jobRevision: waiting.revision,
    resolverRef: identity.host.userRef, expiresAt: Date.now() + 30000 }));
  ok(await s.answer.complete({ identity, requirementRef: waiting.requirement.requirementRef,
    requirementRevision: waiting.requirement.revision, resolverRef: identity.host.userRef,
    deliveryKey: 'handback', status: 'verified', responseRef: 'verified-handback' }));
  ok(await s.runtime.resume(identity));
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.counts(), { dispatches: 1, projections: 0 });
});
test('unknown browser results wait for reconciliation without dispatch or domain projection', async t => {
  const s = await setup(t, 'unknown');
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  assert.equal(ok(await s.journal.load(identity)).requirement.kind, 'reconciliation');
  assert.deepEqual(s.counts(), { dispatches: 0, projections: 0 });
});
test('Stop during a browser handoff prevents answer delivery and resumption', async t => {
  const s = await setup(t, 'takeover');
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  const waiting = ok(await s.journal.load(identity));
  ok(await s.answer.issue({ identity, requirement: waiting.requirement, jobRevision: waiting.revision,
    resolverRef: identity.host.userRef, expiresAt: Date.now() + 30000 }));
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: waiting.revision, reason: 'explicit_stop' }, identity.host.userRef));
  const delivered = await s.answer.complete({ identity, requirementRef: waiting.requirement.requirementRef,
    requirementRevision: waiting.requirement.revision, resolverRef: identity.host.userRef,
    deliveryKey: 'late-handback', status: 'verified', responseRef: 'late-answer' });
  assert.equal(delivered.ok, false); assert.equal((await s.runtime.resume(identity)).ok, false);
  assert.equal(ok(await s.journal.load(identity)).state, 'cancelled');
  assert.deepEqual(s.counts(), { dispatches: 1, projections: 0 });
});
test('withheld observations cannot trigger a domain reader', async t => {
  const s = await setup(t, 'redacted');
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.counts(), { dispatches: 1, projections: 0 });
});
