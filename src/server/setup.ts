import type { Pool } from 'pg';
import { postgres, type PostgresAssistantPersistenceOptions } from '../assistant/postgres/index.js';
import { createPostgresAgentStores, createPostgresAssistanceDatabase, migrateAgentPostgres,
  type AgentStateKeys } from './postgres/index.js';
import { createPostgresAssistanceStore, assistancePostgresSchema } from './assistance-postgres.js';

export interface PostgresAgentApplicationOptions {
  /** An existing, declared application database. The host owns pool lifecycle. */
  readonly pool: Pool;
  readonly agentSchema: string;
  readonly keys: AgentStateKeys;
  readonly checkpointQuotaBytes?: number;
  readonly assistant?: PostgresAssistantPersistenceOptions;
  /** Enable only when the application uses schedules/watches/notifications. */
  readonly assistance?: boolean;
}

/** One inert composition for the gateway and durable agent stores. Keeps legacy
 * gateway table/receipt formats and the explicitly selected agent namespace.
 * Does not create infrastructure, credentials, workers, or provider requests. */
export function createPostgresAgentApplication(options: PostgresAgentApplicationOptions) {
  const agent = createPostgresAgentStores({ client: options.pool, schema: options.agentSchema,
    keys: options.keys, ...(options.checkpointQuotaBytes === undefined ? {} : { checkpointQuotaBytes: options.checkpointQuotaBytes }) });
  const assistant = postgres(options.pool, options.assistant);
  const assistance = options.assistance
    ? createPostgresAssistanceStore(createPostgresAssistanceDatabase(options.pool), options.agentSchema) : null;
  let migrating: Promise<void> | null = null;
  return {
    agent, assistant, assistance,
    /** Explicit bootstrap through the host's authorized migration workflow.
     * Each subsystem is repeatable; a partial bootstrap is safe to retry.
     * Calls on this composition coalesce. Production approval is host-owned. */
    migrate(): Promise<void> {
      if (migrating) return migrating;
      migrating = (async () => {
        await migrateAgentPostgres(options.pool, options.agentSchema);
        await assistant.persistence.migrate();
        if (options.assistance) await options.pool.query(assistancePostgresSchema(options.agentSchema));
      })().finally(() => { migrating = null; });
      return migrating;
    },
  };
}
