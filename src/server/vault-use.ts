import type { VaultOperation } from '../contracts/vault.js';
import { validateVaultOperation, validateVaultOperationSchema } from '../contracts/vault.js';
import type { VaultUseContext, VaultUseGrant } from './vault-policy.js';
import { createEffects, validEffectRequest } from './effects.js';
import type { EffectRequest, EffectObservation, EffectStore } from './effects.js';
import type { JobAppendFence, JobLeaseAuthority, JobLeaseFence } from './job-lease.js';
import { sameLeaseValue, validJobFence } from './job-lease.js';
import type { JobStoreResult } from './job-store.js';

/** Server registration only. Never accept executors, custody callbacks or policy
 * facts from tool input. Output is deliberately just an enum; the SDK issues the
 * receipt reference, so an executor cannot smuggle a value through a receipt. */
export interface TrustedVaultExecutor<PrivateValue> {
  readonly operationRef: string;
  bind(request: VaultOperation): EffectRequest;
  /** Recheck isCurrent after asynchronous preparation and before actual use. */
  dispatch(request: VaultOperation, value: PrivateValue, signal: AbortSignal, isCurrent: () => boolean): Promise<'verified' | 'unknown'>;
  /** Read only, no vault value. not_applied must rule out late in-flight effects. */
  reconcile(request: VaultOperation, signal: AbortSignal): Promise<'verified' | 'not_applied' | 'unknown'>;
}
export interface VaultUseAuthority extends JobLeaseAuthority {
  readonly actorRef: string;
}
export interface VaultUseHost {
  /** Resolve authenticated actor/native task scope anew. Hold native authority
   * stable through callback AND commit. Reconcile authorizes factual reads only. */
  withAuthority<T>(request: VaultOperation, phase: 'admit' | 'dispatch' | 'reconcile',
    run: (authority: VaultUseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  now(): number;
}
export interface VaultUseSession<PrivateValue> {
  readonly effects: EffectStore;
  /** Current facts under the job, grant and lifecycle fences. Admission of this
   * exact durable effect may be normalized out of currentJob for validation. */
  context(): VaultUseContext;
  readForExecutor(): Promise<JobStoreResult<PrivateValue>>;
}
export interface VaultUsePort<PrivateValue> {
  /** Serialize with grant revision/revoke, lifecycle and job writes. Audit fixed
   * redacted outcomes durably, including denials, without throwing raw errors. */
  withUse<T>(request: VaultOperation, effect: EffectRequest, phase: 'admit' | 'dispatch',
    access: JobAppendFence, actorRef: string,
    run: (session: VaultUseSession<PrivateValue>) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  /** Existing effect reconciliation remains available after grant revoke/Stop. */
  readonly effects: EffectStore;
  auditDenial(request: VaultOperation): Promise<JobStoreResult<void>>;
}
export interface VaultItemGrant extends VaultUseGrant {
  readonly itemExpiresAt: number;
  readonly taskExpiresAt: number;
}
export interface VaultAccessFact {
  readonly receiptRef: string;
  readonly at: number;
  readonly phase: 'admit' | 'dispatch';
  readonly outcome: 'authorized' | 'denied' | 'expired' | 'revoked' | 'stale_grant' | 'unknown' | 'verified';
}
/** Host-owned grant administration and bounded, authorized history. Revoking a
 * grant advances only local authorization; it never revokes a remote credential. */
export interface VaultItemGrantPort {
  /** Recheck the exact persisted permitted-use revision under the item fence. */
  check(grant: VaultItemGrant): Promise<JobStoreResult<void>>;
  put(grant: VaultItemGrant, expectedRevision: number): Promise<JobStoreResult<{ revision: number }>>;
  revoke(item: VaultOperation['item'], grantRef: string, expectedRevision: number): Promise<JobStoreResult<{ revision: number }>>;
  history(item: VaultOperation['item'], limit?: number): Promise<JobStoreResult<readonly VaultAccessFact[]>>;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Inert server factory. Unsupported reveal/export cannot pass operation validation. */
export function createVaultUse<PrivateValue>(host: VaultUseHost, port: VaultUsePort<PrivateValue>,
  registrations: readonly TrustedVaultExecutor<PrivateValue>[], timeoutMs = 10_000) {
  const registry = new Map<string, TrustedVaultExecutor<PrivateValue>>();
  for (const executor of registrations) {
    if (registry.has(executor.operationRef)) throw new Error('DUPLICATE_VAULT_EXECUTOR');
    registry.set(executor.operationRef, { operationRef: executor.operationRef,
      bind: executor.bind.bind(executor), dispatch: executor.dispatch.bind(executor), reconcile: executor.reconcile.bind(executor) });
  }
  async function perform(input: VaultOperation, fence: JobLeaseFence | undefined, reconcile: boolean): Promise<JobStoreResult<EffectObservation>> {
    try {
      if (!validateVaultOperationSchema(input).ok) return { ok: false, code: 'invalid_payload' };
      const request = copy(input), executor = registry.get(request.effect.operationRef);
      if (!executor || (!reconcile && (!fence || !validJobFence(fence)))) {
        if (!reconcile) await port.auditDenial(request);
        return { ok: false, code: 'not_authorized' };
      }
      const effect = executor.bind(copy(request));
      if (!validEffectRequest(effect) || !sameLeaseValue(effect.identity, request.identity)
        || !(['effectRef', 'actionRef', 'operationRef'] as const).every(k => effect[k] === request.effect[k]))
        return { ok: false, code: 'invalid_payload' };
      let session: VaultUseSession<PrivateValue> | undefined;
      const current = () => session && validateVaultOperation(request, session.context(), host.now()).ok;
      const effects = createEffects({ now: () => host.now(), withAuthority: (_r, phase, run) =>
        host.withAuthority(copy(request), phase, async authority => {
          if (authority.actorRef !== request.identity.host.userRef) return { ok: false, code: 'not_authorized' };
          const lease = { host: authority.host, grantRevision: authority.grantRevision, cancellationRevision: authority.cancellationRevision };
          if (phase === 'reconcile') return run(lease);
          return port.withUse(request, effect, phase, { fence: fence!, authority: lease, now: () => host.now() }, authority.actorRef, async locked => {
            session = locked;
            try {
              if (!current()) return { ok: false, code: 'not_authorized' };
              return await run(lease);
            } finally { session = undefined; }
          });
        }),
      }, {
        admit: (r, a) => session!.effects.admit(r, a),
        dispatch: (r, a, read, run) => session!.effects.dispatch(r, a, read, run),
        reconcile: (r, read) => port.effects.reconcile(r, read),
      }, {
        async dispatch(_r, signal) {
          const active = session;
          if (!active || signal.aborted || !current()) return { outcome: 'unknown' };
          const value = await active.readForExecutor();
          // A timed-out custody await must never start a late executor operation.
          if (!value.ok || signal.aborted || session !== active || !current()) return { outcome: 'unknown' };
          const outcome = await executor.dispatch(copy(request), value.value, signal,
            () => !signal.aborted && session === active && !!current());
          return outcome === 'verified' ? { outcome, receiptRef: request.effect.effectRef } : { outcome: 'unknown' };
        },
        async reconcile(_r, signal) {
          const outcome = await executor.reconcile(copy(request), signal);
          return outcome === 'verified' ? { outcome, receiptRef: request.effect.effectRef }
            : outcome === 'not_applied' ? { outcome, evidenceRef: request.effect.effectRef } : { outcome: 'unknown' };
        },
      }, timeoutMs);
      const result = reconcile ? await effects.reconcile(effect) : await effects.execute(effect, copy(fence!));
      if (!result.ok && !reconcile) await port.auditDenial(request);
      return result;
    } catch { return { ok: false, code: 'unavailable' }; }
  }
  return {
    execute: (request: VaultOperation, fence: JobLeaseFence) => perform(request, fence, false),
    reconcile: (request: VaultOperation) => perform(request, undefined, true),
  };
}
