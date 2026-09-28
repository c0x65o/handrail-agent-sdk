// Private synthetic capture process. No input/key material crosses IPC or logs.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { referenceDatabase } from '../../.reference-build/reference/node/db/database.js';
import { entryState, entryServices } from './vault-entry-fixture.mjs';
process.once('message', async ({ schema, mode, handle, kind = 'token' }) => {
  let client;
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(schema) || !['capture', 'deliver'].includes(mode)) throw Error();
    client = new pg.Client({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, options: '-c search_path=pg_catalog' });
    await client.connect();
    const state = entryState(kind);
    const noKeys = { active: async () => { throw Error(); }, resolve: async () => { throw Error(); } };
    const { entry } = entryServices(referenceDatabase(client), schema, state, mode === 'deliver' ? noKeys : undefined);
    if (mode === 'capture') {
      const issued = await entry.issue(state.request); if (!issued.ok) throw Error();
      const captured = await entry.capture(issued.value, { token: randomBytes(32).toString('hex') }); if (!captured.ok) throw Error();
      process.send({ event: 'captured', handle: issued.value, completion: captured.value });
      // Parent kills this process after capture commit, before any delivery.
      return;
    }
    const delivered = await entry.deliver(handle); if (!delivered.ok) throw Error();
    process.send({ event: 'delivered', receipt: delivered.value });
  } catch { process.send?.({ event: 'error', code: 'ENTRY_PROCESS_FAILED' }); }
  finally { await client?.end().catch(() => {}); if (mode !== 'capture') process.disconnect?.(); }
});
