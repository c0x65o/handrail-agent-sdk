import type { JobErrorCode, JobEvent, JobIdentity, JobSnapshot } from '../contracts/job.js';

export type JobStoreErrorCode = JobErrorCode | 'conflict' | 'not_found'
  | 'invalid_checkpoint' | 'invalid_history';
export type JobStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JobStoreErrorCode };

/** Injected trusted-server persistence only. The caller authorizes every operation
 * and supplies host-approved nonsecret references. Identity equality is a fence,
 * not authentication. Implementations return fixed errors without driver causes.
 * Handrail implements this port over its native task services.
 */
export interface JobStore {
  /** previousRevision is the CAS expectation. Delivery is stored separately;
   * canonical comparison includes every other field (object key order ignored).
   * An identical retry returns the original canonical event, without delivery.
   */
  append(event: JobEvent): Promise<JobStoreResult<{ readonly event: JobEvent; readonly replayed: boolean }>>;
  /** Validate canonical history and checkpoint; repair missing/stale checkpoints.
   * Ahead, incompatible or inconsistent checkpoints fail closed.
   */
  load(identity: JobIdentity): Promise<JobStoreResult<JobSnapshot>>;
}
