import { performance } from 'node:perf_hooks';
import { validateJobCommand } from '../../src/contracts/job.js';
import type { JobIdentity, JobSnapshot, JobEvent } from '../../src/contracts/job.js';
import type { JobLease, JobLeaseFence } from '../../src/server/job-lease.js';
import { sameLeaseValue } from '../../src/server/job-lease.js';
import type { JobAdmissionStore, JobStore, JobStoreResult } from '../../src/server/job-store.js';
import type { JobAuthority } from '../../src/server/submit.js';

export interface ReferenceWorkerHost {
  /** Host-owned dispatch inventory. It may contain stale or waiting jobs. */
  recover(): Promise<readonly JobIdentity[]>;
  /** Reauthorize the original scope before each lookup; possession of an ID is insufficient. */
  authorize(identity: JobIdentity): Promise<JobAuthority | null>;
}

/** This adapter is trusted host code. It must be deterministic and effect-free.
 * External effects stay disabled until the separate reconciliation port exists. */
export type DeterministicStep = (snapshot: JobSnapshot & { state: 'running' },
  signal: AbortSignal) => Promise<{ readonly kind: 'checkpoint' } |
    { readonly kind: 'succeeded'; readonly receiptRef: string }>;

export interface WorkerLimits {
  /** Total committed deterministic checkpoints on this job, including earlier processes. */
  readonly maxSteps: number;
  /** Wall time for one dispatch; each adapter call has its own smaller ceiling. */
  readonly maxElapsedMs: number;
  readonly maxStepMs: number;
  /** Additional tries for a thrown/invalid adapter result in this dispatch. */
  readonly maxRetries: number;
  readonly leaseTtlMs: number;
}

export type WorkerOutcome = 'succeeded' | 'failed' | 'waiting' | 'cancelled' | 'busy' | 'stopped';
const bad = (code: 'invalid_payload' | 'not_authorized' | 'unavailable' | 'lease_lost' | 'effect_conflict') =>
  ({ ok: false, code } as const);
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function limitsValid(v: WorkerLimits): boolean {
  return positive(v.maxSteps) && positive(v.maxElapsedMs) && positive(v.maxStepMs)
    && Number.isSafeInteger(v.maxRetries) && v.maxRetries >= 0 && positive(v.leaseTtlMs)
    && v.maxStepMs < v.leaseTtlMs;
}
function next(snapshot: JobSnapshot, kind: 'started' | 'effects_recorded' | 'succeeded' | 'failed', receiptRef?: string): JobEvent {
  const revision = snapshot.revision + 1;
  const base = { identity: snapshot.identity, revision, effects: snapshot.effects };
  const state = kind === 'started' || kind === 'effects_recorded' ? 'running' : kind;
  const successor: JobSnapshot = state === 'succeeded'
    ? { ...base, state, receipt: { receiptRef: receiptRef!, verification: 'host_verified', jobId: snapshot.identity.jobId, revision } }
    : state === 'failed'
      ? { ...base, state, error: { code: 'execution_failed', correlationRef: snapshot.identity.origin.correlationRef } }
      : { ...base, state: 'running' };
  return { kind, previousRevision: snapshot.revision, snapshot: successor };
}

/** No import-time IO, timer or dispatch. The reference host owns connection,
 * recovery inventory and wake calls. A native host must use its native worker. */
export function createReferenceWorker(deps: {
  readonly host: ReferenceWorkerHost;
  readonly admission: JobAdmissionStore;
  readonly journal: JobStore & { countCheckpoints(identity: JobIdentity): Promise<JobStoreResult<number>> };
  readonly lease: JobLease;
  readonly step: DeterministicStep;
  readonly limits: WorkerLimits;
}) {
  if (!limitsValid(deps.limits)) throw new Error('WORKER_LIMITS_INVALID');
  let started = false;
  let stopping = false;
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const inFlight = new Map<string, { identity: JobIdentity; pending: Promise<JobStoreResult<WorkerOutcome>> }>();

  async function authorizedLoad(identity: JobIdentity): Promise<JobStoreResult<JobSnapshot>> {
    if (!validateJobCommand({ command: 'inspect', identity }).ok) return bad('invalid_payload');
    let authority: JobAuthority | null;
    try { authority = await deps.host.authorize(structuredClone(identity)); }
    catch { return bad('not_authorized'); }
    if (!authority || !sameLeaseValue(authority.host, identity.host)) return bad('not_authorized');
    const admission = await deps.admission.inspectAdmission(identity.jobId, authority);
    if (!admission.ok) return admission;
    if (!sameLeaseValue(admission.value.identity, identity)) return bad('not_authorized');
    return deps.journal.load(identity);
  }

  async function stepWithDeadline(snapshot: JobSnapshot & { state: 'running' },
    remainingMs: number): Promise<'stopped' | 'failed' | Awaited<ReturnType<DeterministicStep>>> {
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    try {
      const timeout = new Promise<'failed' | 'stopped'>(resolve => {
        onStop = () => resolve(controller.signal.reason === 'deadline' ? 'failed' : 'stopped');
        controller.signal.addEventListener('abort', onStop, { once: true });
        timer = setTimeout(() => controller.abort('deadline'), Math.min(remainingMs, deps.limits.maxStepMs));
      });
      const result = await Promise.race([
        Promise.resolve().then(() => deps.step(structuredClone(snapshot), controller.signal))
          .catch(() => 'failed' as const), timeout,
      ]);
      if (stopping) return 'stopped';
      if (result === 'failed' || result === 'stopped') return result;
      if (result?.kind === 'checkpoint' && Object.keys(result).length === 1) return result;
      if (result?.kind === 'succeeded' && Object.keys(result).length === 2
        && typeof result.receiptRef === 'string') return result;
      return 'failed';
    } finally {
      if (timer) clearTimeout(timer);
      if (onStop) controller.signal.removeEventListener('abort', onStop);
      controller.abort(); controllers.delete(controller);
    }
  }

  async function run(identity: JobIdentity): Promise<JobStoreResult<WorkerOutcome>> {
    if (stopping) return { ok: true, value: 'stopped' };
    const loaded = await authorizedLoad(identity);
    if (!loaded.ok) return loaded;
    let snapshot = loaded.value;
    if (snapshot.state === 'waiting') return { ok: true, value: 'waiting' }; // Only a durable answer/resume may queue it.
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) return { ok: true, value: snapshot.state as WorkerOutcome };
    if (snapshot.effects.length) return bad('effect_conflict'); // No external-effect reconciliation in this worker.
    const claimed = await deps.lease.claim(identity, deps.limits.leaseTtlMs);
    if (!claimed.ok) return claimed;
    if (!claimed.value) return { ok: true, value: 'busy' };
    let fence: JobLeaseFence = claimed.value;
    const begin = performance.now();
    try {
      // A queued job has no step until the start checkpoint commits.
      const fresh = await authorizedLoad(identity);
      if (!fresh.ok) return fresh;
      snapshot = fresh.value;
      if (snapshot.state === 'queued') {
        const appended = await deps.lease.append(next(snapshot, 'started'), fence);
        if (!appended.ok) return appended;
        snapshot = appended.value.event.snapshot;
      }
      if (snapshot.state !== 'running') return bad('lease_lost');
      if (snapshot.effects.length) return bad('effect_conflict');
      const durableCount = await deps.journal.countCheckpoints(identity);
      if (!durableCount.ok) return durableCount;
      let checkpoints = durableCount.value;
      let retries = 0;
      for (;;) {
        if (stopping) return { ok: true, value: 'stopped' };
        const elapsed = performance.now() - begin;
        if (elapsed >= deps.limits.maxElapsedMs || checkpoints >= deps.limits.maxSteps) {
          const failed = await deps.lease.complete(next(snapshot, 'failed'), fence);
          return failed.ok ? { ok: true, value: 'failed' } : failed;
        }
        const renewed = await deps.lease.renew(fence, deps.limits.leaseTtlMs);
        if (!renewed.ok) return renewed;
        fence = renewed.value;
        const checked = await deps.lease.check(fence);
        if (!checked.ok) return checked;
        const result = await stepWithDeadline(snapshot as JobSnapshot & { state: 'running' }, deps.limits.maxElapsedMs - elapsed);
        if (result === 'stopped') return { ok: true, value: 'stopped' };
        // A Stop may have committed while the deterministic callback ran. The
        // subsequent append is fenced too; this check avoids further work first.
        const afterStep = await deps.lease.check(fence);
        if (!afterStep.ok) return afterStep;
        if (result === 'failed') {
          if (retries++ < deps.limits.maxRetries && performance.now() - begin < deps.limits.maxElapsedMs) continue;
          const failed = await deps.lease.complete(next(snapshot, 'failed'), fence);
          return failed.ok ? { ok: true, value: 'failed' } : failed;
        }
        if (performance.now() - begin >= deps.limits.maxElapsedMs) {
          const failed = await deps.lease.complete(next(snapshot, 'failed'), fence);
          return failed.ok ? { ok: true, value: 'failed' } : failed;
        }
        retries = 0;
        const event: JobEvent = result.kind === 'checkpoint' ? next(snapshot, 'effects_recorded')
          : next(snapshot, 'succeeded', result.receiptRef);
        const appended: Awaited<ReturnType<JobLease['append']>> = result.kind === 'succeeded'
          ? await deps.lease.complete(event, fence) : await deps.lease.append(event, fence);
        if (!appended.ok) return appended;
        snapshot = appended.value.event.snapshot;
        if (result.kind === 'checkpoint') checkpoints++;
        if (result.kind === 'succeeded') return { ok: true, value: 'succeeded' };
      }
    } finally {
      // Terminal append releases atomically. A stale release is harmless.
      await deps.lease.release(fence);
    }
  }

  function wake(identity: JobIdentity): Promise<JobStoreResult<WorkerOutcome>> {
    if (!started || stopping) return Promise.resolve({ ok: true, value: 'stopped' });
    if (!validateJobCommand({ command: 'inspect', identity }).ok) return Promise.resolve(bad('invalid_payload'));
    const existing = inFlight.get(identity.jobId);
    if (existing) return sameLeaseValue(existing.identity, identity)
      ? existing.pending : Promise.resolve(bad('not_authorized'));
    const pending = run(identity).catch(() => bad('unavailable'));
    inFlight.set(identity.jobId, { identity: structuredClone(identity), pending }); active.add(pending);
    void pending.finally(() => { inFlight.delete(identity.jobId); active.delete(pending); });
    return pending;
  }
  return {
    async start(): Promise<readonly JobStoreResult<WorkerOutcome>[]> {
      if (started) throw new Error('WORKER_ALREADY_STARTED');
      started = true;
      const identities = await deps.host.recover();
      const results: JobStoreResult<WorkerOutcome>[] = [];
      for (const identity of identities) {
        if (stopping) break;
        results.push(await wake(identity));
      }
      return results;
    },
    wake,
    async stop(): Promise<void> {
      stopping = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active]);
      started = false;
    },
  };
}
