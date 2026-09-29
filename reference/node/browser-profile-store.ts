// Private reference-host custody. Never export this module through SDK/model APIs.
import type { KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ReferenceDatabase } from './db/database.js';
import { browserProfileTables } from './db/schema.js';
import type { VaultKeyService, VaultScope } from './vault-store.js';
import { canonical, validScope, keyReference, resolveKey } from './vault-private.js';
import { seal, open } from './private-envelope.js';

export interface BrowserProfilePolicy {
  readonly scope: VaultScope;
  readonly allowedOrigins: readonly string[];
  readonly authorityEpoch: number;
  readonly expiresAt: number;
}
export interface BrowserProfileMetadata extends BrowserProfilePolicy {
  readonly profileRef: string;
  readonly revision: number;
  readonly stateFormatVersion: number;
}
/** v1 supports only secure host-only cookies, localStorage and sessionStorage.
 * Domain cookies, partitioned cookies, IndexedDB and browser-specific state must
 * be rejected by adapters, never silently dropped or broadened on restore. */
export interface BrowserProfileState {
  readonly cookies: readonly {
    readonly origin: string; readonly name: string; readonly value: string;
    readonly path: string; readonly expires: number; readonly httpOnly: boolean;
    readonly secure: true; readonly sameSite: 'Strict' | 'Lax' | 'None';
  }[];
  readonly storage: readonly {
    readonly origin: string;
    readonly localStorage: readonly { readonly name: string; readonly value: string }[];
    readonly sessionStorage: readonly { readonly name: string; readonly value: string }[];
  }[];
}
export type BrowserProfileOperation = 'create' | 'load' | 'save' | 'revoke' | 'delete' | 'cleanup';
export interface BrowserProfileHost {
  /** From authenticated server context: exact profile ACL, six scope dimensions,
   * origins, current epoch and absolute expiry. ID possession is not authority.
   * Deny if ledger freshness cannot be attested (including full DB restore). */
  authorize(operation: BrowserProfileOperation, profileRef: string): Promise<BrowserProfilePolicy | null>;
}
export type BrowserProfileCode = 'invalid_payload' | 'not_authorized' | 'origin_not_allowed'
  | 'conflict' | 'profile_missing' | 'profile_revoked' | 'profile_deleted'
  | 'reauthentication_required' | 'key_unavailable' | 'incompatible_state' | 'corrupt_state' | 'unavailable';
export type BrowserProfileResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrowserProfileCode };
export interface BrowserProfileTermination {
  readonly profileRef: string;
  readonly authorityEpoch: number;
  readonly local: { readonly state: 'revoked' | 'deleted'; readonly cleanup: 'pending' | 'complete' };
  readonly remote: { readonly state: 'not_requested' };
}
class Rejection extends Error {
  constructor(readonly code: BrowserProfileCode) { super(code); }
}
function reject(code: BrowserProfileCode): never { throw new Rejection(code); }
async function safe<T>(run: () => Promise<T>): Promise<BrowserProfileResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const exact = (v: any, names: string[]) => v && !Array.isArray(v) && typeof v === 'object'
  && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const origin = (v: unknown): v is string => {
  try { return typeof v === 'string' && v.length <= 2048 && new URL(v).protocol === 'https:' && new URL(v).origin === v; }
  catch { return false; }
};
const text = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 16_384;
/** Inert, bounded, detached input before any await; no accessors or toJSON. */
function detached(value: unknown): any {
  let budget = 4096;
  function walk(v: any, depth: number): any {
    if (--budget < 0 || depth > 8) throw Error();
    if (typeof v === 'string') { if (!text(v)) throw Error(); return v; }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (!v || typeof v !== 'object') throw Error();
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error();
    const keys = Reflect.ownKeys(v), out: any = array ? [] : Object.create(null);
    if (keys.length > 257 || (array && keys.length !== v.length + 1)) throw Error();
    for (const k of keys) {
      if (array && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (typeof k !== 'string' || !d.enumerable || !('value' in d)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) throw Error();
      out[k] = walk(d.value, depth + 1);
    }
    return Object.freeze(array ? out : { ...out });
  }
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw Error();
  return result;
}
function policyValid(p: any): p is BrowserProfilePolicy {
  return exact(p, ['scope', 'allowedOrigins', 'authorityEpoch', 'expiresAt']) && validScope(p.scope)
    && positive(p.authorityEpoch) && positive(p.expiresAt) && Array.isArray(p.allowedOrigins)
    && p.allowedOrigins.length > 0 && p.allowedOrigins.length <= 32 && p.allowedOrigins.every(origin)
    && new Set(p.allowedOrigins).size === p.allowedOrigins.length;
}
function policy(m: BrowserProfileMetadata): BrowserProfilePolicy {
  return { scope: m.scope, allowedOrigins: m.allowedOrigins, authorityEpoch: m.authorityEpoch, expiresAt: m.expiresAt };
}
function metadataValid(m: any): m is BrowserProfileMetadata {
  return exact(m, ['profileRef', 'revision', 'scope', 'allowedOrigins', 'authorityEpoch', 'expiresAt', 'stateFormatVersion'])
    && ref(m.profileRef) && positive(m.revision) && positive(m.stateFormatVersion) && policyValid(policy(m));
}
function stateValid(s: any, origins: readonly string[]): s is BrowserProfileState {
  if (!exact(s, ['cookies', 'storage']) || !Array.isArray(s.cookies) || !Array.isArray(s.storage)) return false;
  const cookieKeys = new Set<string>(), storageKeys = new Set<string>();
  return s.cookies.every((c: any) => {
    if (!exact(c, ['origin', 'name', 'value', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'])
      || !origins.includes(c.origin) || !text(c.name) || !c.name || !text(c.value)
      || !text(c.path) || !c.path.startsWith('/') || !Number.isSafeInteger(c.expires) || c.expires < -1
      || typeof c.httpOnly !== 'boolean' || c.secure !== true || !['Strict', 'Lax', 'None'].includes(c.sameSite)) return false;
    const id = JSON.stringify([c.origin, c.name, c.path]);
    if (cookieKeys.has(id)) return false; cookieKeys.add(id); return true;
  }) && s.storage.every((s: any) => {
    if (!exact(s, ['origin', 'localStorage', 'sessionStorage']) || !origins.includes(s.origin) || storageKeys.has(s.origin)) return false;
    storageKeys.add(s.origin);
    return [s.localStorage, s.sessionStorage].every(list => Array.isArray(list)
      && list.every(e => exact(e, ['name', 'value']) && text(e.name) && text(e.value))
      && new Set(list.map(e => e.name)).size === list.length);
  });
}
function input<T>(v: T, valid: (v: any) => boolean): T {
  try { const result = detached(v); if (!valid(result)) throw Error(); return result; }
  catch { return reject('invalid_payload'); }
}
type Tables = ReturnType<typeof browserProfileTables>;
type Row = Tables['snapshots']['$inferSelect'];
type State = Tables['states']['$inferSelect'];
function aad(r: Omit<Row, 'nonce' | 'ciphertext' | 'tag'>): Buffer {
  return Buffer.from(canonical({ domain: 'handrail-reference-browser-profile', profileRef: r.profileRef,
    metadata: r.metadata, envelopeVersion: r.envelopeVersion, algorithm: r.algorithm,
    keyHandle: r.keyHandle, keyVersion: r.keyVersion }));
}
/** Exact-ID operations only; no account search, alternate profile or key fallback.
 * Key service and plaintext results belong solely to the trusted private executor.
 * Host must fence browser control separately before using this persistence API. */
export function createBrowserProfileStore(db: ReferenceDatabase, host: BrowserProfileHost, keys: VaultKeyService,
  tables = browserProfileTables(), now: () => number = Date.now) {
  const { snapshots, states } = tables;
  async function authorize(op: BrowserProfileOperation, id: string): Promise<BrowserProfilePolicy> {
    if (!ref(id)) reject('invalid_payload');
    try {
      const grant = detached(await host.authorize(op, id));
      if (!policyValid(grant)) throw Error();
      return grant;
    } catch { return reject('not_authorized'); }
  }
  async function recheck(op: BrowserProfileOperation, id: string, grant: BrowserProfilePolicy) {
    if (canonical(await authorize(op, id)) !== canonical(grant)) reject('not_authorized');
  }
  function live(m: BrowserProfilePolicy) {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) reject('unavailable');
    if (time >= m.expiresAt) reject('reauthentication_required');
  }
  function scoped(s: State, grant: BrowserProfilePolicy) {
    if (!validScope(s.scope) || canonical(s.scope) !== canonical(grant.scope)) reject('not_authorized');
  }
  function active(s: State, grant: BrowserProfilePolicy) {
    scoped(s, grant);
    if (s.status === 'revoked') reject('profile_revoked');
    if (s.status === 'deleted') reject('profile_deleted');
    if (s.status !== 'active') reject('corrupt_state');
    if (s.authorityEpoch !== grant.authorityEpoch) reject('conflict');
  }
  async function current(id: string, grant: BrowserProfilePolicy, row?: Row) {
    const [s] = await db.select().from(states).where(eq(states.profileRef, id));
    if (!s) reject('profile_missing');
    active(s, grant);
    if (row && (s.activeNonce !== row.nonce || s.revision !== row.metadata.revision
      || s.authorityEpoch !== row.metadata.authorityEpoch)) reject('conflict');
    return s;
  }
  async function key(grant: BrowserProfilePolicy, reference: { keyHandle: string; keyVersion: number }): Promise<KeyObject> {
    try { return await resolveKey(keys, grant.scope, reference); }
    catch { return reject('key_unavailable'); }
  }
  async function envelope(m: BrowserProfileMetadata, value: BrowserProfileState): Promise<Row> {
    let reference;
    try { reference = detached(await keys.active(m.scope)); if (!keyReference(reference)) throw Error(); }
    catch { return reject('key_unavailable'); }
    const k = await key(m, reference);
    const header = { profileRef: m.profileRef, metadata: m, envelopeVersion: 1, algorithm: 'aes-256-gcm', ...reference };
    return { ...header, ...seal(value, k, aad(header)) };
  }
  function receipt(s: State, cleanup: 'pending' | 'complete'): BrowserProfileTermination {
    if (s.status === 'active') reject('conflict');
    return { profileRef: s.profileRef, authorityEpoch: s.authorityEpoch,
      local: { state: s.status, cleanup }, remote: { state: 'not_requested' } };
  }
  return {
    create(profileRef: string, privateState: BrowserProfileState): Promise<BrowserProfileResult<BrowserProfileMetadata>> {
      return safe(async () => {
        const value = input(privateState, () => true), grant = await authorize('create', profileRef);
        if (!stateValid(value, grant.allowedOrigins)) reject('invalid_payload');
        live(grant);
        if (grant.authorityEpoch === Number.MAX_SAFE_INTEGER) reject('conflict');
        const m: BrowserProfileMetadata = { ...grant, profileRef, revision: 1, stateFormatVersion: 1 };
        const [existing] = await db.select().from(states).where(eq(states.profileRef, profileRef));
        if (existing) { active(existing, grant); reject('conflict'); }
        const row = await envelope(m, value);
        await db.transaction(async tx => {
          await recheck('create', profileRef, grant); live(grant);
          const saved = await tx.insert(states).values({ profileRef, scope: grant.scope, revision: 1,
            authorityEpoch: grant.authorityEpoch, status: 'active', activeNonce: row.nonce }).onConflictDoNothing().returning();
          if (saved.length !== 1) reject('conflict');
          const inserted = await tx.insert(snapshots).values(row).onConflictDoNothing().returning();
          if (inserted.length !== 1) reject('conflict');
        });
        return m;
      });
    },
    loadForExecutor(profileRef: string, requestedOrigin: string): Promise<BrowserProfileResult<{ metadata: BrowserProfileMetadata; state: BrowserProfileState }>> {
      return safe(async () => {
        const grant = await authorize('load', profileRef);
        if (!origin(requestedOrigin) || !grant.allowedOrigins.includes(requestedOrigin)) reject('origin_not_allowed');
        await current(profileRef, grant); live(grant);
        const [row] = await db.select().from(snapshots).where(eq(snapshots.profileRef, profileRef));
        if (!row) reject('corrupt_state');
        let m: BrowserProfileMetadata;
        try { m = detached(row.metadata); if (!metadataValid(m) || m.profileRef !== profileRef) throw Error(); }
        catch { return reject('corrupt_state'); }
        if (m.stateFormatVersion !== 1 || row.envelopeVersion !== 1 || row.algorithm !== 'aes-256-gcm') reject('incompatible_state');
        if (canonical(policy(m)) !== canonical(grant)) reject('not_authorized');
        await current(profileRef, grant, row);
        const k = await key(grant, { keyHandle: row.keyHandle, keyVersion: row.keyVersion });
        await recheck('load', profileRef, grant);
        let value: BrowserProfileState;
        try { value = detached(open(row, k, aad(row))); if (!stateValid(value, grant.allowedOrigins)) throw Error(); }
        catch { return reject('corrupt_state'); }
        await recheck('load', profileRef, grant);
        await current(profileRef, grant, row); live(grant);
        return { metadata: m, state: value };
      });
    },
    save(expected: BrowserProfileMetadata, privateState: BrowserProfileState): Promise<BrowserProfileResult<BrowserProfileMetadata>> {
      return safe(async () => {
        const prior = input(expected, metadataValid), value = input(privateState, s => stateValid(s, prior.allowedOrigins));
        const grant = await authorize('save', prior.profileRef);
        if (canonical(policy(prior)) !== canonical(grant)) reject('not_authorized');
        if (prior.stateFormatVersion !== 1) reject('incompatible_state');
        live(grant); await current(prior.profileRef, grant);
        if (prior.revision === Number.MAX_SAFE_INTEGER) reject('conflict');
        const m = { ...prior, revision: prior.revision + 1 }, row = await envelope(m, value);
        await db.transaction(async tx => {
          const [s] = await tx.select().from(states).where(eq(states.profileRef, prior.profileRef)).for('update');
          if (!s) reject('profile_missing'); active(s, grant);
          if (s.revision !== prior.revision || s.authorityEpoch !== prior.authorityEpoch) reject('conflict');
          const [old] = await tx.select().from(snapshots).where(eq(snapshots.profileRef, prior.profileRef));
          if (!old || old.nonce !== s.activeNonce || canonical(old.metadata) !== canonical(prior)) reject('conflict');
          await recheck('save', prior.profileRef, grant); live(grant);
          await tx.update(snapshots).set(row).where(eq(snapshots.profileRef, prior.profileRef));
          await tx.update(states).set({ revision: m.revision, activeNonce: row.nonce }).where(eq(states.profileRef, prior.profileRef));
        });
        return m;
      });
    },
    /** Durable terminal fence first. Cleanup is a separate retryable transaction. */
    terminate(profileRef: string, status: 'revoked' | 'deleted'): Promise<BrowserProfileResult<BrowserProfileTermination>> {
      return safe(async () => {
        if (status !== 'revoked' && status !== 'deleted') reject('invalid_payload');
        const op = status === 'revoked' ? 'revoke' : 'delete', grant = await authorize(op, profileRef);
        return db.transaction(async tx => {
          // Fence an identity even if its initial create is still resolving keys.
          if (grant.authorityEpoch === Number.MAX_SAFE_INTEGER) reject('conflict');
          await tx.insert(states).values({ profileRef, scope: grant.scope, revision: 1,
            authorityEpoch: grant.authorityEpoch + 1, status, activeNonce: null }).onConflictDoNothing();
          const [s] = await tx.select().from(states).where(eq(states.profileRef, profileRef)).for('update');
          scoped(s, grant); await recheck(op, profileRef, grant);
          if (s.status !== 'active') return receipt(s, 'pending');
          if (s.authorityEpoch === Number.MAX_SAFE_INTEGER) reject('conflict');
          const next = { ...s, status, authorityEpoch: s.authorityEpoch + 1, activeNonce: null };
          await tx.update(states).set(next).where(eq(states.profileRef, profileRef));
          return receipt(next, 'pending');
        });
      });
    },
    cleanup(profileRef: string): Promise<BrowserProfileResult<BrowserProfileTermination>> {
      return safe(async () => {
        const grant = await authorize('cleanup', profileRef);
        return db.transaction(async tx => {
          const [s] = await tx.select().from(states).where(eq(states.profileRef, profileRef)).for('update');
          if (!s) reject('profile_missing'); scoped(s, grant);
          const result = receipt(s, 'complete');
          await recheck('cleanup', profileRef, grant);
          await tx.delete(snapshots).where(eq(snapshots.profileRef, profileRef));
          return result;
        });
      });
    },
  };
}
