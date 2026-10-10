import type { BrowserOperation, BrowserObservation } from '../contracts/browser.js';
import { validateBrowserOperationSchema, validateBrowserOperation, validateBrowserObservation } from '../contracts/browser.js';
import type { BrowserOperationContext } from './browser-policy.js';
import { createEffects, validEffectRequest } from './effects.js';
import type { EffectRequest, EffectObservation, EffectStore } from './effects.js';
import { validLeaseAuthority, validJobFence, sameLeaseValue } from './job-lease.js';
import type { JobLeaseAuthority, JobLeaseFence } from './job-lease.js';
import type { JobStoreResult } from './job-store.js';

/** Private server registration, never model input. The browser owner resolves
 * aliases, enforces egress on every hop, and fences document/lease changes during
 * IO. It must recheck isCurrent after awaits and immediately before acting.
 * No DOM, cookies, screenshots, traces or raw errors cross this boundary. */
export interface TrustedBrowserExecutor {
  readonly operationRef: string;
  bind(request: BrowserOperation): EffectRequest;
  dispatch(request: BrowserOperation, signal: AbortSignal, isCurrent: () => boolean): Promise<'verified' | 'unknown'>;
  /** not_applied must exclude any late in-flight operation. */
  reconcile(request: BrowserOperation, signal: AbortSignal): Promise<'verified' | 'not_applied' | 'unknown'>;
  /** Read-only, repeatable and reference-only. Release requires host approval. */
  observe(request: BrowserOperation, signal: AbortSignal): Promise<BrowserObservation>;
}
export interface BrowserUseSession {
  readonly authority: JobLeaseAuthority;
  /** Current facts under the native job/profile/document fences. Normalize only
   * this effect's admission out of currentJob, never unrelated pending effects. */
  context(): BrowserOperationContext;
  /** Post-effect authorization, including recipient and current lease/profile.
   * Unlike pre-dispatch validation, this must permit an already recorded effect. */
  canObserve(observation: BrowserObservation): boolean;
}
export interface BrowserUseHost {
  now(): number;
  /** Authenticate the original task and hold current authority through callback
   * AND commit, serializing Stop, profile revocation, takeover and navigation.
   * Reconciliation may only read facts after revocation. For observe, establish
   * fresh recipient authority; possession of references is never authorization. */
  withAuthority<T>(request: BrowserOperation, phase: 'admit' | 'dispatch' | 'reconcile' | 'observe',
    run: (session: BrowserUseSession) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Inert server composition over the existing effect ledger. Unknown effects
 * cannot be replayed; recovery is read-only. Vault actions deliberately use
 * createVaultUse instead, so a browser registration cannot bypass vault custody. */
export function createBrowserUse(host: BrowserUseHost, store: EffectStore,
  registrations: readonly TrustedBrowserExecutor[], timeoutMs = 10_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('INVALID_BROWSER_TIMEOUT');
  const registry = new Map<string, TrustedBrowserExecutor>();
  for (const r of registrations) {
    if (registry.has(r.operationRef)) throw Error('DUPLICATE_BROWSER_EXECUTOR');
    registry.set(r.operationRef, { operationRef: r.operationRef, bind: r.bind.bind(r),
      dispatch: r.dispatch.bind(r), reconcile: r.reconcile.bind(r), observe: r.observe.bind(r) });
  }
  function resolve(input: BrowserOperation) {
    if (!validateBrowserOperationSchema(input).ok || ['vault_fill', 'vault_capture'].includes(input.action.kind)) return null;
    const request = copy(input), executor = registry.get(request.effect.operationRef);
    if (!executor) return null;
    const effect = executor.bind(copy(request));
    if (!validEffectRequest(effect) || !sameLeaseValue(effect.identity, request.identity)
      || effect.idempotencyRef !== request.effect.effectRef
      || !(['effectRef', 'actionRef', 'operationRef'] as const).every(k => effect[k] === request.effect[k])) return null;
    return { request, executor, effect };
  }
  async function perform(input: BrowserOperation, fence: JobLeaseFence | undefined, reconcile: boolean): Promise<JobStoreResult<EffectObservation>> {
    try {
      const bound = resolve(input);
      if (!bound) return { ok: false, code: 'invalid_payload' };
      if (!reconcile && (!fence || !validJobFence(fence))) return { ok: false, code: 'not_authorized' };
      const { request, executor, effect } = bound;
      // Invocation-local state: concurrent requests never share native authority.
      let session: BrowserUseSession | undefined;
      const current = () => !!session && validateBrowserOperation(request, session.context(), host.now()).ok;
      const effects = createEffects({ now: () => host.now(), withAuthority: (_r, phase, run) =>
        host.withAuthority(copy(request), phase, async locked => {
          if (!validLeaseAuthority(locked.authority, request.identity)) return { ok: false, code: 'not_authorized' };
          session = locked;
          try {
            if (phase !== 'reconcile' && !current()) return { ok: false, code: 'not_authorized' };
            return await run(locked.authority);
          } finally { session = undefined; }
        }),
      }, store, {
        async dispatch(_r, signal) {
          const active = session;
          if (!active || signal.aborted || !current()) return { outcome: 'unknown' };
          const result = await executor.dispatch(copy(request), signal,
            () => !signal.aborted && session === active && current());
          return result === 'verified' ? { outcome: 'verified', receiptRef: effect.effectRef } : { outcome: 'unknown' };
        },
        async reconcile(_r, signal) {
          const result = await executor.reconcile(copy(request), signal);
          return result === 'verified' ? { outcome: 'verified', receiptRef: effect.effectRef }
            : result === 'not_applied' ? { outcome: 'not_applied', evidenceRef: effect.effectRef } : { outcome: 'unknown' };
        },
      }, timeoutMs);
      return reconcile ? await effects.reconcile(effect) : await effects.execute(effect, copy(fence!));
    } catch { return { ok: false, code: 'unavailable' }; }
  }
  async function observe(input: BrowserOperation): Promise<JobStoreResult<BrowserObservation>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bound = resolve(input);
      if (!bound) return { ok: false, code: 'invalid_payload' };
      const { request, executor } = bound;
      const result = host.withAuthority(copy(request), 'observe', async session => {
        if (controller.signal.aborted || !validLeaseAuthority(session.authority, request.identity))
          return { ok: false, code: 'not_authorized' } as const;
        const raw = await executor.observe(copy(request), controller.signal);
        if (controller.signal.aborted || !validateBrowserObservation(raw, request).ok)
          return { ok: false, code: 'not_authorized' } as const;
        const observation = copy(raw);
        if (session.canObserve(copy(observation)) !== true) return { ok: false, code: 'not_authorized' } as const;
        return { ok: true, value: observation } as const;
      });
      return await Promise.race([result, new Promise<JobStoreResult<BrowserObservation>>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false, code: 'unavailable' }); }, timeoutMs);
      })]);
    } catch { return { ok: false, code: 'unavailable' }; }
    finally { controller.abort(); if (timer !== undefined) clearTimeout(timer); }
  }
  return { execute: (request: BrowserOperation, fence: JobLeaseFence) => perform(request, fence, false),
    reconcile: (request: BrowserOperation) => perform(request, undefined, true), observe };
}
