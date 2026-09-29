import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { validateConnectionEnsureInput, validateConnectionEnsureResult, validateConnectionReconnect } from '../../src/contracts/connection.js';
import type { ConnectionEnsureInput, ConnectionEnsureResult } from '../../src/contracts/connection.js';
import type { ConnectionCredentials, ConnectionSnapshot, ConnectionStore, ConnectionStoreCode, ConnectionStoreHost, ConnectionStoreResult, ConnectionVerificationBinding } from '../../src/server/connection-store.js';
import { sameLeaseValue as same } from '../../src/server/job-lease.js';
import type { ReferenceDatabase } from './db/database.js';
import { connectionTables, journalTables } from './db/schema.js';
import { copyAppendFence, matchesJobFence } from './job-lease-fence.js';

export type ConnectionMutation = { readonly operation: 'admit'; readonly expectedRevision: 0 }
  | { readonly operation: 'revoke'; readonly expectedRevision: number }
  | { readonly operation: 'rotate'; readonly expectedRevision: number; readonly credentials: ConnectionCredentials }
  | { readonly operation: 'reconnect'; readonly expectedRevision: number; readonly result: ConnectionEnsureResult;
      readonly verification: ConnectionVerificationBinding | null };
class Rejection extends Error { constructor(readonly code: ConnectionStoreCode) { super(code); } }
function reject(code: ConnectionStoreCode): never { throw new Rejection(code); }
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => natural(v) && v > 0;
const ref = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function exact(v: unknown, required: string[], optional: string[] = []): boolean {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return required.every(k => Object.hasOwn(v, k)) && Reflect.ownKeys(v).every(k => {
    if (typeof k !== 'string' || ![...required, ...optional].includes(k)) return false;
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    return d.enumerable && 'value' in d;
  });
}
function credentials(v: ConnectionCredentials): boolean {
  return exact(v, ['credentialRevision', 'credentialExpiresAt', 'grantRef', 'grantRevision', 'grantExpiresAt'], ['tokenRef', 'profileRef'])
    && positive(v.credentialRevision) && positive(v.grantRevision) && natural(v.credentialExpiresAt) && natural(v.grantExpiresAt)
    && ref(v.grantRef) && (v.tokenRef !== undefined || v.profileRef !== undefined)
    && (!Object.hasOwn(v, 'tokenRef') || ref(v.tokenRef)) && (!Object.hasOwn(v, 'profileRef') || ref(v.profileRef));
}
function binding(v: ConnectionVerificationBinding): boolean {
  return exact(v, ['credentialRevision', 'grantRevision']) && positive(v.credentialRevision) && positive(v.grantRevision);
}
async function safe<T>(run: () => Promise<ConnectionStoreResult<T>>): Promise<ConnectionStoreResult<T>> {
  try { return await run(); } catch (e) { return { ok: false, code: e instanceof Rejection ? e.code : 'unavailable' }; }
}

/** No controller, IO at construction, provider calls or credential resolution.
 * Lock order when composed: job -> connection -> canonical receipt. */
export function createConnectionStore(db: ReferenceDatabase, host: ConnectionStoreHost, namespace?: string): ConnectionStore {
  const { connections, revisions, receipts } = connectionTables(namespace), { jobs } = journalTables(namespace);
  const now = () => { const n = host.now(); if (!natural(n)) reject('unavailable'); return n; };
  function current(snapshot: ConnectionSnapshot) {
    const { result, credentials: c, verification: v } = snapshot;
    const parsed = validateConnectionEnsureResult(result, result.request, now());
    if (!parsed.ok) reject(parsed.code);
    if (result.authorization.state === 'active') {
      if (snapshot.locallyRevoked || !c || Math.min(c.credentialExpiresAt, c.grantExpiresAt) <= now()
        || result.authorization.expiresAt > Math.min(c.credentialExpiresAt, c.grantExpiresAt)) reject('not_current');
    }
    if (result.state === 'ready' && (!c || !v || v.credentialRevision !== c.credentialRevision
      || v.grantRevision !== c.grantRevision || result.evidence.expiresAt > Math.min(c.credentialExpiresAt, c.grantExpiresAt))) reject('not_current');
  }
  function perform(input: ConnectionEnsureInput, raw?: ConnectionMutation): Promise<ConnectionStoreResult<ConnectionSnapshot>> {
    return safe(async () => {
      if (!validateConnectionEnsureInput(input).ok) reject('invalid_payload');
      if (raw) {
        if (!natural(raw.expectedRevision) || raw.expectedRevision >= Number.MAX_SAFE_INTEGER
          || (raw.operation !== 'admit' && raw.expectedRevision === 0)) reject('invalid_payload');
        if (raw.operation === 'rotate' && !credentials(raw.credentials)) reject('invalid_payload');
        if (raw.operation === 'reconnect') {
          const parsed = validateConnectionEnsureResult(raw.result, input, now());
          if (!parsed.ok) reject(parsed.code);
          if (raw.result.state === 'ready' ? !raw.verification || !binding(raw.verification) : raw.verification !== null) reject('invalid_payload');
        }
      }
      // Detach before the authority callback or any SQL await.
      const request = copy(input), command = raw ? copy(raw) : undefined;
      return host.withAuthority(copy(request), command?.operation ?? 'load', async authority => {
        if (!same(authority.scope, request.identity.host)) reject('not_authorized');
        const access = authority.job ? copyAppendFence(authority.job) : undefined;
        if (access && !same(access.fence.identity, request.identity)) reject('lease_lost');
        return db.transaction(async tx => {
          const [job] = access ? await tx.select().from(jobs).where(eq(jobs.jobId, request.identity.jobId)).for('update') : [];
          const checkJob = () => { if (access && (!job || !matchesJobFence(job, access))) reject('lease_lost'); };
          checkJob();
          const initial: ConnectionSnapshot = { revision: 1, result: { request, state: 'requested', authorization: { state: 'unverified' } },
            credentials: null, locallyRevoked: false, verification: null };
          if (command?.operation === 'admit') {
            // Canonical capability order is significant under the admitted contract.
            const digest = `sha256:${createHash('sha256').update(JSON.stringify(request.minimumCapabilities)).digest('hex')}`;
            const inserted = await tx.insert(connections).values({ connectionRef: request.connectionRef, scope: request.identity.host,
              providerRef: request.providerRef, capabilityDigest: digest, recipeVersion: request.prerequisiteVersion,
              evidenceMode: request.evidenceMode, request, revision: 1, snapshot: initial }).onConflictDoNothing().returning();
            if (inserted.length) await tx.insert(revisions).values({ connectionRef: request.connectionRef, revision: 1, command, snapshot: initial });
          }
          const [head] = await tx.select().from(connections).where(eq(connections.connectionRef, request.connectionRef)).for('update');
          if (!head) reject(command?.operation === 'admit' ? 'conflict' : 'not_authorized');
          if (!same(head.scope, request.identity.host)) reject('not_authorized');
          if (!same(head.request, request)) reject('request_mismatch');
          if (!command) { current(head.snapshot); checkJob(); return { ok: true, value: head.snapshot }; }
          const revision = command.expectedRevision + 1;
          const [original] = await tx.select().from(revisions).where(and(eq(revisions.connectionRef, request.connectionRef), eq(revisions.revision, revision)));
          if (original) {
            if (!same(original.command, command) || (command.operation !== 'admit' && head.revision !== revision)) reject('conflict');
            current(original.snapshot); checkJob(); return { ok: true, value: original.snapshot };
          }
          if (head.revision !== command.expectedRevision) reject('conflict');
          let next: ConnectionSnapshot = { ...head.snapshot, revision };
          if (command.operation === 'rotate' || command.operation === 'revoke') {
            const old = head.snapshot.credentials;
            if (command.operation === 'rotate') {
              const c = command.credentials;
              if (Math.min(c.credentialExpiresAt, c.grantExpiresAt) <= now()) reject('not_current');
              if (old && (c.credentialRevision < old.credentialRevision || c.grantRevision < old.grantRevision
                || (c.credentialRevision === old.credentialRevision && c.grantRevision === old.grantRevision)
                || (c.credentialRevision === old.credentialRevision && !same([c.tokenRef, c.profileRef, c.credentialExpiresAt], [old.tokenRef, old.profileRef, old.credentialExpiresAt]))
                || (c.grantRevision === old.grantRevision && !same([c.grantRef, c.grantExpiresAt], [old.grantRef, old.grantExpiresAt]))
                || (head.snapshot.locallyRevoked && c.grantRevision <= old.grantRevision))) reject('conflict');
            }
            const revoked = command.operation === 'revoke';
            const authorization = revoked ? { state: 'revoked' as const, revokedAt: now() } : { state: 'unverified' as const };
            next = { ...next, credentials: command.operation === 'rotate' ? command.credentials : old,
              locallyRevoked: revoked, verification: null,
              result: head.snapshot.result.state === 'unknown_effect' ? { ...head.snapshot.result, authorization }
                : { request, state: 'inspecting', authorization } };
          } else if (command.operation === 'reconnect') {
            const parsed = validateConnectionReconnect(head.snapshot.result, command.result, now());
            if (!parsed.ok) reject(parsed.code);
            next = { ...next, result: command.result, verification: command.verification };
          } else reject('conflict');
          current(next);
          if (next.result.state === 'ready') {
            const fact = { receiptRef: next.result.evidence.receiptRef, connectionRef: request.connectionRef,
              credentialRevision: next.verification!.credentialRevision, grantRevision: next.verification!.grantRevision, evidence: next.result.evidence };
            await tx.insert(receipts).values(fact).onConflictDoNothing();
            const [originalReceipt] = await tx.select().from(receipts).where(eq(receipts.receiptRef, fact.receiptRef));
            if (!same(originalReceipt, fact)) reject('receipt_conflict');
          }
          await tx.insert(revisions).values({ connectionRef: request.connectionRef, revision, command, snapshot: next });
          const updated = await tx.update(connections).set({ revision, snapshot: next }).where(and(eq(connections.connectionRef, request.connectionRef), eq(connections.revision, command.expectedRevision))).returning();
          if (updated.length !== 1) reject('conflict');
          current(next); checkJob();
          return { ok: true, value: next };
        });
      });
    });
  }
  return {
    admit: request => perform(request, { operation: 'admit', expectedRevision: 0 }),
    load: request => perform(request),
    reconnect: (request, expectedRevision, result, verification) => perform(request, { operation: 'reconnect', expectedRevision, result, verification: verification ?? null }),
    rotate: (request, expectedRevision, credentials) => perform(request, { operation: 'rotate', expectedRevision, credentials }),
    revoke: (request, expectedRevision) => perform(request, { operation: 'revoke', expectedRevision }),
  };
}
