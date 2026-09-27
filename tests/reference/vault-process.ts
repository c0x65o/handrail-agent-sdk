import { createPostgresHarness } from '../helpers/postgres.js';
import { createVaultStore } from '../../reference/node/vault-store.js';
import { vaultTables } from '../../reference/node/db/schema.js';
import { fixtures, keyService, scope } from './vault-fixture.js';
// IPC carries private fixtures, never argv, stdout, test diagnostics or disk.
process.once('message', async (message: { mode: 'write' | 'read'; seed: string; schema: string }) => {
  let harness;
  let result: object = { ok: false };
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(message.schema)) throw Error();
    // This process owns its connection and separate empty helper schema. Parent
    // owns the target migrated schema; child never claims cleanup of that schema.
    harness = await createPostgresHarness();
    const client = await harness.client();
    const store = createVaultStore(client.database(), { authorize: async () => scope }, keyService(message.seed), vaultTables(message.schema));
    const receipts = [];
    for (const f of fixtures(message.seed)) {
      if (message.mode === 'write') {
        const saved = await store.create(f.item, f.value);
        if (!saved.ok) throw Error();
        receipts.push(saved);
      } else {
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
