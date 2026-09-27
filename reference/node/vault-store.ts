import type { KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { JobIdentity } from '../../src/contracts/job.js';
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
export type VaultStorageOperation = 'create' | 'read' | 'rotate' | 'recover' | 'delete' | 'revoke' | 'cleanup';
export interface VaultStorageHost {
  /** Resolve the authenticated principal from trusted server context, enforce the
   * exact item/version ACL, approve nonsecret aliases and synthetic provenance,
   * and derive ALL scope dimensions. Never trust client-supplied policy facts.
   * For payment writes approve the specialized adapter alias as well. */
  authorize(operation: VaultStorageOperation, item: VaultItem, adapterRef?: string): Promise<VaultScope | null>;
}
export type VaultStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'invalid_payload' | 'not_authorized' | 'conflict' | 'unavailable' };
import { authority, safe, reject, inputItem, copy, valueValid, canonical, itemId,
  keyReference, resolveKey, encrypt, decrypt, validateRow, current } from './vault-private.js';

/** Server-only custody, backed by the authoritative lifecycle ledger.
 * Host must deny authorization if that ledger's freshness cannot be established
 * (including restore of the ledger itself). No SDK/model plaintext export. */
export function createVaultStore(db: ReferenceDatabase, host: VaultStorageHost, keys: VaultKeyService, tables = vaultTables()) {
  const { items, states } = tables;
  const { authorize, recheck } = authority(host);
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
        const scope = await authorize('create', item, adapterRef), id = itemId(item);
        const [state] = await db.select().from(states).where(eq(states.itemId, id));
        const [existing] = await db.select().from(items).where(eq(items.itemId, id));
        if (state || existing) {
          if (canonical((state ?? existing).scope) !== canonical(scope)) reject('not_authorized');
          if (state && state.status !== 'active') reject('not_authorized');
          reject('conflict');
        }
        await recheck('create', item, scope, adapterRef);
        const reference = copy(await keys.active(copy(scope)));
        if (!keyReference(reference)) reject('unavailable');
        await recheck('create', item, scope, adapterRef);
        const key = await resolveKey(keys, scope, reference);
        await recheck('create', item, scope, adapterRef);
        const row = encrypt({ itemId: id, revision: item.reference.revision, scope, item,
          envelopeVersion: 1, algorithm: 'aes-256-gcm', ...reference }, value, key);
        await recheck('create', item, scope, adapterRef);
        await db.transaction(async tx => {
          const saved = await tx.insert(states).values({ itemId: id, scope, revision: row.revision,
            generation: 1, status: 'active', activeNonce: row.nonce }).onConflictDoNothing().returning();
          if (saved.length !== 1) reject('conflict');
          await recheck('create', item, scope, adapterRef);
          const inserted = await tx.insert(items).values(row).onConflictDoNothing().returning({ id: items.itemId });
          if (inserted.length !== 1) reject('conflict');
        });
        return item;
      });
    },
    /** Private trusted executor result; no use grant and never a model/receipt value. */
    readForExecutor(input: VaultItem): Promise<VaultStoreResult<VaultValue>> {
      return safe(async () => {
        const item = inputItem(input), scope = await authorize('read', item);
        const [row] = await db.select().from(items).where(eq(items.itemId, itemId(item)));
        if (!row) reject('not_authorized');
        validateRow(row, item, scope);
        await current(db, tables, row);
        await recheck('read', item, scope);
        const key = await resolveKey(keys, scope, { keyHandle: row.keyHandle, keyVersion: row.keyVersion });
        await recheck('read', item, scope);
        await current(db, tables, row); // Key resolution may have raced a tombstone.
        const value = decrypt(row, key);
        await recheck('read', item, scope);
        await current(db, tables, row); // Final output fence after ALL external awaits.
        return value;
      });
    },
  };
}
