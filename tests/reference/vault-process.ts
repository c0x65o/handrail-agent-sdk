import { createPostgresHarness } from '../helpers/postgres.js';
import { createVaultLifecycle } from '../../reference/node/vault-lifecycle.js';
import { createVaultStore } from '../../reference/node/vault-store.js';
import { vaultTables } from '../../reference/node/db/schema.js';
import { fixtures, keyService, scope } from './vault-fixture.js';
// IPC carries private fixtures, never argv, stdout, test diagnostics or disk.
process.once('message', async (message: { mode: 'write' | 'read' | 'prepare' | 'recover'; seed: string; schema: string }) => {
  let harness;
  let result: object = { ok: false };
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(message.schema)) throw Error();
    // This process owns its connection and separate empty helper schema. Parent
    // owns the target migrated schema; child never claims cleanup of that schema.
    harness = await createPostgresHarness();
    const client = await harness.client();
    const keys = keyService(message.seed), tables = vaultTables(message.schema), host = { authorize: async () => scope };
    const store = createVaultStore(client.database(), host, keys, tables);
    const lifecycle = createVaultLifecycle(client.database(), host, keys, tables);
    const receipts = [];
    for (const f of fixtures(message.seed)) {
      if (message.mode === 'write' || message.mode === 'prepare') {
        keys.version = 1;
        const saved = await store.create(f.item, f.value);
        if (!saved.ok) throw Error();
        receipts.push(saved);
        if (message.mode === 'prepare') {
          keys.version = 2;
          const prepared = await lifecycle.prepare(f.item);
          if (!prepared.ok) throw Error();
          receipts.push(prepared);
        }
      } else {
        if (message.mode === 'recover') {
          // Restart knows only durable preparation and freshly authenticated host.
          keys.unavailable.add(1);
          const pending = await client.database().select().from(tables.preparations);
          const id = f.item.reference.kind === 'secret' ? f.item.reference.itemRef : f.item.reference.paymentRef;
          const p = pending.find(p => p.itemId === id);
          if (!p) throw Error();
          const recovered = await lifecycle.resume({ item: f.item, rotationId: p.rotationId });
          if (!recovered.ok || !(await lifecycle.resume(recovered.value)).ok) throw Error();
          receipts.push(recovered);
        }
        const read = await store.readForExecutor(f.item);
        if (!read.ok || JSON.stringify(read.value) !== JSON.stringify(f.value)) throw Error();
      }
    }
    if (message.mode === 'read') for (const f of fixtures(message.seed, '-restart')) {
      const saved = await store.create(f.item, f.value);
      if (!saved.ok) throw Error();
      receipts.push(saved);
    }
    result = { ok: true, pid: process.pid, count: 8, receipts };
  } catch { result = { ok: false }; }
  finally {
    try { await harness?.cleanup(); } catch { result = { ok: false }; }
    process.send?.(result, () => process.disconnect());
  }
});
