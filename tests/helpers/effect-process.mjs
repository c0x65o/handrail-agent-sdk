// Fresh worker fixture; only the synthetic provider boundary is implemented here.
// Its committed effects use a separate connection from the real SDK ledger.
import pg from 'pg';
import { referenceDatabase } from '../../.reference-build/reference/node/db/database.js';
import { services, start, request, identity, ok } from './effect-fixture.mjs';
process.once('message', async ({ schema, mode }) => {
  let client, provider;
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(schema) || !['crash', 'recover'].includes(mode)) throw Error();
    const config = { connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, options: '-c search_path=pg_catalog' };
    client = new pg.Client(config); provider = new pg.Client(config);
    await client.connect(); await provider.connect();
    const adapter = {
      async reconcile() {
        const { rows } = await provider.query(`SELECT receipt FROM "${schema}".synthetic_provider WHERE key=$1`, [request.idempotencyRef]);
        return rows.length ? { outcome: 'verified', receiptRef: rows[0].receipt } : { outcome: 'not_applied', evidenceRef: 'fixture-definitive-absence' };
      },
      async dispatch() {
        await provider.query(`INSERT INTO "${schema}".synthetic_calls DEFAULT VALUES`);
        await provider.query(`INSERT INTO "${schema}".synthetic_provider VALUES ($1,$2)`, [request.idempotencyRef, 'original-provider-receipt']);
        process.send({ event: 'provider_committed', pid: process.pid });
        return new Promise(() => {}); // parent kills before journal acknowledgement
      },
    };
    const s = services(referenceDatabase(client), schema, adapter, { timeoutMs: 10000 });
    const fence = await start(s, 800);
    const observation = ok(await s.effects.execute(request, fence));
    if (mode === 'recover') {
      const current = ok(await s.journal.load(identity));
      const revision = current.revision + 1;
      ok(await s.lease.complete({ kind: 'succeeded', previousRevision: current.revision,
        snapshot: { ...current, state: 'succeeded', revision, receipt: { receiptRef: observation.receiptRef,
          verification: 'host_verified', jobId: identity.jobId, revision } } }, fence));
      process.send({ event: 'recovered', pid: process.pid, observation });
    }
  } catch { process.send?.({ event: 'error', code: 'EFFECT_PROCESS_FAILED' }); }
  finally { await client?.end().catch(() => {}); await provider?.end().catch(() => {}); process.disconnect?.(); }
});
