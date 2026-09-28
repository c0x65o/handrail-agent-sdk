import { eq } from 'drizzle-orm';
import { validateJobEvent } from '../../src/contracts/job.js';
import { sameLeaseValue, validLeaseAuthority } from '../../src/server/job-lease.js';
import type { JobLeaseStore, JobLeaseContext, JobLeaseFence } from '../../src/server/job-lease.js';
import type { JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';
import { copyAppendFence, fenceFromHead, leaseExpiry, leaseNow, matchesJobFence, releasedLease } from './job-lease-fence.js';

class Rejection extends Error {
  constructor(readonly code: JobStoreErrorCode) { super(code); }
}
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function unwrap<T>(r: JobStoreResult<T>): T { if (!r.ok) reject(r.code); return r.value; }
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (e) { return { ok: false, code: e instanceof Rejection ? e.code : 'unavailable' }; }
}

/** Shared Drizzle boundary, caller-owned connection and authority critical section.
 * A native Handrail adapter implements the port over native task ownership. */
export function createJobLeaseStore(db: ReferenceDatabase, tables = journalTables()): JobLeaseStore {
  const { jobs } = tables;
  function use(input: JobLeaseFence, context: JobLeaseContext, operation: 'renew' | 'release' | 'check', ttlMs = 0) {
    return safe(async () => {
      const access = copyAppendFence({ ...context, fence: input });
      return db.transaction(async tx => {
        const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, access.fence.identity.jobId)).for('update');
        if (!head || !matchesJobFence(head, access)) reject('lease_lost');
        if (operation === 'check') {
          const snapshot = unwrap(await createJobJournal(tx, tables).load(head.identity, false));
          if (!['queued', 'running'].includes(snapshot.state)) reject('lease_lost');
        }
        if (operation === 'renew') {
          // Never shorten a live lease. Expired claims already failed above.
          const expiresAt = Math.max(head.leaseExpiresAt!, leaseExpiry(leaseNow(access), ttlMs));
          if (!matchesJobFence(head, access)) reject('lease_lost');
          await tx.update(jobs).set({ leaseExpiresAt: expiresAt }).where(eq(jobs.jobId, head.jobId));
          if (!matchesJobFence(head, access)) reject('lease_lost');
          return { ...fenceFromHead(head), expiresAt };
        }
        if (operation === 'release') await tx.update(jobs).set(releasedLease).where(eq(jobs.jobId, head.jobId));
        if (!matchesJobFence(head, access)) reject('lease_lost');
        return fenceFromHead(head);
      });
    });
  }
  return {
    claim(input, ownerToken, ttlMs, context) {
      return safe(async () => {
        const identity = JSON.parse(JSON.stringify(input)) as typeof input;
        if (!validLeaseAuthority(context.authority, identity)) reject('not_authorized');
        const access = { authority: JSON.parse(JSON.stringify(context.authority)), now: context.now };
        return db.transaction(async tx => {
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, identity.jobId)).for('update');
          if (!head || !sameLeaseValue(head.identity, identity)) reject('not_authorized');
          // Fully validate history without repairing checkpoints on a losing claim.
          const snapshot = unwrap(await createJobJournal(tx, tables).load(identity, false));
          if (!['queued', 'running'].includes(snapshot.state)) return null;
          if (head.cancellationEpoch > access.authority.cancellationRevision) reject('lease_lost');
          const now = leaseNow(access);
          if (head.leaseOwner !== null && head.leaseExpiresAt! > now) return null;
          if (head.leaseEpoch >= Number.MAX_SAFE_INTEGER) reject('lease_lost');
          const values = { leaseOwner: ownerToken, leaseEpoch: head.leaseEpoch + 1,
            leaseExpiresAt: leaseExpiry(now, ttlMs), leaseGrantRevision: access.authority.grantRevision,
            leaseCancellationRevision: access.authority.cancellationRevision };
          await tx.update(jobs).set(values).where(eq(jobs.jobId, head.jobId));
          const claimed = { ...head, ...values };
          if (!matchesJobFence(claimed, { ...access, fence: fenceFromHead(claimed) })) reject('lease_lost');
          return fenceFromHead(claimed);
        });
      });
    },
    renew: (fence, ttlMs, context) => use(fence, context, 'renew', ttlMs),
    async release(fence, context) {
      const result = await use(fence, context, 'release');
      return result.ok ? { ok: true, value: undefined } : result;
    },
    check: (fence, context) => use(fence, context, 'check'),
    append(input, context, complete, effectAdmission = false) {
      return safe(async () => {
        const access = copyAppendFence(context);
        // The journal detaches/validates the event synchronously before SQL.
        // Its savepoint cannot release our outer transaction's row lock.
        if (effectAdmission) {
          if (input.kind !== 'effects_recorded') reject('invalid_payload');
          return db.transaction(async tx => {
            const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, access.fence.identity.jobId)).for('update');
            if (!head || !matchesJobFence(head, access)) reject('lease_lost');
            const current = unwrap(await createJobJournal(tx, tables).load(head.identity, false));
            if (input.snapshot.revision > current.revision) {
              const added = input.snapshot.effects.filter(item => !current.effects.some(old => old.effectRef === item.effectRef));
              if (current.state !== 'running' || added.length !== 1 || added[0].outcome !== 'unknown'
                || input.snapshot.effects.length !== current.effects.length + 1) reject('effect_conflict');
            }
            return unwrap(await createJobJournal(tx, tables).append(input, access));
          });
        }
        if (!complete) return unwrap(await createJobJournal(db, tables).append(input, access));
        if (!['succeeded', 'failed', 'cancelled'].includes(input.kind)) reject('invalid_payload');
        // Detach before the first await; the journal revalidates inside the transaction.
        if (!validateJobEvent(input).ok) reject('invalid_payload');
        const event = JSON.parse(JSON.stringify(input)) as typeof input;
        return db.transaction(async tx => {
          const result = unwrap(await createJobJournal(tx, tables).append(event, access));
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, access.fence.identity.jobId)).for('update');
          if (!head || !matchesJobFence(head, access)) reject('lease_lost');
          await tx.update(jobs).set(releasedLease).where(eq(jobs.jobId, head.jobId));
          if (!matchesJobFence(head, access)) reject('lease_lost');
          return result;
        });
      });
    },
  };
}
