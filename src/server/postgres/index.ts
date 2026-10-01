import type { Pool } from 'pg';
import type { JobAdmissionStore, JobStore } from '../job-store.js';
import type { JobLeaseStore } from '../job-lease.js';
import type { EffectStore } from '../effects.js';
import type { JobCancellationStore } from '../cancel.js';
import type { JobAnswerStore } from '../answer.js';
import type { AgentStateStore } from '../agent-runtime.js';
import { agentPostgresDatabase } from './db/database.js';
import { journalTables, assertAgentPostgresSchema } from './db/schema.js';
import { createJobAdmissionStore as createJobAdmissionStoreImpl } from './job-admission.js';
import { createJobJournal as createJobJournalImpl } from './job-journal.js';
import { createJobLeaseStore as createJobLeaseStoreImpl } from './job-lease.js';
import { createEffectStore as createEffectStoreImpl } from './effects.js';
import { createJobCancellationStore as createJobCancellationStoreImpl } from './job-cancellation.js';
import { createJobAnswerStore as createJobAnswerStoreImpl } from './job-answer.js';
import { createAgentStateStore as createAgentStateStoreImpl } from './agent-state-store.js';
import type { AgentStateKeys } from './keys.js';

export type { AgentStateKeys };
export interface PostgresAgentStores {
  admission: JobAdmissionStore; journal: JobStore; lease: JobLeaseStore; effects: EffectStore;
  cancellation: JobCancellationStore; answer: JobAnswerStore; states: AgentStateStore;
}
export { agentPostgresMigrations, migrateAgentPostgres } from './migrate.js';

/** Inert composition. Host owns pool, schema selection, migration and key custody.
 * Schema is a SQL namespace, not tenant authority: every request still needs the
 * complete trusted JobIdentity and current host authorization. */
export function createPostgresAgentStores(options: {
  readonly client: Pool;
  readonly schema: string;
  readonly keys: AgentStateKeys;
  readonly checkpointQuotaBytes?: number;
}): PostgresAgentStores {
  assertAgentPostgresSchema(options.schema);
  const db = agentPostgresDatabase(options.client), tables = journalTables(options.schema);
  return {
    admission: createJobAdmissionStoreImpl(db, tables),
    journal: createJobJournalImpl(db, tables),
    lease: createJobLeaseStoreImpl(db, tables),
    effects: createEffectStoreImpl(db, tables),
    cancellation: createJobCancellationStoreImpl(db, tables),
    answer: createJobAnswerStoreImpl(db, tables),
    states: createAgentStateStoreImpl(db, options.keys, options.schema, options.checkpointQuotaBytes),
  };
}

export function createJobAdmissionStore(client: Pool, schema: string): JobAdmissionStore {
  assertAgentPostgresSchema(schema);
  return createJobAdmissionStoreImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createJobJournal(client: Pool, schema: string): JobStore {
  assertAgentPostgresSchema(schema);
  return createJobJournalImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createJobLeaseStore(client: Pool, schema: string): JobLeaseStore {
  assertAgentPostgresSchema(schema);
  return createJobLeaseStoreImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createEffectStore(client: Pool, schema: string): EffectStore {
  assertAgentPostgresSchema(schema);
  return createEffectStoreImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createJobCancellationStore(client: Pool, schema: string): JobCancellationStore {
  assertAgentPostgresSchema(schema);
  return createJobCancellationStoreImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createJobAnswerStore(client: Pool, schema: string): JobAnswerStore {
  assertAgentPostgresSchema(schema);
  return createJobAnswerStoreImpl(agentPostgresDatabase(client), journalTables(schema));
}

export function createAgentStateStore(client: Pool, keys: AgentStateKeys, schema: string, checkpointQuotaBytes?: number): AgentStateStore {
  assertAgentPostgresSchema(schema);
  return createAgentStateStoreImpl(agentPostgresDatabase(client), keys, schema, checkpointQuotaBytes);
}

/** pg.Pool bridge for the existing assistance SQL API. No connection is opened
 * until a query/transaction is requested; errors cause a rollback. */
export function createPostgresAssistanceDatabase(pool: Pool): import('../assistance-postgres.js').AssistanceDatabase {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await run(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}

export { createPostgresConversationStorage } from './conversation-store.js';
