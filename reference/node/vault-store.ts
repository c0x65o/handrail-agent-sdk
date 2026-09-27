import { createCipheriv, createDecipheriv, randomBytes, KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { JobIdentity } from '../../src/contracts/job.js';
import { validateVaultItem } from '../../src/contracts/vault.js';
import type { VaultItem } from '../../src/contracts/vault.js';
import type { ReferenceDatabase } from './db/database.js';
import { vaultTables } from './db/schema.js';

export type VaultScope = JobIdentity['host'];
/** Private host/executor values. Never export these through SDK/model tools. */
export type VaultValue = { readonly password: string } | { readonly token: string }
  | { readonly value: string } | { readonly adapterRef: string };
export interface VaultKeyReference { readonly keyHandle: string; readonly keyVersion: number }
export interface VaultKeyService {
  /** Host-owned stable opaque handle/version per actual key; no fallback or key discovery. */
  active(scope: VaultScope): Promise<VaultKeyReference>;
  resolve(scope: VaultScope, reference: VaultKeyReference): Promise<KeyObject | null>;
}
export interface VaultStorageHost {
  /** Resolve the authenticated principal from trusted server context, enforce the
   * exact item/version ACL, approve nonsecret aliases and synthetic provenance,
   * and derive ALL scope dimensions. Never trust client-supplied policy facts.
   * For payment writes approve the specialized adapter alias as well. */
  authorize(operation: 'create' | 'read', item: VaultItem, adapterRef?: string): Promise<VaultScope | null>;
}
export type VaultStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'invalid_payload' | 'not_authorized' | 'conflict' | 'unavailable' };
class Rejection extends Error {
  constructor(readonly code: Extract<VaultStoreResult<never>, { ok: false }>['code']) { super(code); }
}
function reject(code: Rejection['code']): never { throw new Rejection(code); }
async function safe<T>(run: () => Promise<T>): Promise<VaultStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const scopeKeys = ['tenantRef', 'userRef', 'projectRef', 'accountRef', 'environmentRef', 'purposeRef'] as const;
/** Inert detached data only, before the first await; no getters/toJSON. */
function copy(value: unknown, depth = 0): any {
  if (depth > 5) throw Error();
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16) throw Error();
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw Error();
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!d.enumerable || !('value' in d)) throw Error();
    result[key] = copy(d.value, depth + 1);
  }
  return Object.freeze({ ...result });
}
function exact(value: any, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value, k));
}
function validScope(value: any): value is VaultScope {
  return exact(value, scopeKeys) && scopeKeys.every(k => ref(value[k]));
}
function canonical(value: any): string {
  return typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
}
function itemId(item: VaultItem): string {
  return item.reference.kind === 'secret' ? item.reference.itemRef : item.reference.paymentRef;
}
function valueValid(item: VaultItem, value: any): value is VaultValue {
  const field = { login: 'password', token: 'token', identity: 'value', payment_method: 'adapterRef' }[item.metadata.kind];
  if (!exact(value, [field]) || typeof value[field] !== 'string') return false;
  // Payment custody accepts only host-approved opaque UUID aliases to a specialized
  // adapter, never a provider token, card object, PAN, CVV or generic secret value.
  if (field === 'adapterRef') return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value[field]);
  return Buffer.byteLength(value[field], 'utf8') <= 16_384;
}
function keyReference(value: any): value is VaultKeyReference {
  return exact(value, ['keyHandle', 'keyVersion']) && ref(value.keyHandle)
    && Number.isInteger(value.keyVersion) && value.keyVersion > 0 && value.keyVersion <= 2147483647;
}
function bytes(value: string, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 131_072) throw Error();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw Error();
  return decoded;
}

/** Server-only custody. Host owns connection/key lifetime. Immutable initial
 * writes only; rotation, deletion, grants and broker execution are separate.
 * No SDK export, logs, events or diagnostics contain private values. */
export function createVaultStore(db: ReferenceDatabase, host: VaultStorageHost, keys: VaultKeyService, tables = vaultTables()) {
  const { items } = tables;
  type Row = typeof items.$inferSelect;
  async function authorize(operation: 'create' | 'read', item: VaultItem, adapterRef?: string) {
    try {
      const scope = copy(await host.authorize(operation, copy(item), adapterRef));
      if (!validScope(scope)) throw Error();
      return scope;
    } catch { return reject('not_authorized'); }
  }
  async function recheck(operation: 'create' | 'read', item: VaultItem, scope: VaultScope, adapterRef?: string) {
    if (canonical(await authorize(operation, item, adapterRef)) !== canonical(scope)) reject('not_authorized');
  }
  async function resolve(scope: VaultScope, reference: VaultKeyReference) {
    const key = await keys.resolve(copy(scope), copy(reference));
    if (!(key instanceof KeyObject) || key.type !== 'secret' || key.symmetricKeySize !== 32) reject('unavailable');
    return key;
  }
  function aad(row: Omit<Row, 'nonce' | 'ciphertext' | 'tag'>) {
    return Buffer.from(canonical({ domain: 'handrail-reference-vault', ...row }), 'utf8');
  }
  function inputItem(input: VaultItem) {
    try {
      const item = copy(input);
      if (!validateVaultItem(item).ok) throw Error();
      return item as VaultItem;
    } catch { return reject('invalid_payload'); }
  }
  return {
    create(input: VaultItem, privateValue: VaultValue): Promise<VaultStoreResult<VaultItem>> {
      return safe(async () => {
        const item = inputItem(input);
        let value: VaultValue;
        try {
          value = copy(privateValue);
          if (item.reference.revision !== 1 || !valueValid(item, value)) throw Error();
        } catch { return reject('invalid_payload'); }
        const adapterRef = 'adapterRef' in value ? value.adapterRef : undefined;
        const scope = await authorize('create', item, adapterRef);
        const id = itemId(item);
        const [existing] = await db.select().from(items).where(eq(items.itemId, id));
        if (existing) {
          if (canonical(existing.scope) !== canonical(scope)) reject('not_authorized');
          reject('conflict');
        }
        await recheck('create', item, scope, adapterRef);
        const reference = copy(await keys.active(copy(scope)));
        if (!keyReference(reference)) reject('unavailable');
        await recheck('create', item, scope, adapterRef);
        const key = await resolve(scope, reference);
        await recheck('create', item, scope, adapterRef);
        const header = { itemId: id, revision: item.reference.revision, scope, item,
          envelopeVersion: 1, algorithm: 'aes-256-gcm', ...reference };
        const nonce = randomBytes(12);
        const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
        let ciphertext: Buffer;
        let tag: Buffer;
        try {
          const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
          cipher.setAAD(aad(header));
          ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          tag = cipher.getAuthTag();
        } finally { plaintext.fill(0); }
        await recheck('create', item, scope, adapterRef);
        const saved = await db.insert(items).values({ ...header, nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') }).onConflictDoNothing().returning({ id: items.itemId });
        if (saved.length !== 1) reject('conflict');
        return item;
      });
    },
    /** Private trusted executor boundary; callers must never serialize this result
     * into receipts, tools, model observations or logs. It conveys no use grant. */
    readForExecutor(input: VaultItem): Promise<VaultStoreResult<VaultValue>> {
      return safe(async () => {
        const item = inputItem(input);
        const scope = await authorize('read', item);
        const [row] = await db.select().from(items).where(eq(items.itemId, itemId(item)));
        if (!row || !validScope(row.scope) || canonical(row.scope) !== canonical(scope)) reject('not_authorized');
        if (!validateVaultItem(row.item).ok || canonical(row.item) !== canonical(item)
          || row.revision !== item.reference.revision || row.itemId !== itemId(item)) reject('unavailable');
        const { nonce, ciphertext, tag, ...header } = row;
        const reference = { keyHandle: row.keyHandle, keyVersion: row.keyVersion };
        if (row.envelopeVersion !== 1 || row.algorithm !== 'aes-256-gcm' || !keyReference(reference)) reject('unavailable');
        const iv = bytes(nonce, 12), encrypted = bytes(ciphertext), authTag = bytes(tag, 16);
        await recheck('read', item, scope);
        const key = await resolve(scope, reference);
        await recheck('read', item, scope);
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(aad(header));
        decipher.setAuthTag(authTag);
        // update() output is unauthenticated; erase it even when final() fails.
        const partial = decipher.update(encrypted);
        let plaintext: Buffer | undefined;
        try {
          plaintext = Buffer.concat([partial, decipher.final()]);
          const value = copy(JSON.parse(plaintext.toString('utf8')));
          if (!valueValid(item, value)) reject('unavailable');
          await recheck('read', item, scope);
          return value;
        } finally { partial.fill(0); plaintext?.fill(0); }
      });
    },
  };
}
