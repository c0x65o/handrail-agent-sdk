import { and, eq } from 'drizzle-orm';
import { validateJobCommand, validateJobTransition } from '../../contracts/job.js';
import type { JobEvent, JobSnapshot } from '../../contracts/job.js';
import { sameLeaseValue, validLeaseAuthority } from '../job-lease.js';
import type { JobCancellationStore } from '../cancel.js';
import type { JobStoreErrorCode, JobStoreResult } from '../job-store.js';
import type { AgentPostgresDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';
import { releasedLease } from './job-lease-fence.js';

class Rejection extends Error {
  constructor(readonly code: JobStoreErrorCode) { super(code); }
}
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function unwrap<T>(result: JobStoreResult<T>): T { if (!result.ok) reject(result.code); return result.value; }

/** Reference PostgreSQL implementation. The job row lock serializes Stop with
 * claims, appends and effect admissions across independent worker processes. */
export function createJobCancellationStore(db: AgentPostgresDatabase, tables = journalTables()): JobCancellationStore {
  const { jobs, events, checkpoints, cancellationEvidence } = tables;
  return {
    async cancel(input, actorRef, authority) {
      if (!validateJobCommand(input).ok || input.command !== 'cancel'
        || !validLeaseAuthority(authority, input.identity)) return { ok: false, code: 'invalid_payload' };
      const command = JSON.parse(JSON.stringify(input)) as typeof input;
      const scope = JSON.parse(JSON.stringify(authority)) as typeof authority;
      try {
        const value = await db.transaction(async tx => {
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, command.identity.jobId)).for('update');
          if (!head || !sameLeaseValue(head.identity, command.identity)
            || !sameLeaseValue(scope.host, head.identity.host)) reject('not_authorized');
          const current = unwrap(await createJobJournal(tx, tables).load(command.identity, false));
          if (current.state === 'cancelled') return current;
          if (head.cancellationEpoch > scope.cancellationRevision) reject('lease_lost');
          const checked = validateJobCommand(command, current);
          if (!checked.ok) reject(checked.code);
          if (Math.max(head.cancellationEpoch, scope.cancellationRevision) >= Number.MAX_SAFE_INTEGER
            || head.leaseEpoch >= Number.MAX_SAFE_INTEGER || head.revision >= Number.MAX_SAFE_INTEGER) reject('lease_lost');
          const snapshot: JobSnapshot & { state: 'cancelled' } = {
            identity: current.identity, revision: current.revision + 1, state: 'cancelled', effects: current.effects,
            cancellation: { reason: 'explicit_stop', actorRef },
          };
          const event: JobEvent = { kind: 'cancelled', command, previousRevision: current.revision, snapshot };
          const transition = validateJobTransition(current, event);
          if (!transition.ok) reject(transition.code);
          await tx.insert(events).values({ jobId: head.jobId, revision: snapshot.revision, event });
          await tx.update(jobs).set({ revision: snapshot.revision,
            cancellationEpoch: Math.max(head.cancellationEpoch, scope.cancellationRevision) + 1, leaseEpoch: head.leaseEpoch + 1,
            ...releasedLease }).where(eq(jobs.jobId, head.jobId));
          await tx.insert(checkpoints).values({ jobId: head.jobId, version: 1, revision: snapshot.revision, snapshot })
            .onConflictDoUpdate({ target: checkpoints.jobId, set: { version: 1, revision: snapshot.revision, snapshot } });
          return snapshot;
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' };
      }
    },
    async attachEvidence(input, actorRef, authority) {
      if (!validateJobCommand({ command: 'inspect', identity: input.identity }).ok
        || !validLeaseAuthority(authority, input.identity)) return { ok: false, code: 'invalid_payload' };
      const evidence = JSON.parse(JSON.stringify(input)) as typeof input;
      try {
        await db.transaction(async tx => {
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, evidence.identity.jobId)).for('update');
          if (!head || !sameLeaseValue(head.identity, evidence.identity)
            || !sameLeaseValue(authority.host, head.identity.host)) reject('not_authorized');
          const current = unwrap(await createJobJournal(tx, tables).load(evidence.identity, false));
          if (current.state !== 'cancelled' || !current.effects.some(item => item.effectRef === evidence.effectRef)) reject('effect_conflict');
          const key = { jobId: head.jobId, effectRef: evidence.effectRef, evidenceRef: evidence.evidenceRef };
          // Read by key under the job lock. Repeated references are immutable.
          const [duplicate] = await tx.select().from(cancellationEvidence).where(and(
            eq(cancellationEvidence.jobId, key.jobId), eq(cancellationEvidence.effectRef, key.effectRef),
            eq(cancellationEvidence.evidenceRef, key.evidenceRef)));
          if (duplicate) {
            if (duplicate.outcome !== evidence.outcome || duplicate.actorRef !== actorRef) reject('conflict');
            return;
          }
          await tx.insert(cancellationEvidence).values({ ...key, outcome: evidence.outcome, actorRef });
        });
        return { ok: true, value: undefined };
      } catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
    },
  };
}
