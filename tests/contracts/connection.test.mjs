import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConnectionEnsureInput, validateConnectionEnsureResult, validateConnectionReconnect } from 'handrail-agent-sdk';

const now = 10_000;
const identity = {
  jobId: 'job-1', originTaskRef: 'task-1', requestKey: 'request-1', instructionRevision: 1,
  host: { tenantRef: 'tenant-1', userRef: 'user-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'env-1', purposeRef: 'purpose-1' },
  native: { requestRef: 'native-request-1', threadRef: 'thread-1', actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', sourceQueue: { queueRef: 'queue-1', messageRef: 'message-1' } },
  origin: { channelRef: 'channel-1', routeRef: 'route-1', correlationRef: 'correlation-1' },
};
function request(mode = 'provider') {
  return structuredClone({ operation: 'connection.ensure', identity, connectionRef: 'connection-1', providerRef: 'provider-1',
    prerequisiteVersion: 'prerequisites-v1', minimumCapabilities: ['api.read', 'api.prepare'], evidenceMode: mode,
    effect: { actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1' }, vaultRef: 'vault-1', profileRef: 'profile-1' });
}
const userRequirement = { requirementRef: 'requirement-1', revision: 1, kind: 'approval', reason: 'consent_required', actor: { kind: 'user', actorRef: 'user-1' } };
const providerRequirement = { requirementRef: 'requirement-2', revision: 1, kind: 'provider', reason: 'review_pending', actor: { kind: 'provider', actorRef: 'provider-1' } };
function result(state = 'ready', mode = 'provider') {
  return structuredClone({ request: request(mode), state,
    authorization: state === 'ready' ? { state: 'active', expiresAt: now + 2000 } : { state: 'unverified' },
    ...(state === 'ready' ? { evidence: { kind: 'api_capabilities', receiptRef: 'receipt-1',
      provenance: mode === 'provider' ? { kind: 'provider', verificationRef: 'verification-1' } : { kind: 'fixture', fixtureRef: 'fixture-1' },
      scope: identity.host, providerRef: 'provider-1', prerequisiteVersion: 'prerequisites-v1',
      verifiedCapabilities: ['api.prepare', 'api.read', 'api.extra'], verifiedAt: now - 1000, expiresAt: now + 1000 } } : {}),
    ...(state === 'waiting_for_user' ? { missingRequirements: [userRequirement] } : {}),
    ...(state === 'waiting_for_provider' ? { missingRequirements: [providerRequirement] } : {}),
    ...(state === 'reauthorization_required' ? { reason: 'provider_rejected', missingRequirements: [userRequirement] } : {}),
    ...(state === 'unknown_effect' ? { effect: { ...request().effect, outcome: 'unknown' }, reconciliationRef: 'reconciliation-1' } : {}),
  });
}
const valid = r => assert.equal(r.ok, true, r.code);
function invalid(r, code) { assert.equal(r.ok, false); if (code) assert.equal(r.code, code); }
const validate = (r, at = now) => validateConnectionEnsureResult(r, request(r.request.evidenceMode), at);
const states = ['requested', 'inspecting', 'authenticating', 'configuring', 'verifying', 'waiting_for_user', 'waiting_for_provider', 'reauthorization_required', 'unknown_effect', 'ready'];
for (const mode of ['fixture', 'provider']) for (const state of states) test(`${mode}: ${state}`, () => valid(validate(result(state, mode))));

test('input uses existing job scope, optional custody references and distinct stable effect identity', () => {
  const r = request(); valid(validateConnectionEnsureInput(r));
  delete r.vaultRef; delete r.profileRef; r.identity.native = {}; valid(validateConnectionEnsureInput(r));
  for (const change of [r => r.identity.host.accountRef = null, r => r.identity.instructionRevision = 0,
    r => r.effect.effectRef = 'replacement', r => r.minimumCapabilities = [], r => r.minimumCapabilities = ['api.read', 'api.read'],
    r => r.prerequisiteVersion = '', r => r.operation = 'connect', r => r.evidenceMode = 'any']) {
    const bad = request(); change(bad); invalid(validateConnectionEnsureInput(bad));
  }
});
for (const key of Object.keys(identity.host)) test(`ready rejects wrong evidence scope: ${key}`, () => {
  const r = result(); r.evidence.scope[key] = 'wrong'; invalid(validate(r), 'evidence_mismatch');
});
for (const [name, change, code] of [
  ['provider', r => r.evidence.providerRef = 'wrong', 'evidence_mismatch'],
  ['prerequisite version', r => r.evidence.prerequisiteVersion = 'prerequisites-v2', 'evidence_mismatch'],
  ['missing capability', r => r.evidence.verifiedCapabilities = ['api.read'], 'missing_capability'],
  ['unrelated capability', r => r.evidence.verifiedCapabilities = ['api.other'], 'missing_capability'],
  ['duplicate capability', r => r.evidence.verifiedCapabilities.push('api.read'), 'invalid_payload'],
  ['absent evidence', r => delete r.evidence, 'invalid_payload'],
  ['browser login', r => r.evidence.kind = 'browser_login', 'invalid_payload'],
  ['token presence', r => r.evidence.kind = 'token_present', 'invalid_payload'],
  ['setup grant', r => r.evidence.kind = 'setup_grant', 'invalid_payload'],
  ['spending authority', r => r.spendingAuthorized = true, 'invalid_payload'],
  ['ads authority', r => r.evidence.adsAuthorized = true, 'invalid_payload'],
  ['unverified authorization', r => r.authorization = { state: 'unverified' }, 'invalid_payload'],
  ['expired authorization', r => r.authorization = { state: 'expired', expiresAt: now }, 'invalid_payload'],
  ['revoked authorization', r => r.authorization = { state: 'revoked', revokedAt: now }, 'invalid_payload'],
  ['elapsed active expiry', r => r.authorization.expiresAt = now, 'not_current'],
  ['elapsed evidence expiry', r => r.evidence.expiresAt = now, 'not_current'],
  ['future evidence', r => r.evidence.verifiedAt = now + 1, 'not_current'],
  ['inverted interval', r => r.evidence.expiresAt = r.evidence.verifiedAt, 'not_current'],
  ['fixture evidence for provider', r => r.evidence.provenance = { kind: 'fixture', fixtureRef: 'fixture-1' }, 'provenance_mismatch'],
]) test(`ready rejects ${name}`, () => { const r = result(); change(r); invalid(validate(r), code); });

test('expiry/revocation are valid non-ready reauthorization states, never renewed by validation', () => {
  for (const reason of ['expired', 'revoked', 'scope_changed', 'provider_rejected']) {
    const r = result('reauthorization_required'); r.reason = reason;
    r.authorization = reason === 'expired' ? { state: reason, expiresAt: now } : reason === 'revoked' ? { state: reason, revokedAt: now } : { state: 'unverified' };
    valid(validate(r)); valid(validateConnectionReconnect(result(), r, now));
    if (reason === 'expired' || reason === 'revoked') {
      const field = reason === 'expired' ? 'expiresAt' : 'revokedAt';
      r.authorization[field] = now + 1; invalid(validate(r), 'not_current');
      r.authorization = { state: 'unverified' }; invalid(validate(r));
    }
  }
  invalid(validate(result(), now + 1000), 'not_current');
  const r = result('reauthorization_required'); r.reason = 'expired'; r.authorization = { state: 'expired', expiresAt: now + 2000 };
  valid(validateConnectionReconnect(result(), r, now + 2000)); // Historical readiness can be inspected after expiry.
});
for (const [kind, reason] of [
  ['secure_input', 'credentials_required'], ['secure_input', 'authentication_challenge'],
  ['approval', 'consent_required'], ['approval', 'account_selection'], ['approval', 'authority_required'],
  ['provider', 'review_pending'], ['provider', 'access_level_required'], ['provider', 'account_role_required'],
  ['provider', 'prerequisite_unavailable'], ['provider', 'capability_missing'],
]) test(`typed missing requirement: ${reason}`, () => {
  const r = result(kind === 'provider' ? 'waiting_for_provider' : 'waiting_for_user');
  Object.assign(r.missingRequirements[0], { kind, reason }, reason === 'capability_missing' ? { capabilityRef: 'api.read' } : {});
  valid(validate(r));
  const copy = structuredClone(r); copy.missingRequirements[0].actor.kind = kind === 'provider' ? 'user' : 'provider'; invalid(validate(copy));
});
test('waits require precise, bound, nonempty outstanding requirements', () => {
  for (const change of [r => r.missingRequirements = [], r => r.missingRequirements.push(r.missingRequirements[0]),
    r => r.missingRequirements[0].revision = 0, r => r.missingRequirements[0].reason = 'do_setup',
    r => r.missingRequirements[0].actor.actorRef = 'other-user', r => r.missingRequirements = [providerRequirement]]) {
    const r = result('waiting_for_user'); change(r); invalid(validate(r));
  }
  const r = result('waiting_for_provider'); r.missingRequirements[0].reason = 'capability_missing';
  invalid(validate(r)); r.missingRequirements[0].capabilityRef = 'unrequested'; invalid(validate(r));
  r.missingRequirements = [userRequirement]; invalid(validate(r));
});
function leafPaths(value, base = []) {
  return Object.entries(value).flatMap(([k, v]) => v && typeof v === 'object' ? leafPaths(v, [...base, k]) : [[...base, k]]);
}
test('result correlation and reconnect preserve every original job/task, scope, native, route and request leaf', () => {
  for (const path of leafPaths(request())) {
    const r = result('inspecting'); let cursor = r.request;
    for (const key of path.slice(0, -1)) cursor = cursor[key];
    const key = path.at(-1); cursor[key] = typeof cursor[key] === 'number' ? 2 : 'replacement';
    invalid(validateConnectionEnsureResult(r, request(), now));
    invalid(validateConnectionReconnect(result('requested'), r, now));
  }
  for (const key of ['vaultRef', 'profileRef']) {
    const r = result('inspecting'); delete r.request[key]; invalid(validateConnectionReconnect(result('requested'), r, now));
  }
  const sequence = ['requested', 'waiting_for_user', 'verifying', 'ready', 'reauthorization_required', 'inspecting', 'ready'].map(s => result(s));
  for (let i = 1; i < sequence.length; i++) valid(validateConnectionReconnect(sequence[i - 1], sequence[i], now));
  assert.deepEqual(sequence.at(-1).request.identity, identity);
});
test('fixture receipts cannot be promoted through result binding, reconnect, intermediate states or replay', () => {
  const fixture = result('ready', 'fixture');
  invalid(validateConnectionEnsureResult(fixture, request(), now), 'request_mismatch');
  invalid(validateConnectionReconnect(fixture, result(), now), 'request_mismatch');
  const promoted = structuredClone(fixture); promoted.evidence.provenance = result().evidence.provenance;
  invalid(validateConnectionReconnect(fixture, promoted, now), 'provenance_mismatch');
  const waiting = result('waiting_for_user', 'fixture'); valid(validateConnectionReconnect(fixture, waiting, now));
  invalid(validateConnectionReconnect(waiting, result(), now));
  valid(validateConnectionReconnect(fixture, structuredClone(fixture), now));
  invalid(validateConnectionReconnect(fixture, fixture, now + 1000), 'not_current');
  const changed = structuredClone(fixture); changed.evidence.verifiedAt--;
  invalid(validateConnectionReconnect(fixture, changed, now), 'receipt_conflict');
  const wrong = result('ready', 'fixture'); wrong.evidence.provenance = result().evidence.provenance; invalid(validate(wrong), 'provenance_mismatch');
});
test('unknown effects require the original logical effect and reconciliation reference; reconnect cannot clear or replay them', () => {
  const r = result('unknown_effect'); valid(validateConnectionReconnect(r, structuredClone(r), now));
  for (const key of ['actionRef', 'operationRef', 'effectRef']) {
    const bad = structuredClone(r); bad.effect[key] = 'replacement'; invalid(validate(bad), 'effect_conflict');
  }
  for (const change of [r => delete r.reconciliationRef, r => r.effect.outcome = 'not_applied', r => r.effect.outcome = 'verified']) {
    const bad = structuredClone(r); change(bad); invalid(validate(bad));
  }
  const renamed = structuredClone(r); renamed.reconciliationRef = 'replacement'; invalid(validateConnectionReconnect(r, renamed, now), 'effect_conflict');
  for (const state of states.filter(s => s !== 'unknown_effect')) invalid(validateConnectionReconnect(r, result(state), now), 'effect_conflict');
});
test('pure validation returns original values and leaves frozen inputs unchanged', () => {
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  const r = freeze(result()), original = structuredClone(r);
  assert.equal(validateConnectionEnsureInput(r.request).value, r.request);
  assert.equal(validate(r).value, r);
  valid(validateConnectionReconnect(r, r, now)); assert.deepEqual(r, original);
});
test('nested payloads, errors, getters, hidden keys and malformed arrays fail without raw output', () => {
  const marker = 'SYNTHETIC_PRIVATE_VALUE';
  function paths(v, path = []) { return v && typeof v === 'object' ? [path, ...Object.entries(v).flatMap(([k, child]) => paths(child, [...path, k]))] : []; }
  for (const state of states) for (const path of paths(result(state))) {
    const r = result(state); let target = r; for (const key of path) target = target[key]; target.rawPayload = marker;
    const response = validate(r); invalid(response); assert.deepEqual(response, { ok: false, code: 'invalid_payload' });
  }
  for (const value of [null, {}, [], new Error(marker), new Proxy({}, { getPrototypeOf() { throw new Error(marker); } })]) {
    invalid(validateConnectionEnsureInput(value)); invalid(validateConnectionEnsureResult(value, request(), now));
    invalid(validateConnectionReconnect(value, result(), now));
  }
  let reads = 0;
  const r = result(); Object.defineProperty(r.evidence, 'kind', { get() { reads++; throw new Error(marker); } }); invalid(validate(r)); assert.equal(reads, 0);
  for (const change of [r => r[Symbol('private')] = marker, r => Object.defineProperty(r, 'hidden', { value: marker }),
    r => r.request.vaultRef = 'https://invalid/?token=synthetic', r => r.request.profileRef = 'x'.repeat(129),
    r => r.evidence.verifiedCapabilities = Array(2), r => r.evidence.verifiedCapabilities = Array(257).fill('api.read'),
    r => r.evidence.verifiedAt = NaN, r => r.authorization.expiresAt = Infinity,
    r => r.evidence.expiresAt = Number.MAX_SAFE_INTEGER + 1]) {
    const bad = result(); change(bad); const response = validate(bad); invalid(response); assert.equal(JSON.stringify(response).includes(marker), false);
  }
  for (const clock of [-1, NaN, Infinity, 1.5, '10000']) invalid(validate(result(), clock));
});
