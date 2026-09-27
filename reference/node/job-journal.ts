import { copyAppendFence, matchesJobFence } from './job-lease-fence.js';
import { and, asc, eq } from 'drizzle-orm';
import { validateJobCommand, validateJobEvent, validateJobSnapshot, validateJobTransition } from '../../src/contracts/job.js';
import type { JobEvent, JobIdentity, JobSnapshot } from '../../src/contracts/job.js';
import type { JobStore, JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';

const checkpointVersion = 1;
class Rejection extends Error {
  constructor(readonly code: JobStoreErrorCode) { super(code); }
}
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(k => Object.hasOwn(right, k) && same(left[k], right[k]));
}
/** Only called after exact shape validation. Copy before the first await so a
 * caller cannot mutate the queued write. Revalidate the detached JSON as well. */
function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
function identityInput(value: JobIdentity): JobIdentity {
  if (!validateJobCommand({ command: 'inspect', identity: value }).ok) reject('invalid_payload');
  const copy = detached(value);
  if (!validateJobCommand({ command: 'inspect', identity: copy }).ok) reject('invalid_payload');
  return copy;
}

/** Reference-host persistence, not admission or execution authority. All reads
 * and writes use the injected shared Drizzle boundary. No connection is opened. */
export function createJobJournal(db: ReferenceDatabase, tables = journalTables()): JobStore & { load(identity: JobIdentity, repair?: boolean): Promise<JobStoreResult<JobSnapshot>> } {
  const { jobs, events, deliveries, checkpoints } = tables;
  type Transaction = Parameters<Parameters<ReferenceDatabase['transaction']>[0]>[0];
  type Head = typeof jobs.$inferSelect;

  async function history(tx: Transaction, head: Head) {
    const rows = await tx.select().from(events).where(eq(events.jobId, head.jobId)).orderBy(asc(events.revision));
    let current: JobSnapshot | null = null;
    for (const row of rows) {
      if (!validateJobEvent(row.event).ok || 'delivery' in row.event
        || row.revision !== row.event.snapshot.revision
        || row.jobId !== row.event.snapshot.identity.jobId
        || !same(head.identity, row.event.snapshot.identity)
        || !validateJobTransition(current, row.event).ok) reject('invalid_history');
      current = row.event.snapshot;
    }
    if ((current?.revision ?? 0) !== head.revision) reject('invalid_history');
    const [checkpoint] = await tx.select().from(checkpoints).where(eq(checkpoints.jobId, head.jobId));
    if (checkpoint && (checkpoint.version !== checkpointVersion
      || !validateJobSnapshot(checkpoint.snapshot).ok
      || checkpoint.revision > head.revision
      || !same(checkpoint.snapshot, rows.find(row => row.revision === checkpoint.revision)?.event.snapshot))) {
      reject('invalid_checkpoint');
    }
    return { current, rows, checkpoint };
  }
  async function saveCheckpoint(tx: Transaction, snapshot: JobSnapshot) {
    const values = { jobId: snapshot.identity.jobId, version: checkpointVersion, revision: snapshot.revision, snapshot };
    await tx.insert(checkpoints).values(values).onConflictDoUpdate({ target: checkpoints.jobId, set: values });
  }
  async function saveDelivery(tx: Transaction, event: JobEvent) {
    if (!event.delivery) return;
    const values = { jobId: event.snapshot.identity.jobId, revision: event.snapshot.revision,
      attemptRef: event.delivery.attemptRef, delivery: event.delivery };
    const [old] = await tx.select().from(deliveries).where(and(eq(deliveries.jobId, values.jobId),
      eq(deliveries.revision, values.revision), eq(deliveries.attemptRef, values.attemptRef)));
    if (old) {
      if (!same(old.delivery, values.delivery)) reject('conflict');
    } else await tx.insert(deliveries).values(values);
  }
  return {
    append(input, inputFence) {
      return safe(async () => {
        if (!validateJobEvent(input).ok) reject('invalid_payload');
        const event = detached(input);
        if (!validateJobEvent(event).ok) reject('invalid_payload');
        const access = inputFence ? copyAppendFence(inputFence) : undefined;
        const { delivery: _delivery, ...canonical } = event;
        const { identity, revision } = canonical.snapshot;
        return db.transaction(async tx => {
          if (event.kind === 'submitted') {
            await tx.insert(jobs).values({ jobId: identity.jobId, identity, revision: 0 }).onConflictDoNothing();
          }
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, identity.jobId)).for('update');
          if (!head) reject('not_found');
          if (!same(head.identity, identity)) reject('identity_mismatch');
          const { current, rows } = await history(tx, head);
          const checkFence = () => {
            if (event.kind !== 'submitted' && (!access || !matchesJobFence(head, access))) reject('lease_lost');
          };
          checkFence();
          const original = rows.find(row => row.revision === revision)?.event;
          if (original) {
            if (!same(original, canonical)) reject('conflict');
            await saveDelivery(tx, event);
            checkFence();
            return { event: original, replayed: true };
          }
          if (event.previousRevision !== head.revision) reject('invalid_revision');
          const transition = validateJobTransition(current, canonical);
          if (!transition.ok) reject(transition.code);
          await tx.insert(events).values({ jobId: identity.jobId, revision, event: canonical });
          const updated = await tx.update(jobs).set({ revision }).where(and(eq(jobs.jobId, identity.jobId),
            eq(jobs.revision, event.previousRevision))).returning({ revision: jobs.revision });
          if (updated.length !== 1) reject('conflict');
          await saveDelivery(tx, event);
          await saveCheckpoint(tx, canonical.snapshot);
          checkFence();
          return { event: canonical, replayed: false };
        });
      });
    },
    load(input, repair = true) {
      return safe(async () => {
        const identity = identityInput(input);
        return db.transaction(async tx => {
          const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, identity.jobId)).for('update');
          if (!head) reject('not_found');
          if (!same(head.identity, identity)) reject('identity_mismatch');
          const { current, checkpoint } = await history(tx, head);
          if (!current) reject('invalid_history');
          if (repair && (!checkpoint || checkpoint.revision < current.revision)) await saveCheckpoint(tx, current);
          return current;
        });
      });
    },
  };
}
