import { createPostgresHarness } from '../helpers/postgres.js';
import { browserProfileTables } from '../../reference/node/db/schema.js';
import { createBrowserProfileStore } from '../../reference/node/browser-profile-store.js';
import { profilePolicy, profileState, keyService, digest } from './browser-profile-fixture.js';
// Private seed only over IPC. No plaintext, key, SQL error or captured output is returned.
process.once('message', async (m: { mode: 'create' | 'load' | 'terminate' | 'terminal'; schema: string; seed: string; status?: 'revoked' | 'deleted' }) => {
  let harness, result: object = { ok: false };
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(m.schema)) throw Error();
    harness = await createPostgresHarness();
    const client = await harness.client(), tables = browserProfileTables(m.schema);
    const store = createBrowserProfileStore(client.database(), { authorize: async () => profilePolicy }, keyService(m.seed), tables);
    const id = 'process-profile', state = profileState(m.seed);
    if (m.mode === 'create') {
      const saved = await store.create(id, state); if (!saved.ok) throw Error();
      result = { ok: true, pid: process.pid, receipt: saved.value };
    } else if (m.mode === 'load') {
      const loaded = await store.loadForExecutor(id, profilePolicy.allowedOrigins[0]);
      if (!loaded.ok || digest(loaded.value.state) !== digest(state)) throw Error();
      result = { ok: true, pid: process.pid, count: 3, digest: digest(loaded.value.state) };
    } else if (m.mode === 'terminate') {
      const r = await store.terminate(id, m.status!); if (!r.ok) throw Error();
      result = { ok: true, pid: process.pid, receipt: r.value };
    } else {
      const load = await store.loadForExecutor(id, profilePolicy.allowedOrigins[0]);
      const save = await store.save({ ...profilePolicy, profileRef: id, revision: 1, stateFormatVersion: 1 }, state);
      const create = await store.create(id, state);
      if ([load, save, create].some(r => r.ok || r.code !== `profile_${m.status}`)) throw Error();
      result = { ok: true, pid: process.pid, denied: 3 };
    }
  } catch { result = { ok: false }; }
  finally {
    try { await harness?.cleanup(); } catch { result = { ok: false }; }
    process.send?.(result, () => process.disconnect());
  }
});
