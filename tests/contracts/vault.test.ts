import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVaultItem, validateVaultEntryRequest, validateVaultEntryCompletion,
  validateVaultOperation, validateVaultBrokerResult,
} from 'handrail-agent-sdk';
import type { VaultMetadata } from 'handrail-agent-sdk';

const now = 1_000_000;
const identity = {
  jobId: 'job-1', originTaskRef: 'task-1', requestKey: 'request-1', instructionRevision: 1,
  host: { tenantRef: 'tenant-1', userRef: 'user-1', projectRef: 'project-1', accountRef: 'account-1', environmentRef: 'env-1', purposeRef: 'purpose-1' },
  native: { requestRef: 'native-request-1', threadRef: 'thread-1', assistantProjectRef: 'assistant-project-1', objectiveRef: 'objective-1', rootTaskRef: 'root-1', outcomeRef: 'outcome-1', backingWorkRequestRef: 'backing-1', childWorkRequestRef: 'child-1', turnRef: 'turn-1', runRef: 'run-1', actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1', sourceQueue: { queueRef: 'queue-1', messageRef: 'message-1' } },
  origin: { channelRef: 'channel-1', routeRef: 'route-1', correlationRef: 'correlation-1' },
};
const effect = { actionRef: 'action-1', operationRef: 'operation-1', effectRef: 'effect-1' };
const requirement = { kind: 'secure_input', requirementRef: 'challenge-1', revision: 1, actor: { kind: 'user', actorRef: 'user-1' } };
const metadata: Record<string, VaultMetadata> = {
  login: { kind: 'login', credential: 'password' },
  api: { kind: 'token', tokenType: 'api' },
  refresh: { kind: 'token', tokenType: 'refresh' },
  identity: { kind: 'identity', field: 'ssn', classification: 'synthetic', provenanceRef: 'fixture-1' },
  payment: { kind: 'payment_method', instrument: 'credit_card' },
};
// Mutable synthetic fixtures deliberately support invalid-field injection.
function item(family = 'login'): any {
  return structuredClone({ metadata: metadata[family], reference: family === 'payment'
    ? { kind: 'payment_method', paymentRef: 'payment-1', revision: 1 }
    : { kind: 'secret', itemRef: 'item-1', revision: 1 } });
}
function request(family = 'login'): any {
  return structuredClone({ operation: 'vault.secure_entry', identity, jobRevision: 2, requirement,
    origin: 'https://entry.example', metadata: metadata[family], effect, issuedAt: now - 1000, expiresAt: now + 60_000 });
}
function completion(family = 'login', source = 'new_input'): any {
  return { request: request(family), source, item: item(family),
    answer: { requirementRef: 'challenge-1', requirementRevision: 1, responseRef: 'private-response-1' } };
}
function authority(family = 'login'): any {
  return structuredClone({ currentJob: { identity, revision: 2, state: 'waiting', effects: [], requirement },
    item: item(family), authenticated: true, authenticatedActor: requirement.actor, authorized: true,
    itemAuthorized: true, itemState: 'active', itemExpiresAt: now + 1_000_000, taskExpiresAt: now + 1_000_000, maxLifetimeMs: 900_000 });
}
function entryContext(family = 'login', source = 'new_input'): any {
  return { ...authority(family), request: request(family), state: 'active', responseRef: 'private-response-1', source };
}
function browser(family = 'login'): any {
  return { origin: 'https://app.example', profileRef: 'profile-1', leaseEpoch: 3, documentRef: 'document-1', navigationRevision: 4,
    frames: [{ frameRef: 'top', origin: 'https://app.example' }, { frameRef: 'form-frame', origin: 'https://form.example' }],
    fieldRef: 'field-1', fieldKind: family === 'payment' ? 'card_number' : family === 'identity' ? 'ssn' : family === 'login' ? 'password' : 'token', formEndpoint: 'https://form.example/submit',
    ...(family === 'payment' ? { purposeRef: 'purpose-1' } : family === 'identity' ? { recipientRef: 'recipient-1', purposeRef: 'purpose-1', identityField: 'ssn' } : {}) };
}
function operation(family = 'login', op = family === 'api' || family === 'refresh' ? 'server_request' : 'fill'): any {
  return structuredClone({ identity, jobRevision: 3, grantRef: 'grant-1', grantRevision: 1, effect, operation: op, item: item(family),
    destination: op !== 'server_request' ? browser(family) : { endpoint: 'https://api.example/resource', method: 'GET', resourceRef: 'resource-1', redirects: 'deny' } });
}
function useContext(family = 'login', op?): any {
  const c = authority(family);
  c.currentJob = { identity: structuredClone(identity), revision: 3, state: 'running', effects: [] };
  c.maxLifetimeMs = 300_000;
  return { ...c, grant: { request: operation(family, op), issuedAt: now - 1000, expiresAt: now + 60_000,
    state: 'active', permissions: { use: true, reveal: false, export: false } } };
}
function result(family = 'login', outcome = 'verified'): any {
  return { ok: true, receipt: { request: operation(family), receiptRef: 'receipt-1', effect: { ...effect, outcome },
    ...(outcome === 'unknown' ? { reconciliationRef: 'reconcile-1' } : {}) } };
}
function valid(r) { assert.equal(r.ok, true, r.code); }
function invalid(r, code?) { assert.equal(r.ok, false); if (code) assert.equal(r.code, code); }
function paths(v, base: string[] = [], objects = false): string[][] {
  if (!v || typeof v !== 'object') return objects ? [] : [base];
  return [...(objects ? [base] : []), ...Object.entries(v).flatMap(([k, child]) => paths(child, [...base, k], objects))];
}
function at(v, path: string[]) { for (const key of path) v = v[key]; return v; }
function changeLeaf(v, path: string[]) {
  const parent = at(v, path.slice(0, -1)), key = path.at(-1)!;
  parent[key] = typeof parent[key] === 'number' ? parent[key] + 1 : parent[key] === 'GET' ? 'POST'
    : typeof parent[key] === 'string' && parent[key].startsWith('https:') ? 'https://other.example' + (parent[key].includes('/submit') ? '/submit' : '') : 'replacement';
}

for (const family of Object.keys(metadata)) test(`vault TS suite: ${family} metadata, reference-only completion, operation and receipt`, () => {
  valid(validateVaultItem(item(family)));
  valid(validateVaultEntryRequest(request(family)));
  const c = completion(family);
  const accepted = validateVaultEntryCompletion(c, entryContext(family), now);
  valid(accepted); assert.equal(accepted.disposition, 'accept'); assert.equal(accepted.value, c);
  valid(validateVaultOperation(operation(family), useContext(family), now));
  for (const outcome of ['verified', 'not_applied', 'unknown']) valid(validateVaultBrokerResult(result(family, outcome), operation(family)));
});
for (const family of ['login', 'api', 'refresh']) test(`vault capture: ${family}`, () => {
  valid(validateVaultOperation(operation(family, 'capture'), useContext(family, 'capture'), now));
});
for (const field of ['ssn', 'legal_name', 'date_of_birth', 'tax_id']) test(`synthetic field classification: ${field}`, () => {
  const i = item('identity'); i.metadata.field = field; valid(validateVaultItem(i));
  for (const classification of ['real', 'unknown', undefined]) { i.metadata.classification = classification; invalid(validateVaultItem(i)); }
});
for (const family of Object.keys(metadata)) for (const source of ['new_input', 'existing_item']) test(`${family} ${source} requires authenticated actor and item ACL`, () => {
  const value = completion(family, source), c = entryContext(family, source);
  valid(validateVaultEntryCompletion(value, c, now));
  for (const field of ['authenticated', 'authorized', 'itemAuthorized']) {
    const bad = structuredClone(c); bad[field] = false;
    invalid(validateVaultEntryCompletion(value, bad, now), 'not_authorized');
  }
  c.authenticatedActor.actorRef = 'other-user'; invalid(validateVaultEntryCompletion(value, c, now), 'not_authorized');
});
for (const path of paths(request())) test(`completion independently binds original request: ${path.join('.')}`, () => {
  const v = completion(); changeLeaf(v.request, path);
  invalid(validateVaultEntryCompletion(v, entryContext(), now));
});
for (const path of paths(identity)) test(`host job independently binds identity: ${path.join('.')}`, () => {
  const c = entryContext(); changeLeaf(c.currentJob.identity, path);
  invalid(validateVaultEntryCompletion(completion(), c, now));
});
test('completion binds answer, family, source, item identity and current item revision', () => {
  for (const mutate of [v => v.answer.responseRef = 'unapproved', v => v.answer.requirementRef = 'other', v => v.answer.requirementRevision++, v => v.item.reference.revision++,
    v => v.item.reference.itemRef = 'other', v => v.item = item('api'), v => v.source = 'existing_item']) {
    const v = completion(); mutate(v); invalid(validateVaultEntryCompletion(v, entryContext(), now));
  }
});
for (const [name, mutate] of [
  ['job revision', c => c.currentJob.revision++], ['challenge', c => c.currentJob.requirement.requirementRef = 'other'],
  ['challenge revision', c => c.currentJob.requirement.revision++], ['already answered', c => c.currentJob.answer = completion().answer],
  ['not waiting', c => { c.currentJob.state = 'running'; delete c.currentJob.requirement; }],
]) test(`stale completion: ${name}`, () => {
  const c = entryContext(); mutate(c); invalid(validateVaultEntryCompletion(completion(), c, now), 'stale_completion');
});
test('authorized identical replay keeps all identities and the original effect; conflicts never reapply', () => {
  const v = completion(), c = entryContext(); c.previous = structuredClone(v); c.currentJob.revision++;
  c.currentJob.answer = structuredClone(v.answer);
  const replay = validateVaultEntryCompletion(v, c, now);
  valid(replay); assert.equal(replay.disposition, 'replay'); assert.deepEqual(replay.value.request.identity, identity);
  assert.deepEqual(replay.value.request.effect, effect);
  const conflicting = structuredClone(v); conflicting.answer.responseRef = 'other-response';
  invalid(validateVaultEntryCompletion(conflicting, c, now), 'duplicate_conflict');
  for (const path of paths(v)) { const bad = structuredClone(v); changeLeaf(bad, path); invalid(validateVaultEntryCompletion(bad, c, now)); }
  c.itemAuthorized = false; invalid(validateVaultEntryCompletion(v, c, now), 'not_authorized');
  c.itemAuthorized = true; c.state = 'revoked'; invalid(validateVaultEntryCompletion(v, c, now), 'not_current');
  c.state = 'active'; invalid(validateVaultEntryCompletion(v, c, v.request.expiresAt), 'not_current');
  c.currentJob.revision = v.request.jobRevision; invalid(validateVaultEntryCompletion(v, c, now), 'stale_completion');
});
for (const kind of ['entry', 'use']) test(`${kind} expiry, revocation, cancellation, lifetime limits and narrower host policy`, () => {
  function fixture() {
    const value = kind === 'entry' ? completion() : operation();
    const context = kind === 'entry' ? entryContext() : useContext();
    const period = kind === 'entry' ? value.request : context.grant;
    return { value, context, period };
  }
  function check(f, at = now) {
    if (kind === 'entry') f.context.request = structuredClone(f.value.request);
    return kind === 'entry' ? validateVaultEntryCompletion(f.value, f.context, at) : validateVaultOperation(f.value, f.context, at);
  }
  const limit = kind === 'entry' ? 900_000 : 300_000;
  const boundary = fixture(); boundary.period.issuedAt = now; boundary.period.expiresAt = now + limit; valid(check(boundary));
  boundary.period.expiresAt++; invalid(check(boundary));
  for (const mutate of [
    f => f.context.itemState = 'revoked', f => f.context.itemState = 'deleted',
    f => (kind === 'entry' ? f.context : f.context.grant).state = 'revoked',
    f => f.context.itemExpiresAt = now, f => f.context.taskExpiresAt = now,
    f => f.period.issuedAt = now + 1, f => f.period.expiresAt = now,
    f => f.period.expiresAt = f.period.issuedAt, f => f.context.maxLifetimeMs = 1000,
    f => f.context.maxLifetimeMs = limit + 1, f => f.context.maxLifetimeMs = 0,
    f => f.context.itemExpiresAt = f.period.expiresAt - 1, f => f.context.taskExpiresAt = f.period.expiresAt - 1,
    f => { f.context.currentJob = { identity, revision: 3, effects: [], state: 'cancelled', cancellation: { actorRef: 'user-1', reason: 'explicit_stop' } }; },
  ]) { const f = fixture(); mutate(f); invalid(check(f)); }
  for (const clock of [-1, NaN, Infinity, 1.5, '1000000']) invalid(check(fixture(), clock));
});
for (const family of Object.keys(metadata)) for (const path of paths(operation(family))) test(`${family} use binds grant and destination: ${path.join('.')}`, () => {
  const v = operation(family); changeLeaf(v, path); invalid(validateVaultOperation(v, useContext(family), now));
});
test('current use authority rejects stale items, grants, jobs, unauthenticated callers and ungranted use', () => {
  for (const mutate of [c => c.item.reference.revision++, c => c.item.reference.itemRef = 'other', c => c.currentJob.revision++,
    c => c.grant.request.grantRevision++, c => c.authenticated = false, c => c.authorized = false,
    c => c.itemAuthorized = false, c => c.authenticatedActor.actorRef = 'other', c => c.currentJob.identity.host.tenantRef = 'other']) {
    const c = useContext(); mutate(c); invalid(validateVaultOperation(operation(), c, now));
  }
  const c = useContext(); c.grant.permissions = { use: false, reveal: true, export: true };
  invalid(validateVaultOperation(operation(), c, now), 'operation_denied');
  for (const op of ['reveal', 'export', 'purchase']) {
    const v = operation(); v.operation = op; c.grant.request = v; invalid(validateVaultOperation(v, c, now));
  }
});
test('payment references cannot substitute for generic references at any schema boundary', () => {
  for (const family of Object.keys(metadata)) {
    const opposite = family === 'payment' ? item() : item('payment');
    const i = item(family); i.reference = opposite.reference; invalid(validateVaultItem(i));
    const v = completion(family); v.item = i; const c = entryContext(family); c.item = i;
    invalid(validateVaultEntryCompletion(v, c, now));
    const op = operation(family); op.item = i; const uc = useContext(family); uc.grant.request = op; uc.item = i;
    invalid(validateVaultOperation(op, uc, now));
  }
});
test('operation/family and destination rules reject even mutually matching client and grant claims', () => {
  // These substitutions are structurally valid; rejection must come from the
  // admitted destination comparison, not incidental URL/shape invalidity.
  for (const [family, mutate] of [
    ['login', v => { v.destination.origin = 'https://other.example'; v.destination.frames[0].origin = v.destination.origin; }],
    ['login', v => v.destination.frames[1].origin = 'https://other-frame.example'],
    ['login', v => v.destination.frames[1].frameRef = 'replacement-frame'],
    ['login', v => v.destination.fieldRef = 'replacement-field'],
    ['login', v => v.destination.formEndpoint = 'https://other-form.example/submit'],
    ['api', v => v.destination.endpoint = 'https://other-api.example/resource'],
    ['api', v => v.destination.method = 'POST'],
    ['identity', v => v.destination.recipientRef = 'other-recipient'],
    ['payment', v => v.destination.fieldRef = 'other-field'],
    ['payment', v => v.destination.frames[1].frameRef = 'other-frame'],
    ['payment', v => v.destination.fieldKind = 'cardholder_name'],
  ]) {
    const v = operation(family); mutate(v);
    const independentlyAdmitted = useContext(family); independentlyAdmitted.grant.request = structuredClone(v);
    valid(validateVaultOperation(v, independentlyAdmitted, now));
    invalid(validateVaultOperation(v, useContext(family), now), 'binding_mismatch');
  }
  for (const [family, op] of [['payment', 'server_request'], ['payment', 'capture'], ['identity', 'capture'], ['identity', 'server_request'], ['login', 'server_request'], ['api', 'fill']]) {
    const v = operation(family, op), c = useContext(family, op); invalid(validateVaultOperation(v, c, now));
  }
  for (const [family, mutate] of [
    ['identity', v => v.destination.identityField = 'legal_name'], ['identity', v => v.destination.fieldKind = 'password'],
    ['identity', v => delete v.destination.recipientRef], ['identity', v => v.destination.purposeRef = 'other'],
    ['login', v => v.destination.frames[0].origin = 'https://other.example'], ['login', v => v.destination.frames = []],
    ['login', v => v.destination.frames.push(v.destination.frames[0])], ['login', v => v.destination.fieldKind = 'token'],
    ['payment', v => v.destination.providerRef = 'other'], ['payment', v => v.destination.customerRef = 'other'],
    ['payment', v => v.destination.paymentAccountRef = 'other'], ['payment', v => v.destination.purposeRef = 'other'],
    ['payment', v => v.destination.action = 'purchase'], ['api', v => v.destination.redirects = 'allow'],
    ['api', v => v.destination.method = '*'],
  ]) {
    const v = operation(family); mutate(v); const c = useContext(family); c.grant.request = v;
    invalid(validateVaultOperation(v, c, now));
  }
});
test('origins and endpoints must be normalized HTTPS without credentials, query or fragments', () => {
  for (const url of ['http://entry.example', 'https://ENTRY.example', 'https://entry.example:443', 'https://entry.example/',
    'https://user:pass@entry.example', 'null', 'data:text/plain,test', 'https://entry.example?token=synthetic', 'https://entry.example#fragment']) {
    const r = request(); r.origin = url; invalid(validateVaultEntryRequest(r));
  }
  for (const url of ['http://api.example/', 'https://api.example/?token=synthetic', 'https://user:pass@api.example/', 'https://api.example/#x', 'https://api.example/#', 'https://api.example/?', 'https://API.example/']) {
    const v = operation('api'); v.destination.endpoint = url; const c = useContext('api'); c.grant.request = v;
    invalid(validateVaultOperation(v, c, now));
  }
});
test('broker results are redacted, fixed-error and bound to stable effect identity', () => {
  valid(validateVaultBrokerResult({ ok: false, error: { code: 'observation_withheld', correlationRef: 'correlation-1' } }, operation()));
  for (const path of paths(result()).filter(p => p.join('.') !== 'receipt.receiptRef')) {
    const v = result(); changeLeaf(v, path); invalid(validateVaultBrokerResult(v, operation()));
  }
  const unknown = result('login', 'unknown'); delete unknown.receipt.reconciliationRef;
  invalid(validateVaultBrokerResult(unknown, operation()));
  for (const error of [{ code: 'SYNTHETIC_PRIVATE_VALUE', correlationRef: 'c' }, { code: 'unavailable', correlationRef: 'c', message: 'SYNTHETIC_PRIVATE_VALUE' }]) {
    invalid(validateVaultBrokerResult({ ok: false, error }, operation()));
  }
});
test('all nested boundaries reject unknown raw values, hidden properties, symbols and hostile accessors without echo', () => {
  const marker = 'SYNTHETIC_PRIVATE_VALUE'; let reads = 0;
  for (const family of Object.keys(metadata)) {
    const cases = [
      [() => item(family), v => validateVaultItem(v)],
      [() => request(family), v => validateVaultEntryRequest(v)],
      [() => completion(family), v => validateVaultEntryCompletion(v, entryContext(family), now)],
      [() => entryContext(family), v => validateVaultEntryCompletion(completion(family), v, now)],
      [() => operation(family), v => validateVaultOperation(v, useContext(family), now)],
      [() => useContext(family), v => validateVaultOperation(operation(family), v, now)],
      [() => result(family), v => validateVaultBrokerResult(v, operation(family))],
    ];
    for (const [make, validate] of cases) for (const path of paths(make(), [], true)) {
      for (const inject of [
        target => target.rawSecret = marker, target => target.pan = marker, target => target.cvv = marker,
        target => Object.defineProperty(target, 'hidden', { value: marker }), target => target[Symbol('secret')] = marker,
        target => Object.defineProperty(target, Object.keys(target)[0] ?? 'value', { enumerable: true, get() { reads++; throw new Error(marker); } }),
      ]) {
        const value = make(); inject(at(value, path));
        assert.deepEqual(validate(value), { ok: false, code: 'invalid_payload' });
      }
    }
  }
  assert.equal(reads, 0);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(marker); } });
  for (const value of [hostile, null, [], {}, new Error(marker)]) {
    assert.deepEqual(validateVaultItem(value), { ok: false, code: 'invalid_payload' });
    assert.deepEqual(validateVaultEntryCompletion(value, entryContext(), now), { ok: false, code: 'invalid_payload' });
    assert.deepEqual(validateVaultOperation(value, useContext(), now), { ok: false, code: 'invalid_payload' });
  }
});
test('malformed arrays, unsafe revisions and frozen inputs', () => {
  for (const frames of [Array(2), Array(33).fill(browser().frames[0])]) {
    const v = operation(); v.destination.frames = frames; const c = useContext(); c.grant.request = v;
    invalid(validateVaultOperation(v, c, now));
  }
  for (const revision of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const v = item(); v.reference.revision = revision; invalid(validateVaultItem(v));
  }
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  const v = freeze(completion()), c = freeze(entryContext());
  valid(validateVaultEntryCompletion(v, c, now)); assert.deepEqual(v, completion());
});

test('accounted effects never authorize another dispatch, including unknown outcomes', () => {
  for (const outcome of ['unknown', 'verified', 'not_applied']) {
    const c = useContext(); c.currentJob.effects = [{ ...effect, outcome }];
    invalid(validateVaultOperation(operation(), c, now), 'operation_denied');
  }
});
