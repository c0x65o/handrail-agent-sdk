import assert from 'node:assert/strict';
import { createJobLease } from '../../.reference-build/src/server/job-lease.js';
import { createJobLeaseStore } from '../../.reference-build/reference/node/job-lease.js';
import { createJobJournal } from '../../.reference-build/reference/node/job-journal.js';
import { createEffects } from '../../.reference-build/src/server/effects.js';
import { createEffectStore } from '../../.reference-build/reference/node/effects.js';
import { journalTables } from '../../.reference-build/reference/node/db/schema.js';
import { randomUUID } from 'node:crypto';
export const identity = { jobId: 'effect-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' } };
export const request = { identity, effectRef: 'original-effect', actionRef: 'original-action', operationRef: 'original-operation',
  requestDigest: `sha256:${'a'.repeat(64)}`, providerRef: 'synthetic-account-fixture', idempotencyRef: 'original-provider-key' };
export const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
export function services(db, schema, adapter, options = {}) {
  const tables = journalTables(schema);
  const state = { now: Date.now(), grantRevision: 1, cancellationRevision: 0, denied: false, ...options.state };
  const host = { now: () => state.now, newOwnerToken: () => `owner-${randomUUID()}`,
    withAuthority: async (_input, operation, run) => {
      if (state.denied || (state.denyDispatch && operation === 'dispatch')) return { ok: false, code: 'not_authorized' };
      return run({ host: state.scope ?? identity.host, grantRevision: state.grantRevision, cancellationRevision: state.cancellationRevision });
    } };
  return { state, host, tables, journal: createJobJournal(db, tables),
    lease: createJobLease(host, createJobLeaseStore(db, tables)),
    effects: createEffects(host, createEffectStore(db, tables), adapter, options.timeoutMs ?? 1000) };
}
export async function start(s, ttl = 5000) {
  const fence = ok(await s.lease.claim(identity, ttl)); assert.ok(fence);
  const current = ok(await s.journal.load(identity));
  if (current.state === 'queued') ok(await s.lease.append({ kind: 'started', previousRevision: current.revision,
    snapshot: { ...current, state: 'running', revision: current.revision + 1 } }, fence));
  return fence;
}
