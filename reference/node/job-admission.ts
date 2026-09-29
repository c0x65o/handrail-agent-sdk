import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { validateJobEvent } from '../../src/contracts/job.js';
import { decodeJobSubmission } from '../../src/server/submit.js';
import type { JobAdmissionStore, JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';

class Rejection extends Error {
  constructor(readonly code: JobStoreErrorCode) { super(code); }
}
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
function unwrap<T>(result: JobStoreResult<T>): T { if (!result.ok) reject(result.code); return result.value; }
/** Called only on validated detached decoded data. Array order remains meaningful. */
function canonical(value: any): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const ref = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** Persistence only; the core admission API supplies current host authority.
 * Shared Drizzle transactions and existing journal validation; no owned client. */
export function createJobAdmissionStore(db: ReferenceDatabase, tables = journalTables()): JobAdmissionStore {
  const { admissions, jobs, events } = tables;
  return {
    admit(input) {
      return safe(async () => {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const keys = ['namespaceRef', 'grantRevision', 'operation', 'event'];
        if (Reflect.ownKeys(input).length !== keys.length || !keys.every(k => descriptors[k]?.enumerable && 'value' in descriptors[k])) reject('invalid_payload');
        if (!ref(input.namespaceRef) || !Number.isSafeInteger(input.grantRevision) || input.grantRevision < 1
          || !validateJobEvent(input.event).ok || input.event.kind !== 'submitted' || 'delivery' in input.event) reject('invalid_payload');
        const event = JSON.parse(JSON.stringify(input.event)) as typeof input.event;
        if (!validateJobEvent(event).ok) reject('invalid_payload');
        const identity = event.snapshot.identity;
        const submission = decodeJobSubmission({ requestKey: identity.requestKey, originTaskRef: identity.originTaskRef,
          instructionRevision: identity.instructionRevision, operation: input.operation });
        if (!submission) reject('invalid_payload');
        const namespaceRef = input.namespaceRef, grantRevision = input.grantRevision;
        const { jobId: _candidate, ...binding } = identity;
        const digest = createHash('sha256').update(canonical({ version: 1, identity: binding,
          operation: submission.operation, grantRevision })).digest('hex');
        const namespace = { tenantRef: identity.host.tenantRef, userRef: identity.host.userRef, namespaceRef,
          requestKey: identity.requestKey };
        return db.transaction(async tx => {
          // Serializes only this reservation (hash collisions merely serialize more).
          // The durable PK remains the exact namespace tuple, never the lock hash.
          await tx.execute(sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${canonical(namespace)}, 0))`);
          const where = and(eq(admissions.tenantRef, namespace.tenantRef), eq(admissions.userRef, namespace.userRef),
            eq(admissions.namespaceRef, namespaceRef), eq(admissions.requestKey, identity.requestKey));
          const [old] = await tx.select().from(admissions).where(where);
          if (old) {
            if (old.digest !== digest) reject('conflict');
            const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, old.jobId));
            if (!head || canonical(head.identity) !== canonical({ ...binding, jobId: old.jobId })) reject('invalid_history');
            unwrap(await createJobJournal(tx, tables).load(head.identity));
            const [original] = await tx.select().from(events).where(and(eq(events.jobId, old.jobId), eq(events.revision, 1)));
            if (!original || original.event.kind !== 'submitted') reject('invalid_history');
            return { event: original.event, replayed: true };
          }
          // A candidate ID collision must not adopt an existing non-admission job.
          const [existing] = await tx.select().from(jobs).where(eq(jobs.jobId, identity.jobId));
          if (existing) reject('conflict');
          const result = unwrap(await createJobJournal(tx, tables).append(event));
          if (result.replayed) reject('conflict');
          await tx.insert(admissions).values({ ...namespace, digest, jobId: identity.jobId });
          return { event: result.event, replayed: false };
        });
      });
    },
    inspectAdmission(jobId, authority) {
      return safe(async () => {
        // Trusted authority is detached before SQL; exact scope comparison below
        // is an additional fence, not principal authentication.
        const scope = JSON.parse(JSON.stringify(authority)) as typeof authority;
        return db.transaction(async tx => {
          const [row] = await tx.select({ identity: jobs.identity }).from(admissions)
            .innerJoin(jobs, eq(admissions.jobId, jobs.jobId))
            .where(and(eq(admissions.jobId, jobId), eq(admissions.tenantRef, scope.host.tenantRef),
              eq(admissions.userRef, scope.host.userRef), eq(admissions.namespaceRef, scope.namespaceRef)));
          if (!row || canonical(row.identity.host) !== canonical(scope.host)) reject('not_authorized');
          return unwrap(await createJobJournal(tx, tables).load(row.identity));
        });
      });
    },
  };
}
