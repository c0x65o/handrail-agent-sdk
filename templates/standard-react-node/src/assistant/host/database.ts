import pg from "pg";
import { postgres } from "handrail-agent-sdk/assistant/persistence/postgres";

/** The host owns the pool and closes it after assistant workers have stopped. */
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 4 });
  // Idle connections can fail outside a query (restart, failover, network loss).
  // pg removes the broken client and opens replacements on demand. Handle the
  // pool event so it does not become an uncaught process error; never log the
  // raw error/client, which may contain credentials or private query details.
  pool.on("error", () => {
    console.error(JSON.stringify({ event: "database_pool_idle_connection_error" }));
  });
  return { pool, persistence: postgres(pool) };
}
