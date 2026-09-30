import { assistanceDigest } from './assistance.js';
import type { NotificationFact } from './assistance.js';
import type { createEffects, EffectRequest } from './effects.js';
import type { JobLease, JobLeaseFence } from './job-lease.js';
import { sameLeaseValue } from './job-lease.js';
import type { JobIdentity } from '../contracts/job.js';
import type { JobStore } from './job-store.js';

/** Notification delivery uses the EXISTING job lease and effect ledger. The
 * inbox is already committed. Bind each recipient/channel to a dedicated
 * admitted job; never reuse the model job, which may already be terminal. */
export function createNotificationDelivery(deps: {
  readonly effects: ReturnType<typeof createEffects>; readonly lease: JobLease;
  readonly journal: JobStore;
  readonly leaseTtlMs: number;
  /** Thin SQL/provider destination query. Page fairly; exclude completed jobs.
   * No token or content bytes. Each delivery still checks current authority. */
  readonly pending?: () => Promise<readonly { fact: NotificationFact; channelRef: string }[]>;
  /** Idempotently admit a notification job through createJobAdmission. Bind
   * fact + channel + current destination/mandate, resolving tokens privately.
   * Recheck authorization even when returning an existing admission. */
  readonly admit: (fact: NotificationFact, channelRef: string, effectRef: string) => Promise<{
    identity: JobIdentity; providerRef: string; actionRef: string;
  }>;
}) {
  if (!Number.isSafeInteger(deps.leaseTtlMs) || deps.leaseTtlMs < 1) throw Error('invalid_notification_lease');
  const delivery = {
    async deliver(input: NotificationFact, channelRef: string) {
      const fact = structuredClone(input);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channelRef)) throw Error('invalid_channel');
      const effectRef = `notification:${assistanceDigest([fact.scope, fact.factId, channelRef])}`;
      const admitted = await deps.admit(fact, channelRef, effectRef);
      if (!sameLeaseValue(admitted.identity.host, fact.scope)) throw Error('notification_scope_mismatch');
      const request: EffectRequest = { ...admitted, operationRef: 'notification', effectRef,
        idempotencyRef: effectRef, requestDigest: `sha256:${assistanceDigest([fact, channelRef, admitted])}` };
      const prior = await deps.journal.load(admitted.identity);
      if (!prior.ok) return prior;
      if (['succeeded', 'cancelled', 'failed'].includes(prior.value.state)) return deps.effects.reconcile(request);
      const claimed = await deps.lease.claim(admitted.identity, deps.leaseTtlMs);
      if (!claimed.ok || !claimed.value) return claimed;
      let fence: JobLeaseFence = claimed.value;
      let renewal: Promise<void> = Promise.resolve();
      let lost = false;
      const timer = setInterval(() => {
        renewal = renewal.then(async () => {
          if (lost) return;
          const result = await deps.lease.renew(fence, deps.leaseTtlMs);
          if (result.ok) fence = result.value; else lost = true;
        }).catch(() => { lost = true; });
      }, Math.max(1, Math.floor(deps.leaseTtlMs / 4)));
      try {
        const current = await deps.journal.load(admitted.identity);
        if (!current.ok) return current;
        if (current.value.state === 'queued') {
          const started = await deps.lease.append({ kind: 'started', previousRevision: current.value.revision,
            snapshot: { identity: admitted.identity, revision: current.value.revision + 1, effects: current.value.effects, state: 'running' } }, fence);
          if (!started.ok) return started;
        }
        const result = await deps.effects.execute(request, fence);
        if (result.ok && result.value.outcome === 'verified') {
          const current = await deps.journal.load(admitted.identity);
          if (!current.ok) return current;
          const completed = await deps.lease.complete({ kind: 'succeeded', previousRevision: current.value.revision,
            snapshot: { identity: admitted.identity, revision: current.value.revision + 1, effects: current.value.effects,
              state: 'succeeded', receipt: { receiptRef: result.value.receiptRef, verification: 'host_verified', jobId: admitted.identity.jobId, revision: current.value.revision + 1 } } }, fence);
          if (!completed.ok) return completed;
        }
        return result;
      }
      finally { clearInterval(timer); await renewal; await deps.lease.release(fence); }
    },
    async drain() {
      const results = [];
      for (const item of await deps.pending?.() ?? []) {
        try { results.push(await delivery.deliver(item.fact, item.channelRef)); }
        catch { results.push({ ok: false as const, code: 'unavailable' as const }); }
      }
      return results;
    },
  };
  return delivery;
}
