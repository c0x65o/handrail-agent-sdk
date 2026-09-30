import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase, NodePgClient } from 'drizzle-orm/node-postgres';
import { journalTables } from './schema.js';

export type AgentPostgresDatabase = NodePgDatabase;
/** Host owns connection creation, configuration and disposal. Never log the DB/client. */
export function agentPostgresDatabase(client: NodePgClient): AgentPostgresDatabase {
  return drizzle(client);
}
export { journalTables };
