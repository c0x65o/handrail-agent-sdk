import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateManifest } from '../scripts/validate-convergence-v1.mjs';

const baseline = JSON.parse(readFileSync(new URL('../fixtures/convergence-v1.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(baseline);
function reject(change, code) {
  const manifest = copy();
  change(manifest);
  // Compare only the fixed validation result, never a potentially unsafe payload.
  assert.deepEqual(validateManifest(manifest), { ok: false, code });
}
const ready = m => m.workflow.steps.find(s => s.connection.state === 'ready');
const answer = m => m.workflow.steps.find(s => s.event?.kind === 'answered');

test('valid baseline: contract-compatible fixture, all cases still unverified', () => {
  assert.deepEqual(validateManifest(baseline), { ok: true, caseCount: 42, proof: 'manifest_consistency_only' });
  assert.ok(baseline.cases.every(c => c.observed.status === 'unverified'));
});
test('duplicate case IDs are rejected', () => reject(m => m.cases.push(m.cases[0]), 'duplicate_case_id'));
for (const milestone of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) test(`missing coverage: ${milestone}`, () =>
  reject(m => { m.cases = m.cases.filter(c => c.milestone !== milestone); }, 'missing_milestone'));
test('removing one promise while retaining all milestones is rejected', () => reject(m => m.cases.pop(), 'missing_case'));
test('both-host acceptance cannot silently drop a host', () => reject(m => {
  m.cases.find(c => c.id === 'ASDK-V1-M6-CONFORMANCE').owner.hosts = ['handrail'];
}, 'invalid_owner'));
for (const observed of [
  { status: 'passed', evidence: [] },
  { status: 'passed', evidence: ['fixture.capability-receipt'] },
  { status: 'provider_verified', evidence: ['fixture.capability-receipt'] },
  { status: 'unverified', evidence: ['fixture.capability-receipt'] },
  { status: 'unverified', evidence: [], ready: true },
]) test(`unsupported result claim: ${observed.status}/${Object.keys(observed).length}/${observed.evidence.length}`, () =>
  reject(m => { m.cases[0].observed = observed; }, 'unsupported_acceptance_claim'));
test('boolean ready cannot replace expected acceptance', () => reject(m => { m.cases[0].expected.ready = true; }, 'invalid_expectation'));
test('required evidence and failure conditions cannot be omitted', () => {
  for (const key of ['requiredEvidence', 'failureConditions']) reject(m => { m.cases[0].expected[key] = []; }, 'invalid_expectation');
});
test('provider proof cannot be downgraded to fixture proof', () => reject(m => {
  m.cases.find(c => c.milestone === 'M4').expected.proofClass = 'structural_fixture';
}, 'invalid_expectation'));
test('fixture receipt cannot be relabelled as provider', () => reject(m => {
  ready(m).connection.evidence.provenance = { kind: 'provider', verificationRef: 'fixture.capability-receipt' };
}, 'fixture_provenance_required'));
test('coordinated provider promotion cannot create a provider workflow', () => reject(m => {
  m.workflow.evidenceMode = 'provider'; m.workflow.request.evidenceMode = 'provider';
  for (const s of m.workflow.steps) {
    s.connection.request.evidenceMode = 'provider';
    if (s.connection.state === 'ready') s.connection.evidence.provenance = { kind: 'provider', verificationRef: 'fixture.capability-receipt' };
  }
}, 'fixture_provenance_required'));
function leaves(value, prefix = []) {
  return Object.entries(value).flatMap(([key, child]) => child !== null && typeof child === 'object'
    ? leaves(child, [...prefix, key]) : [[...prefix, key]]);
}
function replace(object, path) {
  const target = path.slice(0, -1).reduce((v, k) => v[k], object), key = path.at(-1);
  target[key] = typeof target[key] === 'number' ? target[key] + 1 : 'fixture.changed';
}
for (const path of leaves(baseline.workflow.identity)) test(`original identity survives restart: ${path.join('.')}`, () => reject(m => {
  replace(m.workflow.steps.find(s => s.kind === 'restart').snapshot.identity, path);
}, 'original_identity_changed'));
test('coordinated rewrite of every original identity still differs from typed fixture', () => reject(m => {
  const rewrite = value => {
    if (!value || typeof value !== 'object') return;
    if ('originTaskRef' in value) value.originTaskRef = 'fixture.replacement-task';
    for (const child of Object.values(value)) rewrite(child);
  };
  rewrite(m.workflow);
}, 'typed_fixture_mismatch'));
for (const field of ['actionRef', 'operationRef', 'effectRef']) test(`connection effect identity preserved: ${field}`, () => reject(m => {
  m.workflow.steps[4].connection.request.effect[field] = 'fixture.changed';
}, 'original_identity_changed'));
test('stale answer revision is rejected', () => reject(m => {
  answer(m).event.command.answer.requirementRevision++;
}, 'invalid_job_transition'));
test('challenge identity cannot change on reconnect', () => reject(m => {
  m.workflow.steps[2].connection.missingRequirements[0].requirementRef = 'fixture.changed';
}, 'challenge_changed'));
test('duplicate cannot append a new journal event', () => reject(m => {
  const step = m.workflow.steps[3];
  step.kind = 'append'; step.event = structuredClone(m.workflow.steps[2].event); delete step.snapshot;
}, 'invalid_job_transition'));
test('restart cannot advance journal revision', () => reject(m => { m.workflow.steps[4].snapshot.revision++; }, 'invalid_replay'));
test('delivery attempts stay distinct from logical identity', () => reject(m => {
  m.workflow.steps[4].delivery.attemptRef = m.workflow.steps[3].delivery.attemptRef;
}, 'duplicate_delivery_attempt'));
for (const dimension of ['tenantRef', 'accountRef', 'environmentRef']) test(`ready evidence is scoped: ${dimension}`, () => reject(m => {
  ready(m).connection.evidence.scope[dimension] = 'fixture.other';
}, 'invalid_connection_result'));
test('expired fixture capability evidence is rejected', () => reject(m => {
  const s = ready(m); s.connection.evidence.expiresAt = s.now;
}, 'invalid_connection_result'));
test('changed capability ceiling is rejected', () => reject(m => {
  ready(m).connection.request.minimumCapabilities.push('fixture.api.extra');
}, 'original_identity_changed'));
test('unknown effect stays accounted for in the journal', () => reject(m => {
  m.workflow.steps[8].event.snapshot.effects = [];
}, 'unknown_effect_missing'));
test('restart cannot resolve an unknown effect', () => reject(m => {
  m.workflow.steps.at(-1).snapshot.effects[0].outcome = 'verified';
}, 'invalid_replay'));
test('no unsupported connection reconciliation transition is admitted', () => reject(m => {
  const step = m.workflow.steps.at(-1);
  step.kind = 'append'; delete step.snapshot;
  step.event = { kind: 'effects_recorded', previousRevision: 7,
    snapshot: { ...structuredClone(m.workflow.steps[8].event.snapshot), revision: 8 } };
  step.connection = structuredClone(ready(m).connection);
}, 'invalid_connection_reconnect'));
test('undeclared data is rejected with no payload reflection', () => {
  reject(m => { ready(m).connection.rawOutput = 'fixture.rejected-marker'; }, 'invalid_connection_result');
  reject(m => { m.workflow.steps[0].delivery.rawOutput = 'fixture.rejected-marker'; }, 'typed_fixture_mismatch');
  reject(m => { m.cases[0].retainedPayload = 'fixture.rejected-marker'; }, 'invalid_case');
});
test('only fixed timestamps and reviewed synthetic aliases are allowed', () => {
  reject(m => { m.workflow.steps[1].now++; }, 'typed_fixture_mismatch');
  reject(m => { ready(m).connection.evidence.receiptRef = 'fixture.unreviewed'; }, 'typed_fixture_mismatch');
});
test('invalid inputs return fixed codes and do not throw', () => {
  for (const value of [null, true, [], {}, { schemaVersion: 1 }, { ...copy(), workflow: null }]) {
    assert.deepEqual(validateManifest(value), { ok: false, code: 'invalid_manifest' });
  }
});
