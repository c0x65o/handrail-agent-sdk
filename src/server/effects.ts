import { validateJobCommand } from '../contracts/job.js';
import type { JobIdentity } from '../contracts/job.js';
import { sameLeaseValue, validJobFence, validLeaseAuthority } from './job-lease.js';
import type { JobAppendFence, JobLeaseAuthority, JobLeaseFence } from './job-lease.js';
import type { JobStoreResult } from './job-store.js';

/** Trusted host-approved references only; never provider payloads or credentials.
 * requestDigest binds the canonical request AND its complete authorized scope.
 * providerRef identifies the adapter/account/environment idempotency namespace. */
export interface EffectRequest {
  readonly identity: JobIdentity;
  readonly effectRef: string;
  readonly actionRef: string;
  readonly operationRef: string;
  readonly requestDigest: string;
  readonly providerRef: string;
  readonly idempotencyRef: string;
}
export type EffectObservation = { readonly outcome: 'unknown' }
  | { readonly outcome: 'verified'; readonly receiptRef: string }
  | { readonly outcome: 'not_applied'; readonly evidenceRef: string };
export interface EffectAdapter {
  /** Resolve private input via trusted custody. Enforce provider idempotency.
   * Limits, consent, spending and other action gates remain host-owned. */
  dispatch(request: EffectRequest, signal: AbortSignal): Promise<EffectObservation>;
  /** Read only. not_applied MUST prove no old/in-flight call can subsequently
   * apply; absence from an eventually consistent lookup is insufficient. */
  reconcile(request: EffectRequest, signal: AbortSignal): Promise<EffectObservation>;
}
export interface EffectHost {
  /** Authenticate exact task/action/provider/request scope anew; hold native
   * authority stable through callback AND commit. Deny dispatch after Stop,
   * revocation, scope changes or gates/limits failure. Reconciliation may read
   * outstanding facts after cancellation, without authorizing another effect. */
  withAuthority<T>(request: EffectRequest, operation: 'admit' | 'dispatch' | 'reconcile',
    run: (authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  now(): number;
}
export interface EffectStore {
  /** Commit unknown and the complete immutable binding before any external IO. */
  admit(request: EffectRequest, access: JobAppendFence): Promise<JobStoreResult<{ admitted: boolean }>>;
  /** Serialize with Stop/other dispatch/reconcile calls. Check fence immediately
   * before run. Read/reconcile inside the same lock before dispatch; only verified not_applied permits it.
   * Persist a safe observation; unknown never grants retry permission. */
  dispatch(request: EffectRequest, access: JobAppendFence,
    read: () => Promise<EffectObservation>, run: () => Promise<EffectObservation>): Promise<JobStoreResult<EffectObservation>>;
  reconcile(request: EffectRequest, run: () => Promise<EffectObservation>): Promise<JobStoreResult<EffectObservation>>;
}
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function exact(v: any, keys: string[]): boolean {
  return !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))
    && Reflect.ownKeys(v).length === keys.length && keys.every(k => {
      const d = Object.getOwnPropertyDescriptor(v, k); return d?.enumerable && 'value' in d;
    });
}
export function validEffectRequest(v: EffectRequest): boolean {
  return exact(v, ['identity', 'effectRef', 'actionRef', 'operationRef', 'requestDigest', 'providerRef', 'idempotencyRef'])
    && validateJobCommand({ command: 'inspect', identity: v.identity }).ok
    && [v.effectRef, v.actionRef, v.operationRef, v.providerRef, v.idempotencyRef].every(ref)
    && /^sha256:[a-f0-9]{64}$/.test(v.requestDigest);
}
export function safeEffectObservation(v: EffectObservation): EffectObservation {
  try {
    if (exact(v, ['outcome', 'receiptRef']) && v.outcome === 'verified' && ref(v.receiptRef))
      return { outcome: 'verified', receiptRef: v.receiptRef };
    if (exact(v, ['outcome', 'evidenceRef']) && v.outcome === 'not_applied' && ref(v.evidenceRef))
      return { outcome: 'not_applied', evidenceRef: v.evidenceRef };
  } catch { /* Malformed/untrusted adapter outputs remain unknown. */ }
  return { outcome: 'unknown' };
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** No IO at construction. Adapter errors/late results/payloads never escape. */
export function createEffects(host: EffectHost, store: EffectStore, adapter: EffectAdapter, timeoutMs = 10_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_EFFECT_TIMEOUT');
  async function observe(operation: 'dispatch' | 'reconcile', request: EffectRequest): Promise<EffectObservation> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => adapter[operation](copy(request), controller.signal)).then(safeEffectObservation, () => ({ outcome: 'unknown' as const })),
        new Promise<EffectObservation>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ outcome: 'unknown' }); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function authorized<T>(r: EffectRequest, op: 'admit' | 'dispatch' | 'reconcile',
    run: (a: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    try {
      return await host.withAuthority(copy(r), op, async a => {
        if (!validLeaseAuthority(a, r.identity)) return { ok: false, code: 'not_authorized' };
        return run(copy(a));
      });
    } catch { return { ok: false, code: 'unavailable' }; }
  }
  async function reconcile(r: EffectRequest): Promise<JobStoreResult<EffectObservation>> {
    return authorized(r, 'reconcile', () => store.reconcile(r, () => observe('reconcile', r)));
  }
  return {
    async execute(input: EffectRequest, inputFence: JobLeaseFence): Promise<JobStoreResult<EffectObservation>> {
      try {
        if (!validEffectRequest(input) || !validJobFence(inputFence)) return { ok: false, code: 'invalid_payload' };
        const r = copy(input), fence = copy(inputFence);
        if (!sameLeaseValue(r.identity, fence.identity)) return { ok: false, code: 'identity_mismatch' };
        const access = (authority: JobLeaseAuthority) => ({ fence, authority, now: () => host.now() });
        const admission = await authorized(r, 'admit', a => store.admit(r, access(a)));
        if (!admission.ok) return admission;
        // Authority remains stable during the serialized read and dispatch.
        return await authorized(r, 'dispatch', a => store.dispatch(r, access(a),
          () => observe('reconcile', r), () => observe('dispatch', r)));
      } catch { return { ok: false, code: 'invalid_payload' }; }
    },
    async reconcile(input: EffectRequest): Promise<JobStoreResult<EffectObservation>> {
      try {
        if (!validEffectRequest(input)) return { ok: false, code: 'invalid_payload' };
        return await reconcile(copy(input));
      } catch { return { ok: false, code: 'invalid_payload' }; }
    },
  };
}
