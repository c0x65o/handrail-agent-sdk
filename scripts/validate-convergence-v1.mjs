import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  validateJobSnapshot, validateJobTransition, validateConnectionEnsureInput,
  validateConnectionEnsureResult, validateConnectionReconnect,
} from 'handrail-agent-sdk';
import { workflow as typedWorkflow } from '../.acceptance-build/convergence-v1.js';

// Stable coverage floor. Removing a promise requires an explicit baseline review,
// not just deleting its row from the manifest. This is not a runtime test runner.
const requiredCases = {
  M1: 'CONTRACTS OWNERSHIP BOUNDARIES QUALIFICATION BASELINE',
  M2: 'ADMISSION IDEMPOTENCY LEASES ANSWERS CANCELLATION UNKNOWN',
  M3: 'LOGIN API IDENTITY PAYMENT SHARING REVOCATION CUSTODY ISOLATION RESTORE TAKEOVER FILL CAPTURE TRANSFERS REDACTION',
  M4: 'PREREQUISITES CONNECT RESUME RECOVERY UNKNOWN',
  M5: 'PORTABILITY TOOLS EVENTS SCHEDULES CHANNELS',
  M6: 'CONFORMANCE REFERENCE RUNTIME-QA SECURITY-QA INSTALL OPERATIONS RELEASE',
};
const specialProof = {
  'M1-CONTRACTS': 'structural_fixture', 'M1-OWNERSHIP': 'source_review', 'M1-BOUNDARIES': 'source_review',
  'M1-QUALIFICATION': 'independent_security_qa', 'M1-BASELINE': 'structural_fixture',
  'M3-CUSTODY': 'independent_security_qa', 'M3-REDACTION': 'independent_security_qa',
  'M5-CHANNELS': 'structural_fixture', 'M6-RUNTIME-QA': 'independent_runtime_qa',
  'M6-SECURITY-QA': 'independent_security_qa', 'M6-INSTALL': 'clean_git_install',
  'M6-OPERATIONS': 'source_review', 'M6-RELEASE': 'installed_runtime_release',
};
const required = new Map(Object.entries(requiredCases).flatMap(([milestone, suffixes]) =>
  suffixes.split(' ').map(suffix => [`ASDK-V1-${milestone}-${suffix}`, {
    milestone, proof: specialProof[`${milestone}-${suffix}`] ?? (milestone === 'M4' ? 'authorized_provider' : 'synthetic_runtime'),
    hosts: milestone === 'M4' ? ['handrail-marketing'] : milestone === 'M1' && suffix === 'OWNERSHIP'
      ? ['handrail'] : milestone === 'M6' && suffix === 'REFERENCE' ? ['reference-node'] : ['handrail', 'reference-node'],
  }])));
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1500;
const texts = value => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(text);
const keys = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), names.split(' ').sort());
function require(condition, code) { if (!condition) throw new Error(code); }

function validateWorkflow(w) {
  require(w.evidenceMode === 'fixture' && w.request.evidenceMode === 'fixture', 'fixture_provenance_required');
  require(validateConnectionEnsureInput(w.request).ok, 'invalid_connection_request');
  require(same(w.identity, w.request.identity), 'original_identity_changed');
  require(Array.isArray(w.steps) && w.steps.length > 0, 'invalid_workflow');
  let previous = null, previousConnection = null, previousTime = -1;
  const attempts = new Set();
  for (const step of w.steps) {
    require(Number.isSafeInteger(step.now) && step.now > previousTime, 'invalid_fixture_clock');
    previousTime = step.now;
    require(!attempts.has(step.delivery.attemptRef), 'duplicate_delivery_attempt');
    attempts.add(step.delivery.attemptRef);
    const snapshot = step.kind === 'append' ? step.event.snapshot : step.snapshot;
    require(validateJobSnapshot(snapshot).ok, 'invalid_job_snapshot');
    require(same(snapshot.identity, w.identity) && same(step.connection.request, w.request), 'original_identity_changed');
    if (snapshot.state === 'waiting') require(same(snapshot.requirement, w.requirement), 'challenge_changed');
    if (step.kind === 'append') {
      require(validateJobTransition(previous, step.event).ok, 'invalid_job_transition');
    } else {
      require(['duplicate', 'restart'].includes(step.kind) && same(snapshot, previous)
        && same(step.connection, previousConnection), 'invalid_replay');
    }
    const connection = step.connection;
    require(connection.request.evidenceMode === 'fixture'
      && (connection.state !== 'ready' || connection.evidence.provenance.kind === 'fixture'), 'fixture_provenance_required');
    require(validateConnectionEnsureResult(connection, w.request, step.now).ok, 'invalid_connection_result');
    if (previousConnection) require(validateConnectionReconnect(previousConnection, connection, step.now).ok, 'invalid_connection_reconnect');
    if ('missingRequirements' in connection) {
      require(connection.missingRequirements.every(r => r.requirementRef === w.requirement.requirementRef
        && r.revision === w.requirement.revision && same(r.actor, w.requirement.actor)), 'challenge_changed');
    }
    if (connection.state === 'unknown_effect') require(snapshot.effects.some(e => same(e, connection.effect)), 'unknown_effect_missing');
    previous = snapshot;
    previousConnection = connection;
  }
  // Exact reviewed synthetic aliases/times/structure, not a regex secret detector.
  // This also catches a coordinated identity/provenance rewrite of the whole file.
  require(same(w, typedWorkflow), 'typed_fixture_mismatch');
}

/** Baseline-only validator. It deliberately cannot certify any acceptance case. */
export function validateManifest(manifest) {
  try {
    require(keys(manifest, 'schemaVersion authority source cases workflow') && manifest.schemaVersion === 1, 'invalid_manifest');
    require(same(manifest.authority, {
      ownerGoalId: '1b13c4ab-38c2-4d78-a5cb-238e2f257c62', ownerTaskId: '7ccb807a-4e38-42c7-bf23-73d62adec118',
      itemId: 'f0881bfd-7aec-41d3-96d2-f8c82b536efb', baseline: 'revised-owner-goal-v1',
    }), 'invalid_authority');
    require(same(manifest.source, { branch: 'lane/agent-sdk-v1', baseCommit: '04e8a72b4e5093753d9b03aa4adc62e2b3292383' }), 'invalid_source');
    require(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'invalid_cases');
    const ids = new Set(), milestones = new Set();
    for (const c of manifest.cases) {
      require(keys(c, 'id milestone title owner expected observed'), 'invalid_case');
      require(!ids.has(c.id), 'duplicate_case_id');
      ids.add(c.id); milestones.add(c.milestone);
      const spec = required.get(c.id);
      require(spec && spec.milestone === c.milestone, 'invalid_case_id');
      require(text(c.title) && keys(c.owner, 'surface hosts') && text(c.owner.surface) && texts(c.owner.hosts)
        && same([...c.owner.hosts].sort(), spec.hosts), 'invalid_owner');
      require(keys(c.expected, 'proofClass outcome requiredEvidence failureConditions')
        && c.expected.proofClass === spec.proof && text(c.expected.outcome)
        && texts(c.expected.requiredEvidence) && texts(c.expected.failureConditions), 'invalid_expectation');
      // Results belong in separately reviewed evidence artifacts. Even a fabricated
      // receipt reference or successful local validator cannot support a pass here.
      require(same(c.observed, { status: 'unverified', evidence: [] }), 'unsupported_acceptance_claim');
    }
    require(same([...milestones].sort(), Object.keys(requiredCases)), 'missing_milestone');
    require(same([...ids].sort(), [...required.keys()].sort()), 'missing_case');
    validateWorkflow(manifest.workflow);
    return { ok: true, caseCount: required.size, proof: 'manifest_consistency_only' };
  } catch (error) {
    // Never echo payloads, paths, keys, exception text or secret-derived data.
    const codes = new Set(['invalid_manifest', 'invalid_authority', 'invalid_source', 'invalid_cases', 'invalid_case',
      'duplicate_case_id', 'invalid_case_id', 'invalid_owner', 'invalid_expectation', 'unsupported_acceptance_claim',
      'missing_milestone', 'missing_case', 'fixture_provenance_required', 'invalid_connection_request',
      'original_identity_changed', 'invalid_workflow', 'invalid_fixture_clock', 'duplicate_delivery_attempt',
      'invalid_job_snapshot', 'challenge_changed', 'invalid_job_transition', 'invalid_replay',
      'invalid_connection_result', 'invalid_connection_reconnect', 'unknown_effect_missing', 'typed_fixture_mismatch']);
    return { ok: false, code: codes.has(error?.message) ? error.message : 'invalid_manifest' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = validateManifest(JSON.parse(readFileSync(process.argv[2] ?? new URL('../fixtures/convergence-v1.json', import.meta.url), 'utf8')));
  } catch { result = { ok: false, code: 'manifest_read_failed' }; }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
