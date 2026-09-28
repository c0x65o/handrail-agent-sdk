import { and, eq } from 'drizzle-orm';
import { sameLeaseValue } from '../../src/server/job-lease.js';
import { safeEffectObservation, validEffectRequest } from '../../src/server/effects.js';
import type { EffectObservation, EffectRequest, EffectStore } from '../../src/server/effects.js';
import type { JobAppendFence } from '../../src/server/job-lease.js';
import type { JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';
import { copyAppendFence, matchesJobFence } from './job-lease-fence.js';

class Rejection extends Error { constructor(readonly code: JobStoreErrorCode) { super(code); } }
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function unwrap<T>(r: JobStoreResult<T>): T { if (!r.ok) reject(r.code); return r.value; }
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (e) { return { ok: false, code: e instanceof Rejection ? e.code : 'unavailable' }; }
}
function request(input: EffectRequest): EffectRequest {
  if (!validEffectRequest(input)) reject('invalid_payload');
  return JSON.parse(JSON.stringify(input));
}

/** Reference only: native hosts inject their task/action/provider recovery service.
 * The committed unknown record survives rollback of a dispatch transaction. A
 * provider success receipt is immutable. No raw request/response/error is stored. */
export function createEffectStore(db: ReferenceDatabase, tables = journalTables()): EffectStore {
  const { jobs, effects } = tables;
  type Tx = Parameters<Parameters<ReferenceDatabase['transaction']>[0]>[0];
  const key = (r: EffectRequest) => and(eq(effects.jobId, r.identity.jobId), eq(effects.effectRef, r.effectRef));
  async function lock(tx: Tx, r: EffectRequest, access?: JobAppendFence) {
    const [head] = await tx.select().from(jobs).where(eq(jobs.jobId, r.identity.jobId)).for('update');
    if (!head || !sameLeaseValue(head.identity, r.identity)) reject('identity_mismatch');
    if (access && !matchesJobFence(head, access)) reject('lease_lost');
    const snapshot = unwrap(await createJobJournal(tx, tables).load(r.identity, false));
    if (access && snapshot.state !== 'running') reject('lease_lost');
    return { head, snapshot };
  }
  async function existing(tx: Tx, r: EffectRequest) {
    const [row] = await tx.select().from(effects).where(key(r));
    if (!row) reject('not_found');
    if (!sameLeaseValue(row.request, r)) reject('effect_conflict');
    return row;
  }
  async function persist(tx: Tx, r: EffectRequest, observation: EffectObservation) {
    // not_applied is a point-in-time proof, never a durable dispatch permission.
    // The next execute MUST read again while serialized against all dispatches.
    if (observation.outcome === 'verified') await tx.update(effects).set({ observation }).where(key(r));
  }
  async function resolveJournal(tx: Tx, r: EffectRequest, access: JobAppendFence) {
    const row = await existing(tx, r);
    if (row.observation.outcome !== 'verified' || row.resolvedRevision !== null) return;
    const current = unwrap(await createJobJournal(tx, tables).load(r.identity, false));
    const original = current.effects.find(e => e.effectRef === r.effectRef);
    if (!original || original.outcome !== 'unknown') reject('effect_conflict');
    const revision = current.revision + 1;
    await tx.update(effects).set({ resolvedRevision: revision }).where(key(r));
    unwrap(await createJobJournal(tx, tables).appendEffectResolution({ kind: 'effects_recorded',
      previousRevision: current.revision, snapshot: { identity: r.identity, state: 'running', revision,
        effects: current.effects.map(e => e.effectRef === r.effectRef ? { ...e, outcome: 'verified' } : e) } }, access));
  }
  return {
    admit(input, inputAccess) {
      return safe(async () => {
        const r = request(input), access = copyAppendFence(inputAccess);
        return db.transaction(async tx => {
          const { head, snapshot } = await lock(tx, r, access);
          const [old] = await tx.select().from(effects).where(key(r));
          if (old) {
            if (!sameLeaseValue(old.request, r)) reject('effect_conflict');
            await tx.update(effects).set({ authority: access.fence }).where(key(r));
            if (!matchesJobFence(head, access)) reject('lease_lost');
            return { admitted: false };
          }
          // Do not adopt an unknown effect lacking the durable request binding.
          if (snapshot.effects.some(e => e.effectRef === r.effectRef)) reject('effect_conflict');
          const inserted = await tx.insert(effects).values({ jobId: r.identity.jobId, effectRef: r.effectRef,
            providerRef: r.providerRef, idempotencyRef: r.idempotencyRef, request: r,
            admissionAuthority: access.fence, authority: access.fence, observation: { outcome: 'unknown' } }).onConflictDoNothing().returning();
          if (!inserted.length) reject('effect_conflict');
          unwrap(await createJobJournal(tx, tables).append({ kind: 'effects_recorded', previousRevision: snapshot.revision,
            snapshot: { identity: r.identity, state: 'running', revision: snapshot.revision + 1,
              effects: [...snapshot.effects, { effectRef: r.effectRef, actionRef: r.actionRef,
                operationRef: r.operationRef, outcome: 'unknown' }] } }, access));
          if (!matchesJobFence(head, access)) reject('lease_lost');
          return { admitted: true };
        });
      });
    },
    dispatch(input, inputAccess, read, run) {
      return safe(async () => {
        const r = request(input), access = copyAppendFence(inputAccess);
        return db.transaction(async tx => {
          const { head } = await lock(tx, r, access);
          const row = await existing(tx, r);
          let observation = row.observation;
          if (observation.outcome !== 'verified') {
            observation = safeEffectObservation(await read());
            await tx.update(effects).set({ reconciliation: observation }).where(key(r));
            if (!matchesJobFence(head, access)) reject('lease_lost');
            if (observation.outcome === 'not_applied') {
              // Record the current execution authority; rollback retains the
              // original admission epoch and unknown result after a crash.
              await tx.update(effects).set({ authority: access.fence }).where(key(r));
              if (!matchesJobFence(head, access)) reject('lease_lost');
              observation = safeEffectObservation(await run());
              // A dispatch's not_applied output does not substitute for read/reconcile.
              if (observation.outcome !== 'verified') observation = { outcome: 'unknown' };
            }
            await persist(tx, r, observation);
          }
          // Lease expiry after provider IO rolls back to the committed unknown.
          if (!matchesJobFence(head, access)) reject('lease_lost');
          if (observation.outcome === 'verified') await resolveJournal(tx, r, access);
          return observation;
        });
      });
    },
    reconcile(input, read) {
      return safe(async () => {
        const r = request(input);
        return db.transaction(async tx => {
          await lock(tx, r); // No live lease required; facts may outlive Stop.
          const row = await existing(tx, r);
          if (row.observation.outcome === 'verified') return row.observation;
          const observation = safeEffectObservation(await read());
          await tx.update(effects).set({ reconciliation: observation }).where(key(r));
          await persist(tx, r, observation);
          return observation;
        });
      });
    },
  };
}
