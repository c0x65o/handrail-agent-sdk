import { createHash } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import { validateJobTransition } from '../../src/contracts/job.js';
import type { JobEvent, JobSnapshot } from '../../src/contracts/job.js';
import type { JobAnswerStore, JobAnswerReceipt } from '../../src/server/answer.js';
import type { JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import { sameLeaseValue } from '../../src/server/job-lease.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';

class Rejection extends Error { constructor(readonly code: JobStoreErrorCode) { super(code); } }
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function unwrap<T>(result: JobStoreResult<T>): T { if (!result.ok) reject(result.code); return result.value; }
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A shared job row lock serializes completion with Stop, supersession and
 * competing completions. Only host-approved references enter the digest. */
export function createJobAnswerStore(db: ReferenceDatabase, tables = journalTables()): JobAnswerStore {
  const { jobs, events, checkpoints, challenges, answerDeliveries } = tables;
  return {
    issue(input, inputAuthority, now) {
      const challenge = copy(input), authority = copy(inputAuthority);
      return safe(async () => db.transaction(async tx => {
        const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, challenge.identity.jobId)).for('update');
        if (!head || !sameLeaseValue(head.identity, challenge.identity)
          || !sameLeaseValue(head.identity.host, authority.host)) reject('not_authorized');
        if (head.cancellationEpoch > authority.cancellationRevision || challenge.expiresAt <= now) reject('invalid_transition');
        const current = unwrap(await createJobJournal(tx, tables).load(challenge.identity, false));
        if (current.state !== 'waiting' || current.answer || current.revision !== challenge.jobRevision
          || !sameLeaseValue(current.requirement, challenge.requirement)
          || current.requirement.actor.actorRef !== challenge.resolverRef) reject('requirement_mismatch');
        const value = { jobId: head.jobId, requirementRef: challenge.requirement.requirementRef,
          requirementRevision: challenge.requirement.revision, jobRevision: challenge.jobRevision,
          expiresAt: challenge.expiresAt, resolverRef: challenge.resolverRef,
          grantRevision: authority.grantRevision, cancellationRevision: authority.cancellationRevision, consumed: 0 };
        const [old] = await tx.select().from(challenges).where(eq(challenges.jobId, head.jobId));
        if (old && old.jobRevision === value.jobRevision && old.requirementRef === value.requirementRef
          && old.requirementRevision === value.requirementRevision) {
          if (!sameLeaseValue(old, value)) reject('conflict');
          return;
        }
        await tx.insert(challenges).values(value).onConflictDoUpdate({ target: challenges.jobId, set: value });
      }));
    },
    complete(input, inputAuthority, now) {
      const delivery = copy(input), authority = copy(inputAuthority);
      return safe(async () => db.transaction(async tx => {
        const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, delivery.identity.jobId)).for('update');
        if (!head || !sameLeaseValue(head.identity, delivery.identity)
          || !sameLeaseValue(head.identity.host, authority.host)) reject('not_authorized');
        const digest = createHash('sha256').update(JSON.stringify([1, delivery.requirementRef,
          delivery.requirementRevision, delivery.resolverRef, delivery.status, delivery.responseRef])).digest('hex');
        const [prior] = await tx.select().from(answerDeliveries).where(and(
          eq(answerDeliveries.jobId, head.jobId), eq(answerDeliveries.deliveryKey, delivery.deliveryKey)));
        if (prior) {
          if (prior.digest !== digest) reject('conflict');
          return { jobId: head.jobId, eventCursor: prior.eventCursor, deliveryKey: delivery.deliveryKey,
            replayed: true, resumable: true } satisfies JobAnswerReceipt;
        }
        if (head.cancellationEpoch > authority.cancellationRevision) reject('not_authorized');
        const [challenge] = await tx.select().from(challenges).where(eq(challenges.jobId, head.jobId));
        if (!challenge || challenge.consumed || challenge.expiresAt <= now
          || challenge.requirementRef !== delivery.requirementRef
          || challenge.requirementRevision !== delivery.requirementRevision
          || challenge.resolverRef !== delivery.resolverRef
          || challenge.grantRevision !== authority.grantRevision
          || challenge.cancellationRevision !== authority.cancellationRevision) reject('requirement_mismatch');
        const current = unwrap(await createJobJournal(tx, tables).load(delivery.identity, false));
        if (current.state !== 'waiting' || current.answer || current.revision !== challenge.jobRevision
          || current.requirement.requirementRef !== challenge.requirementRef
          || current.requirement.revision !== challenge.requirementRevision
          || current.requirement.actor.actorRef !== delivery.resolverRef) reject('requirement_mismatch');
        const answer = { requirementRef: challenge.requirementRef,
          requirementRevision: challenge.requirementRevision, responseRef: delivery.responseRef };
        const snapshot: JobSnapshot & { state: 'waiting' } = { ...current, revision: current.revision + 1, answer };
        const event: JobEvent = { kind: 'answered', previousRevision: current.revision,
          command: { command: 'answer', identity: current.identity, expectedRevision: current.revision, answer }, snapshot };
        const checked = validateJobTransition(current, event);
        if (!checked.ok) reject(checked.code);
        await tx.insert(events).values({ jobId: head.jobId, revision: snapshot.revision, event });
        await tx.update(jobs).set({ revision: snapshot.revision }).where(eq(jobs.jobId, head.jobId));
        await tx.insert(checkpoints).values({ jobId: head.jobId, version: 1, revision: snapshot.revision, snapshot })
          .onConflictDoUpdate({ target: checkpoints.jobId, set: { version: 1, revision: snapshot.revision, snapshot } });
        await tx.update(challenges).set({ consumed: 1 }).where(eq(challenges.jobId, head.jobId));
        await tx.insert(answerDeliveries).values({ jobId: head.jobId, deliveryKey: delivery.deliveryKey,
          digest, eventCursor: snapshot.revision });
        return { jobId: head.jobId, eventCursor: snapshot.revision, deliveryKey: delivery.deliveryKey,
          replayed: false, resumable: true } satisfies JobAnswerReceipt;
      }));
    },
    events(input, inputAuthority, afterRevision, limit) {
      const identity = copy(input), authority = copy(inputAuthority);
      return safe(async () => db.transaction(async tx => {
        const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, identity.jobId));
        if (!head || !sameLeaseValue(head.identity, identity)
          || !sameLeaseValue(head.identity.host, authority.host)) reject('not_authorized');
        const current = unwrap(await createJobJournal(tx, tables).load(identity, false));
        if (afterRevision > current.revision) reject('invalid_revision');
        const rows = await tx.select().from(events).where(and(eq(events.jobId, head.jobId),
          gt(events.revision, afterRevision))).orderBy(asc(events.revision)).limit(limit);
        return rows.map(row => ({ kind: row.event.kind,
            revision: row.revision, jobId: head.jobId }));
      }));
    },
  };
}
