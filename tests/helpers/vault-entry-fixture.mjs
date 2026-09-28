import { createSecretKey, randomBytes } from 'node:crypto';
import { sameLeaseValue } from '../../.reference-build/src/server/job-lease.js';
import { identity } from './effect-fixture.mjs';
import { createVaultEntry } from '../../.reference-build/src/server/vault-entry.js';
import { createVaultEntryStore } from '../../.reference-build/reference/node/vault-entry.js';
export { identity };
export const requirement = { kind: 'secure_input', requirementRef: 'entry-challenge', revision: 1,
  actor: { kind: 'user', actorRef: identity.host.userRef } };
export function entryState(kind = 'token', source = 'new_input') {
  const metadata = kind === 'payment_method' ? { kind, instrument: 'credit_card' } : kind === 'token' ? { kind, tokenType: 'api' } : kind === 'login' ? { kind, credential: 'password' }
    : { kind: 'identity', field: 'ssn', classification: 'synthetic', provenanceRef: 'private-fixture' };
  const effect = { effectRef: 'entry-effect', operationRef: 'registered-operation', actionRef: 'approved-action' };
  const request = { operation: 'vault.secure_entry', identity, jobRevision: 3, requirement,
    origin: 'https://fixture.invalid', metadata, effect, issuedAt: 1000, expiresAt: 2000 };
  const item = { metadata, reference: kind === 'payment_method' ? { kind, paymentRef: 'host-approved-card', revision: 1 } : { kind: 'secret', itemRef: 'host-approved-item', revision: 1 } };
  const browser = { origin: request.origin, profileRef: 'profile', leaseEpoch: 1, documentRef: 'doc', navigationRevision: 1,
    frames: [{ frameRef: 'top', origin: request.origin }], fieldRef: 'private-field', fieldKind: kind === 'payment_method' ? 'card_number' : kind === 'login' ? 'password' : 'ssn', formEndpoint: 'https://fixture.invalid/submit' };
  const grant = { request: { identity, jobRevision: 6, grantRef: 'entry-use-grant', grantRevision: 1, effect, item,
    operation: kind === 'token' ? 'server_request' : 'fill', destination: kind === 'token'
      ? { endpoint: 'https://fixture.invalid/setup', method: 'POST', redirects: 'deny', resourceRef: 'resource' }
      : kind === 'payment_method' ? { ...browser, purposeRef: identity.host.purposeRef } : kind === 'login' ? browser : { ...browser, recipientRef: 'recipient', purposeRef: identity.host.purposeRef, identityField: 'ssn' } },
    issuedAt: 1000, expiresAt: 2000, state: 'active', permissions: { use: true, reveal: false, export: false },
    itemExpiresAt: 3000, taskExpiresAt: 3000 };
  return { now: 1000, source, request, grant, actorRef: identity.host.userRef, scope: structuredClone(identity.host),
    grantRevision: 1, cancellationRevision: 0, denied: false, ownerAllowed: true, resolveHook: undefined };
}
export function entryServices(db, schema, state, keys) {
  const key = createSecretKey(randomBytes(32));
  keys ??= { active: async () => ({ keyHandle: 'private-fixture-key', keyVersion: 1 }),
    resolve: async () => { await state.resolveHook?.(); return key; } };
  const storage = { authorize: async () => state.ownerAllowed ? identity.host : null };
  const owner = { now: () => state.now, withOwner: async (_item, _op, run) => state.ownerAllowed && !state.grantDenied
    ? run(identity.host) : { ok: false, code: 'not_authorized' } };
  const host = { now: () => state.now, withAuthority: async (request, _phase, run) => {
    if (state.denied || !sameLeaseValue(request, state.request)) return { ok: false, code: 'not_authorized' };
    return run({ host: state.scope, grantRevision: state.grantRevision, cancellationRevision: state.cancellationRevision,
      actorRef: state.actorRef, source: state.source, grant: state.grant });
  } };
  const store = createVaultEntryStore(db, storage, owner, keys, schema);
  return { entry: createVaultEntry(host, store), host, store, storage, owner, keys };
}
