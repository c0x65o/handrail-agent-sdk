import type { JobErrorCode, JobEvent, JobIdentity, JobSnapshot } from '../contracts/job.js';

export type JobStoreErrorCode = JobErrorCode | 'conflict' | 'not_found'
  | 'invalid_checkpoint' | 'invalid_history' | 'lease_lost';
export type JobStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JobStoreErrorCode };

/** Injected trusted-server persistence only. The caller authorizes every operation
 * and supplies host-approved nonsecret references. Identity equality is a fence,
 * not authentication. Implementations return fixed errors without driver causes.
 * Handrail implements this port over its native task services.
 */
export interface JobStore {
  /** previousRevision is the CAS expectation. Delivery is stored separately;
   * Non-submitted writes require a current fence in the same transaction.
   * canonical comparison includes every other field (object key order ignored).
   * An identical retry returns the original canonical event, without delivery.
   */
  append(event: JobEvent, fence?: import('./job-lease.js').JobAppendFence): Promise<JobStoreResult<{ readonly event: JobEvent; readonly replayed: boolean }>>;
  /** Validate canonical history and checkpoint; repair missing/stale checkpoints.
   * Ahead, incompatible or inconsistent checkpoints fail closed.
   */
  load(identity: JobIdentity): Promise<JobStoreResult<JobSnapshot>>;
}

/** Trusted persistence boundary. Atomically bind a request reservation to its
 * initial event. Implementations must detach/validate inputs and compare the
 * entire canonical binding, excluding only the newly proposed job ID. */
export interface JobAdmissionStore {
  admit(input: {
    readonly namespaceRef: string;
    readonly grantRevision: number;
    readonly operation: import('./submit.js').JobSubmission['operation'];
    readonly event: JobEvent;
  }): Promise<JobStoreResult<{ readonly event: JobEvent; readonly replayed: boolean }>>;
  inspectAdmission(jobId: string, authority: import('./submit.js').JobAuthority): Promise<JobStoreResult<JobSnapshot>>;
}
