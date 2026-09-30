import { sameLeaseValue } from '../job-lease.js';
import { validateJobEvent } from '../../contracts/job.js';
import type { JobEvent, JobSnapshot } from '../../contracts/job.js';
import type { journalTables } from './db/schema.js';

/** Narrow alternative to lifecycle validation, only with a durable ledger proof.
 * Generic append never invokes this. History checks the immutable receipt and
 * exact resolving revision, so arbitrary outcome edits still fail closed. */
export function isEffectResolution(before: JobSnapshot | null, event: JobEvent,
  rows: (ReturnType<typeof journalTables>['effects']['$inferSelect'])[]): boolean {
  if (!before || before.state !== 'running' || event.kind !== 'effects_recorded'
    || !validateJobEvent(event).ok || event.previousRevision !== before.revision
    || !sameLeaseValue(before.identity, event.snapshot.identity)
    || before.effects.length !== event.snapshot.effects.length) return false;
  let changes = 0;
  return before.effects.every((old, index) => {
    const next = event.snapshot.effects[index];
    if (sameLeaseValue(old, next)) return true;
    changes++;
    return old.outcome === 'unknown' && next.outcome === 'verified'
      && sameLeaseValue({ ...old, outcome: 'verified' }, next)
      && rows.some(row => row.jobId === before.identity.jobId && row.effectRef === old.effectRef
        && row.resolvedRevision === event.snapshot.revision && row.observation.outcome === 'verified'
        && sameLeaseValue(row.request.identity, before.identity)
        && row.request.actionRef === old.actionRef && row.request.operationRef === old.operationRef);
  }) && changes === 1;
}
