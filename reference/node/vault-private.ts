import { validateVaultCardValue } from '../../src/server/payment-vault.js';
// Internal reference-host helpers, never exported by the SDK.
import { KeyObject } from 'node:crypto';
import { seal, open } from './private-envelope.js';
export { bytes } from './private-envelope.js';
import { eq } from 'drizzle-orm';
import { validateVaultItem } from '../../src/contracts/vault.js';
import type { VaultItem } from '../../src/contracts/vault.js';
import type { VaultScope, VaultValue, VaultKeyReference, VaultKeyService, VaultStorageHost, VaultStoreResult, VaultStorageOperation } from './vault-store.js';
import { vaultTables } from './db/schema.js';
export type VaultRow = ReturnType<typeof vaultTables>['items']['$inferSelect'];
class Rejection extends Error {
  constructor(readonly code: Extract<VaultStoreResult<never>, { ok: false }>['code']) { super(code); }
}
export function reject(code: Rejection['code']): never { throw new Rejection(code); }
export async function safe<T>(run: () => Promise<T>): Promise<VaultStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, code: error instanceof Rejection ? error.code : 'unavailable' }; }
}
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const scopeKeys = ['tenantRef', 'userRef', 'projectRef', 'accountRef', 'environmentRef', 'purposeRef'] as const;
/** Inert detached data only, before the first await; no getters/toJSON. */
export function copy(value: unknown, depth = 0): any {
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
export function validScope(value: any): value is VaultScope {
  return exact(value, scopeKeys) && scopeKeys.every(k => ref(value[k]));
}
export function canonical(value: any): string {
  return typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
}
export function itemId(item: VaultItem): string {
  return item.reference.kind === 'secret' ? item.reference.itemRef : item.reference.paymentRef;
}
export function valueValid(item: VaultItem, value: any): value is VaultValue {
  if (item.metadata.kind === 'payment_method') return validateVaultCardValue(value);
  const field = { login: 'password', token: 'token', identity: 'value' }[item.metadata.kind];
  if (!exact(value, [field]) || typeof value[field] !== 'string') return false;
  return Buffer.byteLength(value[field], 'utf8') <= 16_384;
}
export function keyReference(value: any): value is VaultKeyReference {
  return exact(value, ['keyHandle', 'keyVersion']) && ref(value.keyHandle)
    && Number.isInteger(value.keyVersion) && value.keyVersion > 0 && value.keyVersion <= 2147483647;
}
export function inputItem(input: VaultItem): VaultItem {
  try { const item = copy(input); if (!validateVaultItem(item).ok) throw Error(); return item; }
  catch { return reject('invalid_payload'); }
}
export function authority(host: VaultStorageHost) {
  async function authorize(operation: VaultStorageOperation, item: VaultItem) {
    try {
      const scope = copy(await host.authorize(operation, copy(item)));
      if (!validScope(scope)) throw Error();
      return scope;
    } catch { return reject('not_authorized'); }
  }
  return { authorize, async recheck(operation: VaultStorageOperation, item: VaultItem, scope: VaultScope) {
    if (canonical(await authorize(operation, item)) !== canonical(scope)) reject('not_authorized');
  } };
}
export async function resolveKey(keys: VaultKeyService, scope: VaultScope, reference: VaultKeyReference) {
  if (!keyReference(reference)) reject('unavailable');
  const key = await keys.resolve(copy(scope), copy(reference));
  if (!(key instanceof KeyObject) || key.type !== 'secret' || key.symmetricKeySize !== 32) reject('unavailable');
  return key;
}
// Explicit v1 projection: adding lifecycle columns must NEVER change existing AAD.
function aad(row: Omit<VaultRow, 'nonce' | 'ciphertext' | 'tag'>) {
  return Buffer.from(canonical({ domain: 'handrail-reference-vault', itemId: row.itemId,
    revision: row.revision, scope: row.scope, item: row.item, envelopeVersion: row.envelopeVersion,
    algorithm: row.algorithm, keyHandle: row.keyHandle, keyVersion: row.keyVersion }), 'utf8');
}
export function validateRow(row: VaultRow, item: VaultItem, scope: VaultScope) {
  if (!validScope(row.scope) || canonical(row.scope) !== canonical(scope)) reject('not_authorized');
  if (!validateVaultItem(row.item).ok || canonical(row.item) !== canonical(item)
    || row.revision !== item.reference.revision || row.itemId !== itemId(item)
    || row.envelopeVersion !== 1 || row.algorithm !== 'aes-256-gcm'
    || !keyReference({ keyHandle: row.keyHandle, keyVersion: row.keyVersion })) reject('unavailable');
}
export function encrypt(header: Omit<VaultRow, 'nonce' | 'ciphertext' | 'tag'>, value: VaultValue, key: KeyObject): VaultRow {
  return { ...header, ...seal(value, key, aad(header)) };
}
export function decrypt(row: VaultRow, key: KeyObject): VaultValue {
  const value = copy(open(row, key, aad(row)));
  if (!valueValid(row.item, value)) reject('unavailable');
  return value;
}

/** Read only the authoritative ledger, never infer active state from ciphertext. */
export async function current(db: import('./db/database.js').ReferenceDatabase, tables: ReturnType<typeof vaultTables>, row: VaultRow) {
  const [state] = await db.select().from(tables.states).where(eq(tables.states.itemId, row.itemId));
  if (!state) reject('unavailable');
  if (state.status !== 'active') reject('not_authorized');
  if (state.activeNonce !== row.nonce || state.revision !== row.revision || canonical(state.scope) !== canonical(row.scope)) reject('unavailable');
  return state;
}
