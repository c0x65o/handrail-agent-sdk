import type { JobErrorCode, JobEvent, JobSnapshot } from '../contracts/job.js';
import type { JobAuthority, JobSubmission } from './submit.js';

export type JobStoreErrorCode = JobErrorCode | 'conflict' | 'not_found'
  | 'invalid_checkpoint' | 'invalid_history' | 'lease_lost';
export type JobStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JobStoreErrorCode };

/** Trusted persistence boundary. Atomically reserve a request and its first
 * event. Implementations must compare the full binding, excluding only the
 * proposed job ID, and return the canonical event for an identical retry.
 * Inspection must enforce the authenticated authority before returning data.
 */
export interface JobAdmissionStore {
  admit(input: {
    readonly namespaceRef: string;
    readonly grantRevision: number;
    readonly operation: JobSubmission['operation'];
    readonly event: JobEvent;
  }): Promise<JobStoreResult<{ readonly event: JobEvent; readonly replayed: boolean }>>;
  inspectAdmission(jobId: string, authority: JobAuthority): Promise<JobStoreResult<JobSnapshot>>;
}
