// Child of the disposable PostgreSQL test only. IPC contains synthetic refs,
// revisions and PIDs; connection details and driver errors never leave here.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { referenceDatabase } from '../../.reference-build/reference/node/db/database.js';
import { journalTables } from '../../.reference-build/reference/node/db/schema.js';
import { createJobJournal } from '../../.reference-build/reference/node/job-journal.js';
import { createJobAdmissionStore } from '../../.reference-build/reference/node/job-admission.js';
import { createJobLeaseStore } from '../../.reference-build/reference/node/job-lease.js';
import { createJobLease } from '../../.reference-build/src/server/job-lease.js';
import { sameLeaseValue } from '../../.reference-build/src/server/job-lease.js';
import { createReferenceWorker } from '../../.reference-build/reference/node/worker.js';

process.once('message', async ({ schema, identity, mode }) => {
  let client;
  try {
    if (!/^sdk_test_[a-f0-9]{32}$/.test(schema) || !['checkpoint', 'resume'].includes(mode)) throw Error();
    client = new pg.Client({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL,
      application_name: 'handrail-sdk-worker-fixture', options: '-c search_path=pg_catalog' });
    await client.connect();
    const db = referenceDatabase(client), tables = journalTables(schema);
    const lease = createJobLease({ now: Date.now, newOwnerToken: () => `worker-${randomUUID()}`,
      withAuthority: async (original, _operation, run) => {
        if (!sameLeaseValue(original, identity)) return { ok: false, code: 'not_authorized' };
        return run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 });
      } }, createJobLeaseStore(db, tables));
    const worker = createReferenceWorker({
      host: { recover: async () => [identity], authorize: async () => ({ namespaceRef: 'fixture', host: identity.host, grantRevision: 1 }) },
      admission: createJobAdmissionStore(db, tables), journal: createJobJournal(db, tables), lease,
      limits: { maxSteps: 2, maxElapsedMs: 5_000, maxStepMs: 500, maxRetries: 0, leaseTtlMs: 800 },
      step: async snapshot => {
        if (mode === 'checkpoint' && snapshot.revision === 2) return { kind: 'checkpoint' };
        if (mode === 'checkpoint' && snapshot.revision === 3) {
          process.send?.({ event: 'checkpoint_committed', pid: process.pid, jobId: snapshot.identity.jobId,
            revision: snapshot.revision, correlationRef: snapshot.identity.origin.correlationRef });
          return new Promise(() => {});
        }
        if (mode === 'resume' && snapshot.revision === 3) return { kind: 'succeeded', receiptRef: 'fixture-verified-step' };
        throw Error('UNEXPECTED_STEP_REVISION');
      },
    });
    const result = await worker.start();
    await worker.stop();
    process.send?.({ event: 'done', pid: process.pid, result });
  } catch {
    process.send?.({ event: 'error', pid: process.pid, code: 'WORKER_PROCESS_FAILED' });
  } finally {
    if (client) await client.end().catch(() => {});
    process.disconnect?.();
  }
});
