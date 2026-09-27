import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateBrowserProfile, validateBrowserLease, validateBrowserLeaseSuccessor,
  validateBrowserOperationSchema, validateBrowserOperation, validateBrowserObservation,
  validateBrowserTakeover, validateBrowserTakeoverTransition, validateBrowserRevocationResult,
} from 'handrail-agent-sdk';

const now = 2000;
const clone = v => structuredClone(v);
const identity = {
  jobId: 'job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'test', purposeRef: 'purpose' },
  native: { requestRef: 'native-request', sourceQueue: { queueRef: 'queue', messageRef: 'message' } },
  origin: { channelRef: 'channel', routeRef: 'route', correlationRef: 'correlation' },
};
const profile = {
  reference: { profileRef: 'profile', revision: 1, scope: clone(identity.host) }, state: 'active',
  custody: { protection: 'authenticated_encryption', custodianRef: 'custodian', envelopeRevision: 1, keyVersionRef: 'key-version' },
};
const lease = {
  leaseRef: 'lease', profile: clone(profile.reference), sessionRef: 'session', owner: { kind: 'agent', ownerRef: 'worker' },
  revision: 1, epoch: 5, issuedAt: 1000, expiresAt: 5000,
};
const document = {
  tabRef: 'tab', origin: 'https://fixture.example', documentRef: 'document', navigationRevision: 1,
  frames: [{ frameRef: 'top', origin: 'https://fixture.example' }, { frameRef: 'child', origin: 'https://frame.example' }],
};
const effect = { actionRef: 'action', operationRef: 'operation', effectRef: 'effect' };
const operation = { identity, jobRevision: 2, lease, document, effect, action: { kind: 'inspect' } };
const requirement = { kind: 'approval', requirementRef: 'challenge', revision: 1, actor: { kind: 'user', actorRef: 'user' } };
const requested = {
  takeoverRef: 'takeover', identity, jobRevision: 2, requirement, revision: 1, issuedAt: 1000, expiresAt: 4500, lease, state: 'requested',
};
const leased = { ...clone(requested), state: 'leased', revision: 2, lease: {
  ...clone(lease), owner: { kind: 'human', ownerRef: 'user' }, revision: 2, epoch: 6, issuedAt: 1500, expiresAt: 4000,
} };
const handback = { ...clone(leased), state: 'handed_back', revision: 3, authorizationRef: 'fresh', authorizationRevision: 1,
  lease: { ...clone(lease), revision: 3, epoch: 7, issuedAt: 1900, expiresAt: 4000 } };
const sanitized = {
  request: operation, effect: { ...effect, outcome: 'verified' }, kind: 'sanitized',
  attestation: { adapterRef: 'adapter', qualificationRef: 'qualification', policyRevision: 1,
    sessionRef: 'session', leaseEpoch: 5, operationRef: 'operation', receiptRef: 'receipt' },
  facts: [{ kind: 'document_ready', subjectRef: 'document' }],
};
function opContext(r = operation) {
  return { currentJob: { identity: clone(identity), revision: 2, state: 'running', effects: [] }, profile: clone(profile),
    currentLease: clone(lease), authenticated: true, authorized: true, taskExpiresAt: 6000,
    admittedOperation: clone(r), nonSensitiveTextAuthorized: true, transferAuthorized: true };
}
function takeoverContext(previous = null) {
  return { currentJob: { identity: clone(identity), revision: 2, state: 'waiting', effects: [], requirement: clone(requirement) },
    profile: clone(profile), currentLease: clone(previous?.lease ?? lease), authenticated: true, authorized: true, taskExpiresAt: 6000,
    previous: clone(previous), priorControllerFenced: true, previousAuthorizationRef: 'old',
    handbackAuthorization: { authorizationRef: 'fresh', revision: 1, leaseEpoch: 7, jobRevision: 2,
      requirementRef: 'challenge', requirementRevision: 1, issuedAt: 1900, expiresAt: 4000 } };
}
function vaultContext(r) {
  const capture = r.action.kind === 'vault_capture';
  const request = { identity: clone(identity), jobRevision: 2, grantRef: 'grant', grantRevision: 1, effect: clone(effect),
    operation: capture ? 'capture' : 'fill',
    item: { metadata: { kind: 'login', credential: 'password' }, reference: { kind: 'secret', itemRef: 'item', revision: 1 } },
    destination: { origin: document.origin, profileRef: 'profile', leaseEpoch: 5, documentRef: 'document', navigationRevision: 1,
      frames: clone(document.frames), fieldRef: 'password-field', fieldKind: 'password', formEndpoint: 'https://fixture.example/login' } };
  return { currentJob: opContext().currentJob, item: clone(request.item), authenticated: true, authenticatedActor: { kind: 'user', actorRef: 'user' },
    authorized: true, itemAuthorized: true, itemState: 'active', itemExpiresAt: 6000, taskExpiresAt: 6000, maxLifetimeMs: 300_000,
    grant: { request, issuedAt: 1000, expiresAt: 4000, state: 'active', permissions: { use: true, reveal: false, export: false } } };
}
function accept(result) { assert.equal(result.ok, true, JSON.stringify(result)); }
function deny(result) { assert.equal(result.ok, false); assert.deepEqual(Object.keys(result).sort(), ['code', 'ok']); assert.match(result.code, /^(invalid_payload|binding_mismatch|not_current|not_authorized|effect_conflict|invalid_transition)$/); }
function set(v, path, replacement) { const parts = path.split('.'); let parent = v; for (const k of parts.slice(0, -1)) parent = parent[k]; parent[parts.at(-1)] = replacement; }
function leaves(v, prefix = '') {
  return Object.entries(v).flatMap(([k, child]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return child !== null && typeof child === 'object' ? leaves(child, path) : [[path, child]];
  });
}
function changed(v) { return typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : `${v}-other`; }
const actions = [
  { kind: 'navigate', destinationRef: 'destination' }, { kind: 'inspect' }, { kind: 'locate', locatorRef: 'locator' },
  { kind: 'click', elementRef: 'element' }, { kind: 'type', elementRef: 'element', textRef: 'approved-text' },
  { kind: 'tab_open', destinationRef: 'destination' }, { kind: 'tab_select', tabRef: 'tab' }, { kind: 'tab_close', tabRef: 'tab' },
  { kind: 'wait', condition: 'document_ready', timeoutMs: 100 }, { kind: 'wait', condition: 'element_visible', elementRef: 'element', timeoutMs: 100 },
  { kind: 'wait', condition: 'element_hidden', elementRef: 'element', timeoutMs: 100 },
  ...['upload', 'download'].map(kind => ({ kind, elementRef: 'element', artifact: { artifactRef: 'artifact', revision: 1, scope: clone(identity.host) } })),
  ...['vault_fill', 'vault_capture'].map(kind => ({ kind, grantRef: 'grant', grantRevision: 1 })),
];
for (const action of actions) test(`accept representative action ${action.kind}/${action.condition ?? ''}`, () => {
  const r = { ...clone(operation), action }, c = opContext(r);
  if (action.kind.startsWith('vault_')) c.vaultUse = vaultContext(r);
  accept(validateBrowserOperationSchema(r)); accept(validateBrowserOperation(r, c, now));
});
test('profile, lease and fenced successor shapes', () => {
  accept(validateBrowserProfile(profile)); accept(validateBrowserLease(lease));
  accept(validateBrowserLeaseSuccessor(leased.lease, lease, now));
  for (const key of ['epoch', 'revision']) {
    const l = clone(leased.lease); l[key] = lease[key]; deny(validateBrowserLeaseSuccessor(l, lease, now));
  }
  for (const at of [999, 4000]) deny(validateBrowserLeaseSuccessor(leased.lease, lease, at));
  const max = { ...clone(lease), epoch: Number.MAX_SAFE_INTEGER };
  deny(validateBrowserLeaseSuccessor({ ...clone(max), epoch: max.epoch + 1 }, max, now));
});
for (const dimension of Object.keys(identity.host)) test(`independent scope rejection: ${dimension}`, () => {
  const r = clone(operation); r.lease.profile.scope[dimension] = 'other';
  deny(validateBrowserOperationSchema(r));
  r.identity.host[dimension] = 'other'; accept(validateBrowserOperationSchema(r)); deny(validateBrowserOperation(r, opContext(), now));
  const c = opContext(); c.profile.reference.scope[dimension] = 'other'; deny(validateBrowserOperation(operation, c, now));
  const next = clone(leased.lease); next.profile.scope[dimension] = 'other'; deny(validateBrowserLeaseSuccessor(next, lease, now));
  const upload = { ...clone(operation), action: clone(actions.find(a => a.kind === 'upload')) };
  upload.action.artifact.scope[dimension] = 'other'; deny(validateBrowserOperationSchema(upload));
  const t = clone(handback); t.identity.host[dimension] = 'other'; t.lease.profile.scope[dimension] = 'other';
  deny(validateBrowserTakeoverTransition(t, takeoverContext(leased), now));
});
for (const [path, v] of leaves(operation)) test(`operation binds admitted request leaf: ${path}`, () => {
  const r = clone(operation); set(r, path, changed(v)); deny(validateBrowserOperation(r, opContext(), now));
});
for (const action of actions) for (const [path, v] of leaves(action)) test(`action authorization binds ${action.kind}.${path}`, () => {
  const original = { ...clone(operation), action: clone(action) }, r = clone(original), c = opContext(original);
  if (action.kind.startsWith('vault_')) c.vaultUse = vaultContext(original);
  set(r.action, path, changed(v)); deny(validateBrowserOperation(r, c, now));
});
for (const [path, v] of leaves(identity)) test(`original job binding: ${path}`, () => {
  const c = opContext(); set(c.currentJob.identity, path, changed(v)); deny(validateBrowserOperation(operation, c, now));
  const t = takeoverContext(leased); set(t.currentJob.identity, path, changed(v)); deny(validateBrowserTakeoverTransition(handback, t, now));
});
test('current authority, lease, cancellation and unknown effects fail closed', () => {
  for (const field of ['authenticated', 'authorized']) {
    const c = opContext(); c[field] = false; deny(validateBrowserOperation(operation, c, now));
  }
  for (const state of ['revoked', 'deleted', 'quarantined']) {
    const c = opContext(); c.profile.state = state; deny(validateBrowserOperation(operation, c, now));
  }
  for (const at of [999, 5000, 6000]) deny(validateBrowserOperation(operation, opContext(), at));
  for (const field of ['epoch', 'revision', 'sessionRef', 'leaseRef']) {
    const c = opContext(); c.currentLease[field] = changed(c.currentLease[field]); deny(validateBrowserOperation(operation, c, now));
  }
  const c = opContext(); c.currentJob.revision++; deny(validateBrowserOperation(operation, c, now));
  c.currentJob = { ...opContext().currentJob, state: 'cancelled', cancellation: { reason: 'explicit_stop', actorRef: 'user' } };
  deny(validateBrowserOperation(operation, c, now));
  for (const outcome of ['unknown', 'verified', 'not_applied']) {
    c.currentJob = { ...opContext().currentJob, effects: [{ ...effect, outcome }] }; deny(validateBrowserOperation(operation, c, now));
  }
  const r = { ...clone(operation), action: clone(actions.find(a => a.kind === 'type')) }, text = opContext(r);
  text.nonSensitiveTextAuthorized = false; deny(validateBrowserOperation(r, text, now));
  for (const kind of ['upload', 'download']) {
    const r = { ...clone(operation), action: clone(actions.find(a => a.kind === kind)) }, c = opContext(r);
    c.transferAuthorized = false; deny(validateBrowserOperation(r, c, now));
  }
});
for (const kind of ['eval', 'shell', 'cdp', 'cookie_export', 'state_export', 'debug', 'screenshot', 'clipboard', 'vault_reveal']) test(`forbidden operation: ${kind}`, () => {
  deny(validateBrowserOperationSchema({ ...clone(operation), action: { kind } }));
});
test('text labels, raw transfers, URLs and malformed destinations cannot grant authority', () => {
  for (const extra of [{ text: 'synthetic' }, { nonSensitive: true }, { authorized: true }, { label: 'safe' }]) {
    deny(validateBrowserOperationSchema({ ...clone(operation), action: { kind: 'type', elementRef: 'element', textRef: 'text', ...extra } }));
  }
  for (const origin of ['http://fixture.example', 'https://fixture.example/', 'https://user:pass@fixture.example', 'https://fixture.example?secret']) {
    const r = clone(operation); r.document.origin = origin; r.document.frames[0].origin = origin; deny(validateBrowserOperationSchema(r));
  }
  for (const frames of [[], [document.frames[0], document.frames[0]], [{ frameRef: 'top', origin: 'https://other.example' }]]) {
    const r = clone(operation); r.document.frames = frames; deny(validateBrowserOperationSchema(r));
  }
  for (const timeoutMs of [0, 30_001, Infinity]) deny(validateBrowserOperationSchema({ ...operation, action: { kind: 'wait', condition: 'document_ready', timeoutMs } }));
  deny(validateBrowserOperationSchema({ ...operation, action: { kind: 'wait', condition: 'element_visible', timeoutMs: 1 } }));
});
for (const kind of ['vault_fill', 'vault_capture']) test(`existing vault policy required: ${kind}`, () => {
  const r = { ...clone(operation), action: { kind, grantRef: 'grant', grantRevision: 1 } }, c = opContext(r);
  deny(validateBrowserOperation(r, c, now)); c.vaultUse = vaultContext(r); accept(validateBrowserOperation(r, c, now));
  for (const path of ['grant.request.destination.origin', 'grant.request.destination.frames.1.frameRef', 'grant.request.destination.profileRef',
    'grant.request.destination.leaseEpoch', 'grant.request.destination.documentRef', 'grant.request.destination.navigationRevision',
    'grant.request.grantRef', 'grant.request.grantRevision', 'grant.request.effect.effectRef', 'grant.request.identity.jobId',
    'currentJob.identity.host.accountRef', 'currentJob.revision']) {
    const copy = clone(c), old = path.split('.').reduce((a, k) => a[k], copy.vaultUse);
    set(copy.vaultUse, path, changed(old)); deny(validateBrowserOperation(r, copy, now));
  }
  for (const key of ['authenticated', 'authorized', 'itemAuthorized']) {
    const copy = clone(c); copy.vaultUse[key] = false; deny(validateBrowserOperation(r, copy, now));
  }
  for (const change of [v => { v.grant.state = 'revoked'; }, v => { v.grant.expiresAt = now; }, v => { v.grant.permissions.use = false; },
    v => { v.grant.request.destination.rawDOM = 'synthetic'; }]) {
    const copy = clone(c); change(copy.vaultUse); deny(validateBrowserOperation(r, copy, now));
  }
});
test('sanitized attestation, redaction, takeover and unknown-effect observations', () => {
  accept(validateBrowserObservation(sanitized, operation));
  for (const observation of [
    { request: operation, effect: { ...effect, outcome: 'not_applied' }, kind: 'redacted', status: 'observation_withheld' },
    { request: operation, effect: { ...effect, outcome: 'unknown' }, reconciliationRef: 'reconcile', kind: 'takeover', requirement },
  ]) accept(validateBrowserObservation(observation, operation));
  for (const key of ['sessionRef', 'leaseEpoch', 'operationRef']) {
    const o = clone(sanitized); o.attestation[key] = changed(o.attestation[key]); deny(validateBrowserObservation(o, operation));
  }
  const o = clone(sanitized); delete o.attestation; deny(validateBrowserObservation(o, operation));
  const unknown = { ...clone(sanitized), effect: { ...effect, outcome: 'unknown' } };
  deny(validateBrowserObservation(unknown, operation)); unknown.reconciliationRef = 'reconcile'; accept(validateBrowserObservation(unknown, operation));
  unknown.effect.effectRef = 'other'; deny(validateBrowserObservation(unknown, operation));
  const other = clone(operation); other.lease.epoch++; deny(validateBrowserObservation(sanitized, other));
});
test('requested, leased, fresh handback and expired transitions', () => {
  for (const t of [requested, leased, handback]) accept(validateBrowserTakeover(t));
  accept(validateBrowserTakeoverTransition(requested, takeoverContext(), now));
  accept(validateBrowserTakeoverTransition(leased, takeoverContext(requested), now));
  accept(validateBrowserTakeoverTransition(handback, takeoverContext(leased), now));
  const expired = { ...clone(leased), state: 'expired', revision: 3, fencedEpoch: 7 };
  accept(validateBrowserTakeoverTransition(expired, takeoverContext(leased), 4000));
  deny(validateBrowserTakeoverTransition(expired, takeoverContext(leased), now));
  expired.fencedEpoch = 6; deny(validateBrowserTakeover(expired));
  deny(validateBrowserTakeoverTransition(handback, takeoverContext(requested), now));
  deny(validateBrowserTakeoverTransition(handback, takeoverContext(handback), now));
  for (const at of [999, 4000, 4500]) deny(validateBrowserTakeoverTransition(handback, takeoverContext(leased), at));
});
// These successor lease fields may change; authority binds the new epoch.
const successorFields = ['lease.leaseRef', 'lease.sessionRef', 'lease.owner.ownerRef', 'lease.revision', 'lease.expiresAt'];
for (const [path, v] of leaves(handback).filter(([p]) => !successorFields.includes(p))) test(`handback current binding: ${path}`, () => {
  const t = clone(handback); set(t, path, changed(v)); deny(validateBrowserTakeoverTransition(t, takeoverContext(leased), now));
});
test('handback requires fresh authorized context and proven fencing', () => {
  for (const path of ['authenticated', 'authorized', 'priorControllerFenced']) {
    const c = takeoverContext(leased); c[path] = false; deny(validateBrowserTakeoverTransition(handback, c, now));
  }
  for (const [path, v] of leaves(takeoverContext(leased).handbackAuthorization)) {
    // A shorter still-current deadline is permitted; a future issue time is not.
    const c = takeoverContext(leased);
    set(c.handbackAuthorization, path, path === 'issuedAt' ? now + 1 : changed(v));
    deny(validateBrowserTakeoverTransition(handback, c, now));
  }
  for (const change of [c => { delete c.handbackAuthorization; }, c => { c.previousAuthorizationRef = 'fresh'; },
    c => { c.handbackAuthorization.issuedAt = 1800; }, c => { c.handbackAuthorization.expiresAt = now; },
    c => { c.currentJob.answer = { requirementRef: 'challenge', requirementRevision: 1, responseRef: 'answer' }; },
    c => { c.currentJob = { ...opContext().currentJob, state: 'cancelled', cancellation: { reason: 'explicit_stop', actorRef: 'user' } }; },
    c => { c.profile.state = 'revoked'; }, c => { c.currentJob.requirement.revision++; }, c => { c.currentJob.requirement.requirementRef = 'other'; }]) {
    const c = takeoverContext(leased); change(c); deny(validateBrowserTakeoverTransition(handback, c, now));
  }
  for (const key of ['epoch', 'revision']) {
    const t = clone(handback); t.lease[key] = leased.lease[key]; deny(validateBrowserTakeoverTransition(t, takeoverContext(leased), now));
  }
});
test('local deletion does not imply remote provider logout', () => {
  for (const local of ['revoked', 'deleted', 'unavailable']) for (const remote of ['revoked', 'unavailable', 'unverified', 'not_requested']) {
    const r = { profile: clone(profile.reference), local: { state: local, receiptRef: 'local-receipt' },
      remote: { state: remote, ...(remote === 'revoked' ? { receiptRef: 'remote-receipt' } : {}) } };
    accept(validateBrowserRevocationResult(r, profile.reference));
    r.profile.scope.accountRef = 'other'; deny(validateBrowserRevocationResult(r, profile.reference));
  }
  deny(validateBrowserRevocationResult({ profile: profile.reference, local: { state: 'deleted', receiptRef: 'receipt' }, remote: { state: 'revoked' } }, profile.reference));
});

function objects(v, path = []) {
  if (v === null || typeof v !== 'object') return [];
  return [[path, v], ...Object.entries(v).flatMap(([k, c]) => objects(c, [...path, k]))];
}
const boundaries = [
  ['profile', profile, validateBrowserProfile], ['lease', lease, validateBrowserLease],
  ...actions.map(action => ['operation-' + action.kind, { ...clone(operation), action }, validateBrowserOperationSchema]),
  ['observation', sanitized, v => validateBrowserObservation(v, operation)],
  ['handback', handback, validateBrowserTakeover],
  ['requested', requested, validateBrowserTakeover], ['leased', leased, validateBrowserTakeover],
  ['expired', { ...clone(leased), state: 'expired', revision: 3, fencedEpoch: 7 }, validateBrowserTakeover],
  ['redacted', { request: operation, effect: { ...effect, outcome: 'unknown' }, reconciliationRef: 'reconcile', kind: 'redacted', status: 'unavailable' }, v => validateBrowserObservation(v, operation)],
  ['takeover-observation', { request: operation, effect: { ...effect, outcome: 'not_applied' }, kind: 'takeover', requirement }, v => validateBrowserObservation(v, operation)],
  ['revocation', { profile: profile.reference, local: { state: 'deleted', receiptRef: 'receipt' }, remote: { state: 'unverified' } }, v => validateBrowserRevocationResult(v, profile.reference)],
];
for (const [name, fixture, validate] of boundaries) test(`strict nested data boundaries: ${name}`, () => {
  for (const [path] of objects(fixture)) for (const key of ['cookies', 'storage', 'ciphertext', 'filesystemPath', 'keyMaterial', 'rawDOM', 'debug', 'output']) {
    const v = clone(fixture), target = path.reduce((o, k) => o[k], v); target[key] = { synthetic: 'private' }; deny(validate(v));
  }
  for (const [path] of objects(fixture)) for (const mode of ['hidden', 'symbol', 'accessor']) {
    let invoked = false;
    const v = clone(fixture), target = path.reduce((o, k) => o[k], v);
    if (mode === 'symbol') target[Symbol('private')] = 'synthetic';
    else if (mode === 'hidden') Object.defineProperty(target, 'private', { value: 'synthetic' });
    else {
      const key = Object.keys(target)[0] ?? 'private';
      Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { invoked = true; throw Error('synthetic-private'); } });
    }
    deny(validate(v)); assert.equal(invoked, false);
  }
});
test('malformed arrays, throwing proxies, fixed errors and frozen input', () => {
  for (const frames of [new Array(1), Array(33).fill(document.frames[0])]) {
    const r = clone(operation); r.document.frames = frames; deny(validateBrowserOperationSchema(r));
  }
  const r = clone(operation); Object.defineProperty(r.document.frames, '0', { value: r.document.frames[0], enumerable: false }); deny(validateBrowserOperationSchema(r));
  const poison = new Proxy({}, { getPrototypeOf() { throw Error('synthetic-private'); } });
  for (const [_, __, validate] of boundaries) assert.deepEqual(validate(poison), { ok: false, code: 'invalid_payload' });
  const freeze = v => { for (const [, o] of objects(v).reverse()) Object.freeze(o); return v; };
  accept(validateBrowserOperation(freeze(clone(operation)), freeze(opContext()), now));
  accept(validateBrowserTakeoverTransition(freeze(clone(handback)), freeze(takeoverContext(leased)), now));
});

test('vault token capture and synthetic identity fill reuse destination policy', () => {
  const capture = { ...clone(operation), action: { kind: 'vault_capture', grantRef: 'grant', grantRevision: 1 } };
  const fill = { ...clone(operation), action: { kind: 'vault_fill', grantRef: 'grant', grantRevision: 1 } };
  for (const [r, metadata, destination] of [
    [capture, { kind: 'token', tokenType: 'api' }, { fieldKind: 'token' }],
    [fill, { kind: 'identity', field: 'ssn', classification: 'synthetic', provenanceRef: 'fixture' },
      { fieldKind: 'ssn', identityField: 'ssn', recipientRef: 'recipient', purposeRef: 'purpose' }],
  ]) {
    const c = opContext(r); c.vaultUse = vaultContext(r);
    c.vaultUse.item.metadata = metadata; c.vaultUse.grant.request.item.metadata = clone(metadata);
    Object.assign(c.vaultUse.grant.request.destination, destination);
    accept(validateBrowserOperation(r, c, now));
    c.vaultUse.grant.request.destination.fieldKind = 'password'; deny(validateBrowserOperation(r, c, now));
  }
});
test('trusted contexts reject nested extra fields and accessors before reading them', () => {
  const r = { ...clone(operation), action: { kind: 'vault_fill', grantRef: 'grant', grantRevision: 1 } };
  const vc = opContext(r); vc.vaultUse = vaultContext(r);
  for (const [fixture, validate] of [
    [opContext(), v => validateBrowserOperation(operation, v, now)],
    [vc, v => validateBrowserOperation(r, v, now)],
    [takeoverContext(leased), v => validateBrowserTakeoverTransition(handback, v, now)],
  ]) for (const [path, object] of objects(fixture)) {
    for (const mode of ['unknown', 'hidden', 'symbol', 'accessor']) {
      const c = clone(fixture), target = path.reduce((v, k) => v[k], c);
      let invoked = false;
      if (mode === 'unknown') target.rawDOM = 'synthetic';
      else if (mode === 'hidden') Object.defineProperty(target, 'rawDOM', { value: 'synthetic' });
      else if (mode === 'symbol') target[Symbol('rawDOM')] = 'synthetic';
      else Object.defineProperty(target, Object.keys(object)[0] ?? 'rawDOM', { enumerable: true, configurable: true,
        get() { invoked = true; throw Error('synthetic-private'); } });
      deny(validate(c)); assert.equal(invoked, false);
    }
  }
});
