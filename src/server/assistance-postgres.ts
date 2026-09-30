import { assistanceDigest } from './assistance.js';
import type { AssistanceKey, AssistanceStore, AssistanceRecord, NotificationFact } from './assistance.js';

/** Adapt pg.Pool or the application's existing transaction wrapper. The SDK
 * never opens a connection or applies DDL. Migrations remain host-owned. */
export interface AssistanceSql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}
export interface AssistanceDatabase extends AssistanceSql {
  transaction<T>(run: (tx: AssistanceSql) => Promise<T>): Promise<T>;
}
function table(schema: string, name: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw Error('invalid_schema');
  return `"${schema}"."${name}"`;
}
/** Additive schema, for the host's normal migration pipeline. References only;
 * private content stays in host custody. Never run on import/construction. */
export function assistancePostgresSchema(schema: string): string {
  const records = table(schema, 'assistance_records'), receipts = table(schema, 'assistance_commands'), facts = table(schema, 'assistance_facts');
  return `CREATE TABLE ${records} (key text PRIMARY KEY, scope text NOT NULL, state text NOT NULL, next_at bigint NOT NULL, record jsonb NOT NULL);
CREATE INDEX ON ${records} (next_at, key) WHERE state = 'active';
CREATE TABLE ${receipts} (key text NOT NULL, command_id text NOT NULL, digest text NOT NULL, record jsonb NOT NULL, PRIMARY KEY(key, command_id));
CREATE TABLE ${facts} (ordinal bigserial UNIQUE NOT NULL, fact_id text PRIMARY KEY, scope text NOT NULL, fact jsonb NOT NULL);
CREATE INDEX ON ${facts} (scope, ordinal);`;
}
export function createPostgresAssistanceStore(db: AssistanceDatabase, schema: string): AssistanceStore {
  const records = table(schema, 'assistance_records'), receipts = table(schema, 'assistance_commands'), facts = table(schema, 'assistance_facts');
  return {
    transaction<T>(input: AssistanceKey, run: Parameters<AssistanceStore['transaction']>[1]): Promise<T> {
      const key = assistanceDigest(input), scope = assistanceDigest(input.scope);
      return db.transaction(async sql => {
        // Lock even absent rows, so concurrent create/retries serialize. A hash
        // collision only serializes unrelated keys; it never grants access.
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        return await run({
          async get() { return (await sql.query(`SELECT record FROM ${records} WHERE key=$1 AND scope=$2`, [key, scope])).rows[0]?.record ?? null; },
          async put(record: AssistanceRecord) {
            if (assistanceDigest({ scope: record.scope, id: record.id }) !== key) throw Error('assistance_scope_mismatch');
            await sql.query(`INSERT INTO ${records}(key,scope,state,next_at,record) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(key) DO UPDATE SET state=$3,next_at=$4,record=$5`, [key, scope, record.state, record.nextAt, JSON.stringify(record)]);
          },
          async receipt(commandId: string) {
            return (await sql.query(`SELECT digest,record FROM ${receipts} WHERE key=$1 AND command_id=$2`, [key, commandId])).rows[0] as { digest: string; record: AssistanceRecord } ?? null;
          },
          async saveReceipt(commandId: string, digest: string, record: AssistanceRecord) {
            await sql.query(`INSERT INTO ${receipts}(key,command_id,digest,record) VALUES($1,$2,$3,$4)`, [key, commandId, digest, JSON.stringify(record)]);
          },
          async notify(fact: NotificationFact) {
            if (assistanceDigest({ scope: fact.scope, id: fact.id }) !== key) throw Error('assistance_scope_mismatch');
            const prior = (await sql.query(`SELECT fact FROM ${facts} WHERE fact_id=$1`, [fact.factId])).rows[0]?.fact;
            if (prior) {
              if (assistanceDigest({ ...prior, createdAt: 0 }) !== assistanceDigest({ ...fact, createdAt: 0 })) throw Error('notification_conflict');
              return;
            }
            await sql.query(`INSERT INTO ${facts}(fact_id,scope,fact) VALUES($1,$2,$3)`, [fact.factId, scope, JSON.stringify(fact)]);
          },
        }) as T;
      });
    },
    async due(now, limit) {
      const rows = (await db.query(`SELECT record FROM ${records} WHERE state='active' AND next_at <= $1 ORDER BY next_at,key LIMIT $2`, [now, limit])).rows;
      return rows.map(({ record }) => ({ scope: record.scope, id: record.id }));
    },
    async list(scope, after, limit) {
      const scopeKey = assistanceDigest(scope);
      const cursor = after === null ? '' : assistanceDigest({ scope, id: after });
      return (await db.query(`SELECT record FROM ${records} WHERE scope=$1 AND key > $2 ORDER BY key LIMIT $3`,
        [scopeKey, cursor, limit])).rows.map(r => r.record);
    },
    async facts(scope, after, limit) {
      const scopeKey = assistanceDigest(scope);
      let cursor = 0;
      if (after) {
        const row = (await db.query(`SELECT ordinal FROM ${facts} WHERE fact_id=$1 AND scope=$2`, [after, scopeKey])).rows[0];
        if (!row) throw Error('invalid_inbox_cursor');
        cursor = row.ordinal;
      }
      return (await db.query(`SELECT fact FROM ${facts} WHERE scope=$1 AND ordinal > $2 ORDER BY ordinal LIMIT $3`, [scopeKey, cursor, limit])).rows.map(r => r.fact);
    },
  };
}
