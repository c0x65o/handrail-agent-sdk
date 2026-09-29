import { validateJobCommand } from '../contracts/job.js';
import type { CancelJobCommand, JobIdentity, JobSnapshot } from '../contracts/job.js';
import type { JobStoreResult } from './job-store.js';
import { sameLeaseValue, validLeaseAuthority } from './job-lease.js';
import type { JobLeaseAuthority } from './job-lease.js';

/** The trusted host authenticates the Stop actor and original job scope, including
 * tenant, account, environment and native holds. Its authority lock must remain
 * held until the store transaction commits. Disconnects never call this port. */
export interface JobCancellationHost {
  withStopAuthority<T>(identity: JobIdentity, actorRef: string,
    run: (authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  /** Reauthorize a nonsecret reconciliation reference after Stop. */
  withEvidenceAuthority<T>(identity: JobIdentity, actorRef: string,
    run: (authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
}
export interface JobCancellationEvidence {
  readonly identity: JobIdentity;
  readonly effectRef: string;
  readonly evidenceRef: string;
  readonly outcome: 'unknown' | 'verified' | 'not_applied';
}
export interface JobCancellationStore {
  /** Row-lock the job, persist cancelled and advance its epoch atomically.
   * A duplicate Stop returns the original cancelled snapshot. */
  cancel(command: CancelJobCommand, actorRef: string, authority: JobLeaseAuthority): Promise<JobStoreResult<JobSnapshot & { state: 'cancelled' }>>;
  attachEvidence(evidence: JobCancellationEvidence, actorRef: string, authority: JobLeaseAuthority): Promise<JobStoreResult<void>>;
}

/** Explicit Stop is independent of lease ownership, so it can fence a running
 * worker. All later append, resume and effect admission paths observe the same
 * committed job row. In-flight remote effects retain their recorded outcome. */
export function createJobCancellation(host: JobCancellationHost, store: JobCancellationStore) {
  const ref = (value: unknown): value is string => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  return {
    async stop(command: CancelJobCommand, actorRef: string): Promise<JobStoreResult<JobSnapshot & { state: 'cancelled' }>> {
      if (!validateJobCommand(command).ok || !ref(actorRef)) return { ok: false, code: 'invalid_payload' };
      try {
        const detached = JSON.parse(JSON.stringify(command)) as CancelJobCommand;
        return await host.withStopAuthority(detached.identity, actorRef, async authority => {
          if (!validLeaseAuthority(authority, detached.identity)
            || !sameLeaseValue(authority.host, detached.identity.host)) return { ok: false, code: 'not_authorized' };
          return store.cancel(detached, actorRef, JSON.parse(JSON.stringify(authority)) as JobLeaseAuthority);
        });
      } catch { return { ok: false, code: 'not_authorized' }; }
    },
    async attachEvidence(input: JobCancellationEvidence, actorRef: string): Promise<JobStoreResult<void>> {
      let evidence: JobCancellationEvidence;
      try {
        if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
          || Reflect.ownKeys(input).length !== 4 || !ref(actorRef)) return { ok: false, code: 'invalid_payload' };
        for (const key of ['identity', 'effectRef', 'evidenceRef', 'outcome']) {
          const property = Object.getOwnPropertyDescriptor(input, key);
          if (!property?.enumerable || !('value' in property)) return { ok: false, code: 'invalid_payload' };
        }
        if (!ref(input.effectRef) || !ref(input.evidenceRef)
          || !['unknown', 'verified', 'not_applied'].includes(input.outcome)
          || !validateJobCommand({ command: 'inspect', identity: input.identity }).ok) return { ok: false, code: 'invalid_payload' };
        evidence = JSON.parse(JSON.stringify(input)) as JobCancellationEvidence;
      } catch { return { ok: false, code: 'invalid_payload' }; }
      try {
        return await host.withEvidenceAuthority(evidence.identity, actorRef, async authority => {
          if (!validLeaseAuthority(authority, evidence.identity)) return { ok: false, code: 'not_authorized' };
          return store.attachEvidence(evidence, actorRef, JSON.parse(JSON.stringify(authority)) as JobLeaseAuthority);
        });
      } catch { return { ok: false, code: 'not_authorized' }; }
    },
  };
}
