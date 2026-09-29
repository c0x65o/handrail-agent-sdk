import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJobSnapshot, validateJobCommand, validateJobEvent, validateJobTransition, validateJobResult } from 'handrail-agent-sdk';

const identity = {
  jobId: 'job-1', originTaskRef: 'task-1', requestKey: 'request-key-1', instructionRevision: 1,
  host: { tenantRef: 'tenant-1', userRef: 'user-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'env-1', purposeRef: 'purpose-1' },
  native: { requestRef: 'request-1', threadRef: 'thread-1', assistantProjectRef: 'assistant-project-1', objectiveRef: 'objective-1', rootTaskRef: 'root-task-1', outcomeRef: 'outcome-1', backingWorkRequestRef: 'backing-1', childWorkRequestRef: 'child-1', turnRef: 'turn-1', runRef: 'run-1', actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', sourceQueue: { queueRef: 'source-queue', messageRef: 'source-message' } },
  origin: { channelRef: 'channel-1', routeRef: 'route-1', correlationRef: 'correlation-1' },
};
const requirement = { kind: 'secure_input', requirementRef: 'requirement-1', revision: 1, actor: { kind: 'user', actorRef: 'user-1' } };
const answer = { requirementRef: 'requirement-1', requirementRevision: 1, responseRef: 'private-response-1' };
const effect = { actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', outcome: 'unknown' };
const states = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];
function snapshot(state, revision = 2) {
  return structuredClone({ identity, revision, effects: [], state,
    ...(state === 'waiting' ? { requirement } : {}),
    ...(state === 'succeeded' ? { receipt: { receiptRef: 'receipt-1', verification: 'host_verified', jobId: identity.jobId, revision } } : {}),
    ...(state === 'failed' ? { error: { code: 'execution_failed', correlationRef: 'correlation-1' } } : {}),
    ...(state === 'cancelled' ? { cancellation: { reason: 'explicit_stop', actorRef: 'user-1' } } : {}),
  });
}
function command(kind, expectedRevision = 2) {
  return structuredClone({ command: kind, identity,
    ...(['answer', 'resume', 'cancel'].includes(kind) ? { expectedRevision } : {}),
    ...(kind === 'events' ? { afterRevision: 1 } : {}),
    ...(kind === 'answer' ? { answer } : {}),
    ...(kind === 'resume' ? { requirementRef: requirement.requirementRef, requirementRevision: 1, resolutionReceiptRef: 'resolution-1' } : {}),
    ...(kind === 'cancel' ? { reason: 'explicit_stop' } : {}),
  });
}
function event(kind, state, previousRevision = 2) {
  const value = { kind, previousRevision, snapshot: snapshot(state, previousRevision + 1) };
  if (kind === 'answered') { value.snapshot.answer = structuredClone(answer); value.command = command('answer', previousRevision); }
  if (kind === 'resumed') value.command = command('resume', previousRevision);
  if (kind === 'cancelled') value.command = command('cancel', previousRevision);
  return value;
}
function valid(result) { assert.equal(result.ok, true, result.code); }
function invalid(result, code) { assert.equal(result.ok, false); if (code) assert.equal(result.code, code); }

for (const state of states) test(`snapshot: ${state}`, () => valid(validateJobSnapshot(snapshot(state))));
const destinations = { queued: 'resumed', running: 'started', waiting: 'waiting', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' };
const allowed = { queued: ['running', 'failed', 'cancelled'], running: ['waiting', 'succeeded', 'failed', 'cancelled'], waiting: ['queued', 'failed', 'cancelled'], succeeded: [], failed: [], cancelled: [] };
for (const from of states) for (const to of states) test(`transition: ${from} -> ${to}`, () => {
  assert.equal(validateJobTransition(snapshot(from), event(destinations[to], to)).ok, allowed[from].includes(to));
});
test('admission is queued at revision 1 with no effects', () => {
  valid(validateJobTransition(null, event('submitted', 'queued', 0)));
  invalid(validateJobTransition(null, event('started', 'running', 0)));
  invalid(validateJobEvent(event('submitted', 'queued', 1)));
  const e = event('submitted', 'queued', 0); e.snapshot.effects = [effect]; invalid(validateJobEvent(e));
});
test('success needs a host-verified receipt bound to job and revision', () => {
  for (const change of [s => delete s.receipt, s => s.receipt.verification = 'model_claimed', s => s.receipt.jobId = 'wrong', s => s.receipt.revision++, s => s.effects.push(effect)]) {
    const s = snapshot('succeeded'); change(s); invalid(validateJobSnapshot(s));
  }
});
test('waiting, answer, resume, new attempt retain original identity', () => {
  const start = snapshot('running');
  const wait = event('waiting', 'waiting'); valid(validateJobTransition(start, wait));
  const answered = event('answered', 'waiting', 3); valid(validateJobCommand(answered.command, wait.snapshot)); valid(validateJobTransition(wait.snapshot, answered));
  const resumed = event('resumed', 'queued', 4);
  resumed.delivery = { attemptRef: 'attempt-2', callbackRef: 'callback-2', queue: { queueRef: 'delivery-queue', messageRef: 'delivery-message' } };
  valid(validateJobTransition(answered.snapshot, resumed));
  assert.deepEqual(resumed.snapshot.identity, identity);
  assert.notEqual(resumed.delivery.queue.messageRef, resumed.snapshot.identity.native.sourceQueue.messageRef);
  assert.deepEqual(start, snapshot('running'));
});
test('every original identity and route leaf is immutable', () => {
  function paths(value, base = []) { return Object.entries(value).flatMap(([k, v]) => typeof v === 'object' ? paths(v, [...base, k]) : [[...base, k]]); }
  for (const path of paths(identity)) {
    const e = event('waiting', 'waiting'); let cursor = e.snapshot.identity;
    for (const key of path.slice(0, -1)) cursor = cursor[key];
    const key = path.at(-1); cursor[key] = typeof cursor[key] === 'number' ? 2 : 'replacement';
    invalid(validateJobTransition(snapshot('running'), e), 'identity_mismatch');
    const c = command('inspect'); c.identity = e.snapshot.identity;
    invalid(validateJobCommand(c, snapshot('running')), 'identity_mismatch');
  }
  const e = event('waiting', 'waiting'); delete e.snapshot.identity.native.requestRef;
  invalid(validateJobTransition(snapshot('running'), e), 'identity_mismatch');
});
test('invalid, duplicate, skipped and stale revisions fail', () => {
  for (const revision of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']) {
    const s = snapshot('running'); s.revision = revision; invalid(validateJobSnapshot(s));
  }
  for (const previous of [0, 1, 3]) invalid(validateJobTransition(snapshot('running'), event('waiting', 'waiting', previous)));
  const e = event('waiting', 'waiting'); e.snapshot.revision++; invalid(validateJobEvent(e));
  invalid(validateJobCommand(command('answer', 1), snapshot('waiting')), 'invalid_revision');
  invalid(validateJobCommand({ ...command('events'), afterRevision: 3 }, snapshot('running')), 'invalid_revision');
});
test('answers and resumes bind the current requirement and reject consumed answers', () => {
  for (const kind of ['answer', 'resume']) for (const field of ['requirementRef', 'requirementRevision']) {
    const c = command(kind); const target = kind === 'answer' ? c.answer : c; target[field] = field === 'requirementRef' ? 'wrong' : 2;
    invalid(validateJobCommand(c, snapshot('waiting')), 'requirement_mismatch');
  }
  const s = snapshot('waiting'); s.answer = answer;
  invalid(validateJobCommand(command('answer'), s), 'requirement_mismatch');
  const stale = event('answered', 'waiting'); stale.snapshot.requirement.revision = 2; invalid(validateJobEvent(stale));
  const e = event('resumed', 'queued'); e.command.requirementRevision = 2;
  invalid(validateJobTransition(snapshot('waiting'), e), 'requirement_mismatch');
  delete e.command; invalid(validateJobEvent(e));
  const changed = event('answered', 'waiting'); changed.command.answer.responseRef = 'other'; invalid(validateJobEvent(changed));
});
test('terminal cancellation rejects resume, answer and repeated cancel; observation is read only', () => {
  const s = snapshot('cancelled');
  for (const kind of ['resume', 'answer', 'cancel']) invalid(validateJobCommand(command(kind), s), 'invalid_transition');
  for (const state of states) {
    const before = snapshot(state), copy = structuredClone(before);
    valid(validateJobCommand(command('inspect'), before)); valid(validateJobCommand(command('events'), before));
    invalid(validateJobCommand({ command: 'dispose', identity }, before));
    invalid(validateJobCommand({ ...command('cancel'), reason: 'view_closed' }, before));
    assert.deepEqual(before, copy);
  }
});
test('unknown effects survive waiting and cancellation; no implicit resolution or replay', () => {
  const s = snapshot('running'); s.effects = [effect];
  for (const [kind, state] of [['waiting', 'waiting'], ['failed', 'failed'], ['cancelled', 'cancelled']]) {
    const e = event(kind, state); e.snapshot.effects = [structuredClone(effect)]; valid(validateJobTransition(s, e));
    e.snapshot.effects = []; invalid(validateJobTransition(s, e), 'effect_conflict');
    e.snapshot.effects = [{ ...effect, outcome: 'verified' }]; invalid(validateJobTransition(s, e), 'effect_conflict');
  }
  const added = event('effects_recorded', 'running'); added.snapshot.effects = [effect]; valid(validateJobTransition(snapshot('running'), added));
  added.snapshot.effects.push(effect); invalid(validateJobSnapshot(added.snapshot));
});
for (const kind of ['submit', 'inspect', 'events', 'answer', 'resume', 'cancel']) test(`command and result: ${kind}`, () => {
  valid(validateJobCommand(command(kind)));
  valid(validateJobResult({ command: kind, ok: false, error: { code: 'not_authorized', correlationRef: 'correlation-1' } }));
  const state = { submit: 'queued', inspect: 'running', answer: 'waiting', resume: 'queued', cancel: 'cancelled' }[kind];
  const s = snapshot(state, kind === 'submit' ? 1 : 2); if (kind === 'answer') s.answer = answer;
  valid(validateJobResult(kind === 'events' ? { command: kind, ok: true, baseline: snapshot('running'), events: [event('waiting', 'waiting')] } : { command: kind, ok: true, snapshot: s }));
});
test('event batches require contiguous revisions, same identity and valid transitions', () => {
  const r = { command: 'events', ok: true, baseline: snapshot('running'), events: [event('waiting', 'waiting'), event('answered', 'waiting', 3), event('resumed', 'queued', 4)] };
  valid(validateJobResult(r));
  for (const change of [r => r.events.reverse(), r => r.events.push(r.events[0]), r => r.events[1].snapshot.identity.jobId = 'wrong', r => r.events[2].command.expectedRevision = 1]) {
    const bad = structuredClone(r); change(bad); invalid(validateJobResult(bad));
  }
});
test('unknown sensitive fields rejected at every nested boundary, without echo', () => {
  const fixtures = [
    ...states.map(s => [snapshot(s), validateJobSnapshot]),
    ...['submit', 'inspect', 'events', 'answer', 'resume', 'cancel'].map(k => [command(k), validateJobCommand]),
    [{ ...event('answered', 'waiting'), delivery: { attemptRef: 'attempt-1', callbackRef: 'callback-1', queue: { queueRef: 'queue-1', messageRef: 'message-1' } } }, validateJobEvent],
    [{ command: 'events', ok: true, baseline: { ...snapshot('running'), effects: [effect] }, events: [] }, validateJobResult],
    [{ command: 'inspect', ok: false, error: { code: 'unavailable', correlationRef: 'correlation-1' } }, validateJobResult],
  ];
  function paths(v, path = []) { return v && typeof v === 'object' ? [path, ...Object.entries(v).flatMap(([k, child]) => paths(child, [...path, k]))] : []; }
  const sensitive = 'SYNTHETIC_SECRET_DO_NOT_ECHO';
  for (const [fixture, validate] of fixtures) for (const path of paths(fixture)) for (const key of ['password', 'provider', 'rawError', sensitive]) {
    const bad = structuredClone(fixture); let cursor = bad; for (const k of path) cursor = cursor[k]; cursor[key] = sensitive;
    const result = validate(bad); invalid(result); assert.equal(JSON.stringify(result).includes(sensitive), false);
  }
});
test('reject malformed objects, getters, symbols, unsafe refs and raw errors safely', () => {
  for (const value of [null, [], new Error('SYNTHETIC'), {}, { state: 'unknown' }]) invalid(validateJobSnapshot(value));
  const s = snapshot('running'); let reads = 0;
  Object.defineProperty(s, 'state', { get() { reads++; throw Error('SYNTHETIC'); } });
  invalid(validateJobSnapshot(s)); assert.equal(reads, 0);
  for (const change of [s => s[Symbol('secret')] = 'SYNTHETIC', s => Object.defineProperty(s, 'hidden', { value: 'SYNTHETIC' }), s => s.identity.origin.routeRef = 'https://invalid/?token=SYNTHETIC', s => s.identity.jobId = 'x'.repeat(129), s => s.effects = Array(2), s => s.effects = Array(257).fill(effect)]) {
    const bad = snapshot('running'); change(bad); invalid(validateJobSnapshot(bad));
  }
  for (const code of ['provider_raw_failure', 'x'.repeat(300)]) invalid(validateJobResult({ command: 'inspect', ok: false, error: { code, correlationRef: 'correlation-1' } }));
});

test('every waiting reason and actor kind requires resolvable references', () => {
  for (const kind of ['approval', 'secure_input', 'provider', 'host', 'reconciliation']) {
    for (const actorKind of ['user', 'provider', 'host']) {
      const s = snapshot('waiting'); s.requirement.kind = kind; s.requirement.actor.kind = actorKind;
      valid(validateJobSnapshot(s));
    }
  }
  for (const change of [s => delete s.requirement, s => delete s.requirement.actor, s => delete s.requirement.actor.actorRef, s => s.requirement.revision = 0, s => s.requirement.kind = 'unknown']) {
    const s = snapshot('waiting'); change(s); invalid(validateJobSnapshot(s));
  }
});
test('command-bound events reject identity, revision and command substitutions', () => {
  for (const [kind, state] of [['answered', 'waiting'], ['resumed', 'queued'], ['cancelled', 'cancelled']]) {
    for (const change of [e => e.command.identity.originTaskRef = 'replacement', e => e.command.expectedRevision++, e => e.command = command('inspect')]) {
      const e = event(kind, state); change(e); invalid(validateJobEvent(e));
    }
  }
});
test('results reject mismatched state and discriminants', () => {
  for (const kind of ['submit', 'answer', 'resume', 'cancel']) {
    invalid(validateJobResult({ command: kind, ok: true, snapshot: snapshot('running') }));
  }
  for (const command of ['unknown', 'dispose']) invalid(validateJobCommand({ command, identity }));
  invalid(validateJobResult({ command: 'inspect', ok: 'true', snapshot: snapshot('running') }));
  invalid(validateJobCommand(command('submit'), snapshot('queued')), 'invalid_transition');
});
