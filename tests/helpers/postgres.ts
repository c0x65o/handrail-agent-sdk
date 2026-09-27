import { randomUUID } from 'node:crypto';
import type { Client, ClientConfig, QueryResult, QueryResultRow } from 'pg';

// No raw pg client, configuration, error, cause or notice escapes this module.
const failure = (code: string): Error => new Error(code);
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function configuration(): ClientConfig {
  const value = process.env.HANDRAIL_TEST_POSTGRES_URL;
  if (!value || process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE !== '1') {
    throw failure('POSTGRES_DISPOSABLE_CONNECTION_REQUIRED');
  }
  // pg falls back to PG* for omitted or falsy options. Reject ambient settings
  // entirely, including PGPASSFILE/PGSERVICE, before constructing any client.
  if (Object.keys(process.env).some(key => key.startsWith('PG') || key === 'NODE_PG_FORCE_NATIVE')) {
    throw failure('POSTGRES_AMBIENT_CONFIGURATION_FORBIDDEN');
  }
  try {
    const url = new URL(value);
    const sslmode = url.searchParams.get('sslmode');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !url.hostname || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
      || !url.username || !url.password
      || url.pathname.length < 2 || url.pathname.slice(1).includes('/') || url.hash
      || !['disable', 'verify-full'].includes(sslmode ?? '')
      || [...url.searchParams.keys()].length !== 1) {
      throw failure('invalid');
    }
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: sslmode === 'verify-full' ? { rejectUnauthorized: true } : false,
      application_name: 'handrail-sdk-disposable-test',
      options: '-c search_path=pg_catalog',
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      lock_timeout: 2_000,
      query_timeout: 7_000,
      idle_in_transaction_session_timeout: 10_000,
    };
  } catch {
    throw failure('POSTGRES_DISPOSABLE_CONNECTION_INVALID');
  }
}

export interface TestClient {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
  transaction<T>(run: (client: TestClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function connect(config: ClientConfig): Promise<TestClient> {
  let raw: Client;
  try {
    const { default: pg } = await import('pg');
    raw = new pg.Client(config);
  } catch { throw failure('POSTGRES_CLIENT_FAILED'); }
  let broken = false;
  let closed = false;
  let inTransaction = false;
  raw.on('error', () => { broken = true; });
  raw.on('notice', () => {});
  const client: TestClient = {
    async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
      if (closed || broken) throw failure('POSTGRES_CLIENT_UNAVAILABLE');
      try { return await raw.query<Row>(sql, values); }
      catch { throw failure('POSTGRES_QUERY_FAILED'); }
    },
    async transaction<T>(run: (client: TestClient) => Promise<T>) {
      if (inTransaction) throw failure('POSTGRES_NESTED_TRANSACTION_FORBIDDEN');
      inTransaction = true;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch {
        try { await client.query('ROLLBACK'); }
        catch { throw failure('POSTGRES_ROLLBACK_FAILED'); }
        throw failure('POSTGRES_TRANSACTION_FAILED');
      } finally { inTransaction = false; }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Disconnect rolls back any outstanding transaction, including an aborted
      // one. Await all disconnections before trying to acquire cleanup locks.
      try { await raw.end(); } catch { throw failure('POSTGRES_CLOSE_FAILED'); }
    },
  };
  try { await raw.connect(); }
  catch {
    await client.close();
    throw failure('POSTGRES_DISPOSABLE_CONNECTION_UNAVAILABLE');
  }
  return client;
}

export interface PostgresHarness {
  readonly schema: string;
  /** Qualified identifier; always use this for fixture tables. */
  table(name: string): string;
  /** Each call opens an independent backend connection. */
  client(): Promise<TestClient>;
  cleanup(): Promise<void>;
}

export async function createPostgresHarness(): Promise<PostgresHarness> {
  const config = configuration();
  const schema = `sdk_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await connect(config);
  const clients: TestClient[] = [];
  let owned = false;
  let disposed = false;
  let schemaOid: number | undefined;

  async function cleanup(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const closed = await Promise.allSettled(clients.map(client => client.close()));
    let failed = closed.some(result => result.status === 'rejected');
    try {
      if (owned) {
        await admin.transaction(async client => {
          const identity = await client.query<{ oid: number }>(
            'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema]);
          if (identity.rows.length !== 1 || identity.rows[0].oid !== schemaOid) {
            throw failure('POSTGRES_SCHEMA_OWNERSHIP_LOST');
          }
          // RESTRICT deliberately refuses external dependencies. Never use
          // CASCADE: it can remove objects in an unrelated schema.
          const tables = await client.query<{ relname: string }>(
            `SELECT relname FROM pg_catalog.pg_class
             WHERE relnamespace = $1 AND relkind = 'r' AND NOT relispartition`, [schemaOid]);
          if (tables.rows.length) {
            await client.query(`DROP TABLE ${tables.rows.map(row => `${quote(schema)}.${quote(row.relname)}`).join(', ')} RESTRICT`);
          }
          await client.query(`DROP SCHEMA ${quote(schema)} RESTRICT`);
        });
        owned = false;
      }
    } catch { failed = true; }
    finally {
      try { await admin.close(); } catch { failed = true; }
    }
    if (failed) throw failure('POSTGRES_CLEANUP_FAILED');
  }

  try {
    // CREATE has no IF NOT EXISTS: a collision never grants cleanup ownership.
    await admin.transaction(async client => {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      const result = await client.query<{ oid: number }>(
        'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema]);
      schemaOid = result.rows[0].oid;
    });
    owned = true;
  } catch {
    await cleanup();
    throw failure('POSTGRES_SCHEMA_SETUP_FAILED');
  }

  return Object.freeze({
    schema,
    table(name: string) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw failure('POSTGRES_TABLE_NAME_INVALID');
      return `${quote(schema)}.${quote(name)}`;
    },
    async client() {
      if (disposed) throw failure('POSTGRES_HARNESS_CLOSED');
      const client = await connect(config);
      if (disposed) {
        await client.close();
        throw failure('POSTGRES_HARNESS_CLOSED');
      }
      clients.push(client);
      return client;
    },
    cleanup,
  });
}
