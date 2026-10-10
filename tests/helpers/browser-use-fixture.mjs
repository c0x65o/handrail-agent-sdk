import { createHash } from 'node:crypto';
export const identity = { jobId: 'job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'test', purposeRef: 'purpose' },
  native: { requestRef: 'request' }, origin: { channelRef: 'channel', routeRef: 'route', correlationRef: 'correlation' } };
export function fixture(id = identity, now = 2000) {
  const profile = { reference: { profileRef: 'profile', revision: 1, scope: structuredClone(id.host) }, state: 'active',
    custody: { protection: 'authenticated_encryption', custodianRef: 'custodian', envelopeRevision: 1, keyVersionRef: 'key' } };
  const lease = { leaseRef: 'lease', profile: profile.reference, sessionRef: 'session', owner: { kind: 'agent', ownerRef: 'worker' },
    revision: 1, epoch: 1, issuedAt: now - 1000, expiresAt: now + 30000 };
  const request = { identity: id, jobRevision: 2, lease,
    document: { tabRef: 'tab', origin: 'https://fixture.example', documentRef: 'document', navigationRevision: 1,
      frames: [{ frameRef: 'top', origin: 'https://fixture.example' }] },
    effect: { effectRef: 'effect', actionRef: 'action', operationRef: 'browser-operation' }, action: { kind: 'inspect' } };
  const context = { currentJob: { identity: id, revision: 2, state: 'running', effects: [] }, profile,
    currentLease: lease, authenticated: true, authorized: true, taskExpiresAt: now + 60000,
    admittedOperation: structuredClone(request), nonSensitiveTextAuthorized: false, transferAuthorized: false };
  const authority = { host: id.host, grantRevision: 1, cancellationRevision: 0 };
  const fence = { ...authority, identity: id, ownerToken: 'worker', epoch: 1, expiresAt: now + 10000 };
  return { request, context, authority, fence };
}
export const bind = request => ({ identity: request.identity, ...request.effect, idempotencyRef: request.effect.effectRef,
  requestDigest: `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`, providerRef: 'browser-provider' });
export const observation = request => ({ request, effect: { ...request.effect, outcome: 'verified' }, kind: 'sanitized',
  attestation: { adapterRef: 'adapter', qualificationRef: 'qualification', policyRevision: 1,
    sessionRef: request.lease.sessionRef, leaseEpoch: request.lease.epoch, operationRef: request.effect.operationRef, receiptRef: 'receipt' },
  facts: [{ kind: 'document_ready', subjectRef: 'document' }] });
