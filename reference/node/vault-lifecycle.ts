import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { VaultItem } from '../../src/contracts/vault.js';
import type { ReferenceDatabase } from './db/database.js';
import { vaultTables } from './db/schema.js';
import type { VaultKeyService, VaultStorageHost, VaultStoreResult } from './vault-store.js';
import { authority, safe, reject, inputItem, copy, canonical, itemId, keyReference,
  resolveKey, encrypt, decrypt, validateRow, current } from './vault-private.js';

export interface VaultRotationReceipt { readonly item: VaultItem; readonly rotationId: string }
/** Private reference-host lifecycle. Receipt is only an identifier, never authority.
 * The host must independently authorize every recovery and attest the current
 * lifecycle ledger. Ciphertext backups must never replace this ledger.
 * No key-retirement API: shared key retirement requires separate host proof. */
export function createVaultLifecycle(db: ReferenceDatabase, host: VaultStorageHost, keys: VaultKeyService, tables = vaultTables()) {
  const { items, states, preparations } = tables;
  const { authorize, recheck } = authority(host);
  const receipt = (item: VaultItem, rotationId: string): VaultRotationReceipt => ({ item, rotationId });
  return {
    prepare(input: VaultItem): Promise<VaultStoreResult<VaultRotationReceipt>> {
      return safe(async () => {
        const item = inputItem(input), scope = await authorize('rotate', item), id = itemId(item);
        const [row] = await db.select().from(items).where(eq(items.itemId, id));
        if (!row) reject('not_authorized');
        validateRow(row, item, scope);
        const state = await current(db, tables, row);
        const target = copy(await keys.active(copy(scope)));
        if (!keyReference(target)) reject('unavailable');
        if (target.keyHandle === row.keyHandle && target.keyVersion <= row.keyVersion) reject('conflict');
        await recheck('rotate', item, scope);
        await current(db, tables, row);
        const oldKey = await resolveKey(keys, scope, { keyHandle: row.keyHandle, keyVersion: row.keyVersion });
        await recheck('rotate', item, scope);
        await current(db, tables, row);
        const newKey = await resolveKey(keys, scope, target);
        await recheck('rotate', item, scope);
        await current(db, tables, row);
        const value = decrypt(row, oldKey);
        const { nonce: _nonce, ciphertext: _ciphertext, tag: _tag, ...header } = row;
        const envelope = encrypt({ ...header, ...target }, value, newKey), rotationId = randomUUID();
        await recheck('rotate', item, scope);
        await db.transaction(async tx => {
          const [locked] = await tx.select().from(states).where(eq(states.itemId, id)).for('update');
          if (!locked || locked.status !== 'active') reject('not_authorized');
          if (locked.generation !== state.generation || locked.activeNonce !== row.nonce) reject('conflict');
          await recheck('rotate', item, scope);
          await tx.insert(preparations).values({ rotationId, itemId: id, generation: state.generation, sourceNonce: row.nonce, envelope });
        });
        return receipt(item, rotationId);
      });
    },
    resume(input: VaultRotationReceipt): Promise<VaultStoreResult<VaultRotationReceipt>> {
      return safe(async () => {
        let request: VaultRotationReceipt;
        try {
          request = copy(input);
          if (Object.keys(request).length !== 2 || !/^[a-f0-9-]{36}$/.test(request.rotationId)) throw Error();
        } catch { return reject('invalid_payload'); }
        const item = inputItem(request.item), scope = await authorize('recover', item), id = itemId(item);
        const [row] = await db.select().from(items).where(eq(items.itemId, id));
        if (!row) reject('not_authorized');
        validateRow(row, item, scope);
        const state = await current(db, tables, row);
        const [prepared] = await db.select().from(preparations).where(eq(preparations.rotationId, request.rotationId));
        const replay = state.lastRotation === request.rotationId;
        if (!replay && (!prepared || prepared.itemId !== id || prepared.generation !== state.generation || prepared.sourceNonce !== row.nonce)) reject('conflict');
        const target = replay ? row : prepared.envelope;
        validateRow(target, item, scope);
        if (!replay && target.keyHandle === row.keyHandle && target.keyVersion <= row.keyVersion) reject('conflict');
        await recheck('recover', item, scope);
        const key = await resolveKey(keys, scope, { keyHandle: target.keyHandle, keyVersion: target.keyVersion });
        await recheck('recover', item, scope);
        await current(db, tables, row);
        // Authenticate the prepared envelope with exactly the retained target key.
        // No source key is needed after preparation has durably completed.
        decrypt(target, key);
        await recheck('recover', item, scope);
        await db.transaction(async tx => {
          const [locked] = await tx.select().from(states).where(eq(states.itemId, id)).for('update');
          if (!locked || locked.status !== 'active') reject('not_authorized');
          if (locked.generation !== state.generation || locked.activeNonce !== row.nonce) reject('conflict');
          await recheck('recover', item, scope);
          if (replay) return;
          const changed = await tx.update(states).set({ generation: state.generation + 1,
            activeNonce: target.nonce, lastRotation: request.rotationId }).where(and(eq(states.itemId, id),
            eq(states.generation, state.generation), eq(states.status, 'active'), eq(states.activeNonce, row.nonce))).returning();
          if (changed.length !== 1) reject('conflict');
          const saved = await tx.update(items).set(target).where(and(eq(items.itemId, id), eq(items.nonce, row.nonce))).returning();
          if (saved.length !== 1) reject('conflict');
          await tx.delete(preparations).where(eq(preparations.itemId, id));
        });
        return receipt(item, request.rotationId);
      });
    },
    /** Commit the fence separately from cleanup; callers may retry either phase. */
    terminate(input: VaultItem, status: 'deleted' | 'revoked'): Promise<VaultStoreResult<VaultItem>> {
      return safe(async () => {
        const item = inputItem(input);
        if (status !== 'deleted' && status !== 'revoked') reject('invalid_payload');
        const operation = status === 'deleted' ? 'delete' : 'revoke';
        const scope = await authorize(operation, item), id = itemId(item);
        await recheck(operation, item, scope);
        await db.transaction(async tx => {
          // Also fence an authorized identity whose create is still resolving keys.
          await tx.insert(states).values({ itemId: id, scope, revision: item.reference.revision,
            generation: 1, status, activeNonce: null }).onConflictDoNothing();
          const [state] = await tx.select().from(states).where(eq(states.itemId, id)).for('update');
          if (canonical(state.scope) !== canonical(scope) || state.revision !== item.reference.revision) reject('not_authorized');
          await recheck(operation, item, scope);
          if (state.status !== 'active') return; // Terminal state can never be reversed.
          await tx.update(states).set({ status, generation: state.generation + 1,
            activeNonce: null, lastRotation: null }).where(eq(states.itemId, id));
        });
        return item;
      });
    },
    cleanup(input: VaultItem): Promise<VaultStoreResult<VaultItem>> {
      return safe(async () => {
        const item = inputItem(input), scope = await authorize('cleanup', item), id = itemId(item);
        await recheck('cleanup', item, scope);
        await db.transaction(async tx => {
          const [state] = await tx.select().from(states).where(eq(states.itemId, id)).for('update');
          if (!state || canonical(state.scope) !== canonical(scope) || state.revision !== item.reference.revision) reject('not_authorized');
          if (state.status === 'active') reject('conflict');
          await recheck('cleanup', item, scope);
          await tx.delete(preparations).where(eq(preparations.itemId, id));
          await tx.delete(items).where(eq(items.itemId, id));
        });
        return item;
      });
    },
  };
}
