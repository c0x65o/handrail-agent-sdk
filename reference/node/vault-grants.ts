import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { VaultItem, VaultOperation } from '../../src/contracts/vault.js';
import { validateVaultOperation, validateVaultOperationSchema } from '../../src/contracts/vault.js';
import type { VaultUseContext } from '../../src/server/vault-policy.js';
import type { VaultAccessFact, VaultItemGrant, VaultItemGrantPort, VaultUsePort } from '../../src/server/vault-use.js';
import type { EffectRequest } from '../../src/server/effects.js';
import type { JobStoreResult } from '../../src/server/job-store.js';
import { sameLeaseValue } from '../../src/server/job-lease.js';
import type { ReferenceDatabase } from './db/database.js';
import { journalTables, vaultTables, vaultGrantTables } from './db/schema.js';
import { createEffectStore } from './effects.js';
import { createJobJournal } from './job-journal.js';
import { matchesJobFence } from './job-lease-fence.js';
import { createVaultStore } from './vault-store.js';
import type { VaultKeyService, VaultScope, VaultValue } from './vault-store.js';
import { canonical, inputItem, itemId, validScope } from './vault-private.js';

export interface VaultGrantOwnerHost {
  /** Trusted authenticated owner/item ACL, not organization membership. Keep
   * native authority stable through callback AND commit. Shared recipients may
   * use an explicit grant, but cannot administer grants or inspect owner history. */
  withOwner<T>(item: VaultItem, action: 'grant' | 'revoke' | 'history',
    run: (scope: VaultScope) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  now(): number;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const denied = (): { readonly ok: false; readonly code: 'not_authorized' } => ({ ok: false, code: 'not_authorized' });
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const revision = (v: number) => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
async function safe<T>(run: () => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
  try { return await run(); } catch { return { ok: false, code: 'unavailable' }; }
}
function sameScope(owner: VaultScope, recipient: VaultScope) {
  return validScope(owner) && validScope(recipient)
    && (Object.keys(owner) as (keyof VaultScope)[]).every(k => k === 'userRef' || owner[k] === recipient[k]);
}
/** Digest only public metadata/approved aliases. Never hash credential values. */
export function vaultEffectRequest(request: VaultOperation, providerRef: string): EffectRequest {
  return { identity: request.identity, ...request.effect, providerRef,
    idempotencyRef: request.effect.effectRef,
    requestDigest: `sha256:${createHash('sha256').update(canonical(request)).digest('hex')}` };
}

/** Reference host only. Lock order: job -> lifecycle -> grant. Native Handrail
 * implements these ports using its existing authority, custody and effect services. */
export function createVaultGrants(db: ReferenceDatabase, owner: VaultGrantOwnerHost, keys: VaultKeyService,
  namespace?: string): { administration: VaultItemGrantPort; use: VaultUsePort<VaultValue> } {
  const vt = vaultTables(namespace), jt = journalTables(namespace), gt = vaultGrantTables(namespace);
  const effectStore = createEffectStore(db, jt);
  type Tx = Parameters<Parameters<ReferenceDatabase['transaction']>[0]>[0];
  const now = () => {
    const n = owner.now();
    if (!Number.isSafeInteger(n) || n < 0) throw Error();
    return n;
  };
  async function record(tx: ReferenceDatabase, id: string, phase: VaultAccessFact['phase'], outcome: VaultAccessFact['outcome']) {
    await tx.insert(gt.access).values({ itemId: id, receiptRef: randomUUID(), at: now(), phase, outcome });
  }
  async function owned<T>(item: VaultItem, action: 'grant' | 'revoke' | 'history',
    run: (tx: Tx, state: typeof vt.states.$inferSelect) => Promise<JobStoreResult<T>>) {
    return owner.withOwner(copy(item), action, scope => db.transaction(async tx => {
      if (!validScope(scope)) return denied();
      const [state] = await tx.select().from(vt.states).where(eq(vt.states.itemId, itemId(item))).for('update');
      if (!state || !sameLeaseValue(state.scope, scope) || state.revision !== item.reference.revision) return denied();
      if (action === 'grant') {
        const [itemRow] = await tx.select().from(vt.items).where(eq(vt.items.itemId, itemId(item)));
        if (!itemRow || !sameLeaseValue(itemRow.item, item) || !sameLeaseValue(itemRow.scope, scope)
          || itemRow.nonce !== state.activeNonce) return denied();
      }
      return run(tx, state);
    }));
  }
  const administration: VaultItemGrantPort = {
    check(input) {
      return safe(async () => {
        if (!validateVaultOperationSchema(input?.request).ok) return { ok: false, code: 'invalid_payload' };
        const grant = copy(input), item = inputItem(grant.request.item);
        return owned(item, 'grant', async (tx, state) => {
          const [row] = await tx.select().from(gt.grants).where(eq(gt.grants.grantRef, grant.request.grantRef)).for('update');
          if (state.status !== 'active' || !sameScope(state.scope, grant.request.identity.host)
            || !row || row.itemId !== itemId(item) || row.revision !== grant.request.grantRevision
            || !sameLeaseValue(row.grant, grant) || grant.state !== 'active' || !grant.permissions.use
            || now() < grant.issuedAt || now() >= Math.min(grant.expiresAt, grant.itemExpiresAt, grant.taskExpiresAt)) return denied();
          return { ok: true, value: undefined };
        });
      });
    },
    put(input, expectedRevision) {
      return safe(async () => {
        if (!revision(expectedRevision) || !validateVaultOperationSchema(input?.request).ok)
          return { ok: false, code: 'invalid_payload' };
        const grant = copy(input), request = grant.request, item = inputItem(request.item);
        if (grant.state !== 'active' || request.grantRevision !== expectedRevision + 1)
          return { ok: false, code: 'invalid_payload' };
        return owned(item, 'grant', async (tx, state) => {
          if (state.status !== 'active' || !sameScope(state.scope, request.identity.host)) return denied();
          // Existing contract enforces bounded lifetime, use permission, destination,
          // action, actor, metadata and exact grant shape (including no reveal API).
          const { itemExpiresAt, taskExpiresAt, ...useGrant } = grant;
          const context: VaultUseContext = { grant: useGrant, item,
            currentJob: { identity: request.identity, state: 'running', revision: request.jobRevision, effects: [] },
            authenticated: true, authenticatedActor: { kind: 'user', actorRef: request.identity.host.userRef },
            authorized: true, itemAuthorized: true, itemState: state.status,
            itemExpiresAt, taskExpiresAt, maxLifetimeMs: 300_000 };
          if (!validateVaultOperation(request, context, now()).ok) return { ok: false, code: 'invalid_payload' };
          const [row] = await tx.select().from(gt.grants).where(eq(gt.grants.grantRef, request.grantRef)).for('update');
          if ((row?.revision ?? 0) !== expectedRevision || (row && row.itemId !== itemId(item)))
            return { ok: false, code: 'conflict' };
          if (row) await tx.update(gt.grants).set({ revision: request.grantRevision, grant }).where(eq(gt.grants.grantRef, request.grantRef));
          else {
            const added = await tx.insert(gt.grants).values({ grantRef: request.grantRef, itemId: itemId(item),
              revision: request.grantRevision, grant }).onConflictDoNothing().returning();
            if (!added.length) return { ok: false, code: 'conflict' };
          }
          return { ok: true, value: { revision: request.grantRevision } };
        });
      });
    },
    revoke(input, grantRef, expectedRevision) {
      return safe(async () => {
        const item = inputItem(input);
        if (!ref(grantRef) || !revision(expectedRevision) || !expectedRevision) return { ok: false, code: 'invalid_payload' };
        return owned(item, 'revoke', async tx => {
          const [row] = await tx.select().from(gt.grants).where(eq(gt.grants.grantRef, grantRef)).for('update');
          if (!row || row.itemId !== itemId(item)) return denied();
          if (row.revision !== expectedRevision) return { ok: false, code: 'conflict' };
          const next = expectedRevision + 1;
          await tx.update(gt.grants).set({ revision: next,
            grant: { ...row.grant, state: 'revoked', request: { ...row.grant.request, grantRevision: next } } })
            .where(eq(gt.grants.grantRef, grantRef));
          return { ok: true, value: { revision: next } };
        });
      });
    },
    history(input, limit = 50) {
      return safe(async () => {
        const item = inputItem(input);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, code: 'invalid_payload' };
        return owned(item, 'history', async tx => ({ ok: true, value: await tx.select({ receiptRef: gt.access.receiptRef,
          at: gt.access.at, phase: gt.access.phase, outcome: gt.access.outcome }).from(gt.access)
          .where(eq(gt.access.itemId, itemId(item))).orderBy(desc(gt.access.at), desc(gt.access.receiptRef)).limit(limit) }));
      });
    },
  };
  const use: VaultUsePort<VaultValue> = {
    effects: effectStore,
    auditDenial: request => safe(async () => {
      await record(db, itemId(inputItem(request.item)), 'admit', 'denied');
      return { ok: true, value: undefined };
    }),
    withUse(request, effect, phase, access, actorRef, run) {
      return safe(() => db.transaction(async tx => {
        const id = itemId(request.item);
        const fail = async (outcome: VaultAccessFact['outcome'] = 'denied') => {
          await record(tx, id, phase, outcome); return denied();
        };
        const [head] = await tx.select().from(jt.jobs).where(eq(jt.jobs.jobId, request.identity.jobId)).for('update');
        if (!head || !matchesJobFence(head, access) || actorRef !== request.identity.host.userRef) return fail();
        const [state] = await tx.select().from(vt.states).where(eq(vt.states.itemId, id)).for('update');
        const [row] = await tx.select().from(gt.grants).where(eq(gt.grants.grantRef, request.grantRef)).for('update');
        if (!state || !row || row.itemId !== id || !sameScope(state.scope, request.identity.host)
          || state.revision !== request.item.reference.revision) return fail();
        if (state.status !== 'active' || row.grant.state !== 'active') return fail('revoked');
        if (row.revision !== request.grantRevision) return fail('stale_grant');
        const snapshot = await createJobJournal(tx, jt).load(request.identity, false);
        if (!snapshot.ok) return fail();
        const [admitted] = await tx.select().from(jt.effects).where(and(eq(jt.effects.jobId, request.identity.jobId), eq(jt.effects.effectRef, request.effect.effectRef)));
        if (admitted && !sameLeaseValue(admitted.request, effect)) return fail();
        const { itemExpiresAt, taskExpiresAt, ...grant } = row.grant;
        const context = (): VaultUseContext => ({ grant, item: request.item,
          // Only a durable exact request binding permits admission/replay to
          // normalize its own journal changes. No arbitrary unknown is adopted.
          currentJob: admitted ? { ...snapshot.value, revision: request.jobRevision,
            effects: snapshot.value.effects.filter(e => e.effectRef !== request.effect.effectRef) } : snapshot.value,
          authenticated: true, authenticatedActor: { kind: 'user', actorRef }, authorized: true, itemAuthorized: true,
          itemState: state.status, itemExpiresAt, taskExpiresAt, maxLifetimeMs: 300_000 });
        if (access.now() >= grant.expiresAt || access.now() >= itemExpiresAt || access.now() >= taskExpiresAt) return fail('expired');
        if (!validateVaultOperation(request, context(), access.now()).ok) return fail();
        const custody = createVaultStore(tx, { authorize: async () => state.scope }, keys, vt);
        const result = await run({ effects: createEffectStore(tx, jt), context,
          readForExecutor: async () => {
            if (!matchesJobFence(head, access) || !validateVaultOperation(request, context(), access.now()).ok) return denied();
            const value = await custody.readForExecutor(request.item);
            if (!value.ok) return { ok: false, code: value.code };
            if (!matchesJobFence(head, access) || !validateVaultOperation(request, context(), access.now()).ok) return denied();
            return value;
          } });
        // Fixed facts only; no driver/adapter output, destination, actor or payload.
        const [after] = await tx.select().from(jt.effects).where(and(eq(jt.effects.jobId, request.identity.jobId), eq(jt.effects.effectRef, request.effect.effectRef)));
        await record(tx, id, phase, !result.ok ? 'denied' : phase === 'admit' ? 'authorized'
          : after?.observation.outcome === 'verified' ? 'verified' : 'unknown');
        return result;
      }));
    },
  };
  return { administration, use };
}
