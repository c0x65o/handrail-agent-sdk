import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { VaultEntryBinding, VaultEntryHandle, VaultEntryStore } from '../../src/server/vault-entry.js';
import type { JobLeaseAuthority } from '../../src/server/job-lease.js';
import { sameLeaseValue } from '../../src/server/job-lease.js';
import type { JobStoreErrorCode, JobStoreResult } from '../../src/server/job-store.js';
import { validateVaultEntryCompletion } from '../../src/contracts/vault.js';
import type { VaultEntryCompletion } from '../../src/contracts/vault.js';
import { createJobAnswer } from '../../src/server/answer.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables, vaultTables, vaultEntryTables } from './db/schema.js';
import { createJobJournal } from './job-journal.js';
import { createJobAnswerStore } from './job-answer.js';
import { createVaultStore } from './vault-store.js';
import type { VaultKeyService, VaultStorageHost, VaultValue } from './vault-store.js';
import { createVaultGrants } from './vault-grants.js';
import type { VaultGrantOwnerHost } from './vault-grants.js';

class Rejection extends Error { constructor(readonly code: JobStoreErrorCode) { super(code); } }
function reject(code: JobStoreErrorCode): never { throw new Rejection(code); }
function unwrap<T>(r: JobStoreResult<T>): T { if (!r.ok) reject(r.code); return r.value; }
async function safe<T>(run: () => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
  try { return await run(); } catch (e) { return { ok: false, code: e instanceof Rejection ? e.code : 'unavailable' }; }
}
const ok = <T>(value: T): JobStoreResult<T> => ({ ok: true, value });
const denied = (): JobStoreResult<never> => ({ ok: false, code: 'not_authorized' });
const clock = (now: () => number) => { const n = now(); if (!Number.isSafeInteger(n) || n < 0) reject('unavailable'); return n; };

/** Transactional reference implementation. Lock order job -> session -> lifecycle
 * -> item grant. Native hosts implement the same port over their native services.
 * The outer authenticated host callback and item-owner callbacks must hold native
 * authority stable until the surrounding transaction commits. */
export function createVaultEntryStore(db: ReferenceDatabase, storage: VaultStorageHost,
  owner: VaultGrantOwnerHost, keys: VaultKeyService, namespace?: string): VaultEntryStore<VaultValue> {
  const jt = journalTables(namespace), vt = vaultTables(namespace), { sessions } = vaultEntryTables(namespace);
  type Row = typeof sessions.$inferSelect;
  const answer = (tx: ReferenceDatabase, a: JobLeaseAuthority, now: () => number) => createJobAnswer({ now,
    withAnswerAuthority: async (_identity, _resolver, _phase, run) => run(a) }, createJobAnswerStore(tx, jt));
  const grants = (tx: ReferenceDatabase, now: () => number) => createVaultGrants(tx,
    { withOwner: owner.withOwner.bind(owner), now }, keys, namespace).administration;
  async function head(tx: ReferenceDatabase, b: VaultEntryBinding, a: JobLeaseAuthority) {
    const [job] = await tx.select().from(jt.jobs).where(eq(jt.jobs.jobId, b.request.identity.jobId)).for('update');
    if (!job || !sameLeaseValue(job.identity, b.request.identity) || !sameLeaseValue(a.host, job.identity.host)
      || job.cancellationEpoch > a.cancellationRevision) reject('not_authorized');
  }
  async function locked<T>(h: VaultEntryHandle, b: VaultEntryBinding, a: JobLeaseAuthority, now: () => number,
    run: (tx: ReferenceDatabase, row: Row) => Promise<JobStoreResult<T>>, expiry = true): Promise<JobStoreResult<T>> {
    return safe(() => db.transaction(async tx => {
      await head(tx, b, a);
      const [row] = await tx.select().from(sessions).where(eq(sessions.sessionRef, h.sessionRef)).for('update');
      if (!row || row.revision !== h.revision || !sameLeaseValue(row.binding, b)
        || !sameLeaseValue(row.authority, a) || ['withdrawn', 'expired'].includes(row.state)) return denied();
      if (expiry && clock(now) >= b.request.expiresAt) {
        await tx.update(sessions).set({ state: 'expired', revision: row.revision + 1 }).where(eq(sessions.sessionRef, h.sessionRef));
        return denied();
      }
      return run(tx, row);
    }));
  }
  async function current(tx: ReferenceDatabase, b: VaultEntryBinding, a: JobLeaseAuthority, now: () => number,
    row?: Row) {
    const r = b.request, n = clock(now);
    const [challenge] = await tx.select().from(jt.challenges).where(eq(jt.challenges.jobId, r.identity.jobId));
    if (!challenge || challenge.jobRevision !== r.jobRevision || challenge.requirementRef !== r.requirement.requirementRef
      || challenge.requirementRevision !== r.requirement.revision || challenge.resolverRef !== r.requirement.actor.actorRef
      || challenge.grantRevision !== a.grantRevision || challenge.cancellationRevision !== a.cancellationRevision
      || n >= challenge.expiresAt || (challenge.consumed !== 0 && row?.state !== 'delivered')) reject('requirement_mismatch');
    const job = unwrap(await createJobJournal(tx, jt).load(r.identity, false));
    const completion: VaultEntryCompletion = row?.completion ?? { request: r, source: b.source, item: b.grant.request.item,
      answer: { requirementRef: r.requirement.requirementRef, requirementRevision: r.requirement.revision,
        responseRef: row!.sessionRef } };
    // Only our durably delivered answer may be replayed, and never a later wait.
    if (row?.state === 'delivered' && (job.state !== 'waiting' || job.revision !== row.receipt?.eventCursor
      || !sameLeaseValue(job.answer, completion.answer))) reject('requirement_mismatch');
    const check = validateVaultEntryCompletion(completion, { currentJob: job, item: completion.item,
      authenticated: true, authenticatedActor: r.requirement.actor, authorized: true, itemAuthorized: true,
      itemState: 'active', itemExpiresAt: b.grant.itemExpiresAt, taskExpiresAt: b.grant.taskExpiresAt,
      maxLifetimeMs: 900_000, request: r, state: 'active', responseRef: completion.answer.responseRef,
      source: b.source, ...(row?.state === 'delivered' ? { previous: completion } : {}) }, n);
    if (!check.ok) reject('not_authorized');
    if (n >= b.grant.expiresAt || r.expiresAt > b.grant.expiresAt) reject('not_authorized');
    return completion;
  }
  return {
    lookup: h => safe(async () => {
      const [row] = await db.select().from(sessions).where(eq(sessions.sessionRef, h.sessionRef));
      return row && row.revision === h.revision ? ok(row.binding) : denied();
    }),
    issue: (b, a, now) => safe(() => db.transaction(async tx => {
      await head(tx, b, a);
      const [prior] = await tx.select().from(sessions).where(and(eq(sessions.jobId, b.request.identity.jobId), eq(sessions.jobRevision, b.request.jobRevision)));
      if (prior) {
        if (!sameLeaseValue(prior.binding, b) || !sameLeaseValue(prior.authority, a)) reject('conflict');
        if (prior.state !== 'open') reject('not_authorized');
        await current(tx, b, a, now, prior);
        return ok({ sessionRef: prior.sessionRef, revision: prior.revision });
      }
      const r = b.request;
      unwrap(await answer(tx, a, now).issue({ identity: r.identity, requirement: r.requirement,
        jobRevision: r.jobRevision, expiresAt: r.expiresAt, resolverRef: r.requirement.actor.actorRef }));
      const row: Row = { sessionRef: randomBytes(32).toString('hex'), jobId: r.identity.jobId,
        jobRevision: r.jobRevision, revision: 1, state: 'open', binding: b, authority: a, completion: null, receipt: null };
      await current(tx, b, a, now, row);
      await tx.insert(sessions).values(row);
      return ok({ sessionRef: row.sessionRef, revision: row.revision });
    })),
    capture: (h, b, a, now, privateValue) => locked(h, b, a, now, async (tx, row) => {
      const completion = await current(tx, b, a, now, row), custody = createVaultStore(tx, storage, keys, vt), grant = grants(tx, now);
      const payment = completion.item.metadata.kind === 'payment_method';
      if (payment && row.completion) reject('not_authorized');
      if (b.source === 'existing_item' && privateValue !== undefined) reject('invalid_payload');
      if (row.completion) {
        unwrap(await grant.check(b.grant));
        if (b.source === 'new_input' && privateValue !== undefined) {
          const saved = unwrap(await custody.readForExecutor(completion.item));
          if (!sameLeaseValue(saved, privateValue)) reject('conflict');
        }
        await current(tx, b, a, now, row);
        return ok(row.completion);
      }
      if (b.source === 'new_input') {
        if (privateValue === undefined) reject('invalid_payload');
        unwrap(await custody.create(completion.item, privateValue));
      }
      // Uses the existing item-owner policy and CAS port, never a parallel ACL.
      unwrap(await grant.put(b.grant, b.grant.request.grantRevision - 1));
      unwrap(await grant.check(b.grant));
      await current(tx, b, a, now, row); // after custody/key/owner awaits, rollback all on expiry
      await tx.update(sessions).set({ completion, state: 'captured' }).where(eq(sessions.sessionRef, h.sessionRef));
      if (clock(now) >= b.request.expiresAt) reject('not_authorized');
      return ok(completion);
    }),
    deliver: (h, b, a, now) => locked(h, b, a, now, async (tx, row) => {
      if (!row.completion) reject('invalid_transition');
      await current(tx, b, a, now, row);
      unwrap(await grants(tx, now).check(b.grant));
      await current(tx, b, a, now, row);
      const c = row.completion;
      const receipt = unwrap(await answer(tx, a, now).complete({ identity: b.request.identity,
        ...c.answer, resolverRef: b.request.requirement.actor.actorRef, deliveryKey: row.sessionRef, status: 'verified' }));
      await current(tx, b, a, now, { ...row, state: 'delivered', receipt });
      await tx.update(sessions).set({ state: 'delivered', receipt }).where(eq(sessions.sessionRef, h.sessionRef));
      if (clock(now) >= b.request.expiresAt) reject('not_authorized');
      return ok(receipt);
    }),
    close: (h, b, a, now, reason) => locked(h, b, a, now, async (tx, row) => {
      if (row.state === 'delivered' || (reason === 'expire' && clock(now) < b.request.expiresAt)) reject('invalid_transition');
      await tx.update(sessions).set({ state: reason === 'expire' ? 'expired' : 'withdrawn', revision: row.revision + 1 })
        .where(eq(sessions.sessionRef, h.sessionRef));
      return ok(undefined);
    }, false),
  };
}
