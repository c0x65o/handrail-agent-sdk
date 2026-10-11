import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { JobIdentity } from '../../contracts/job.js';
import type { AgentStateKeys } from '../postgres/keys.js';
import { seal, open } from '../postgres/private-envelope.js';
import { assertAgentPostgresSchema } from '../postgres/db/schema.js';

export type Scope = JobIdentity['host'];
export const canonicalScope = (s: Scope) => JSON.stringify([s.tenantRef, s.userRef, s.projectRef, s.accountRef, s.environmentRef, s.purposeRef]);
export const scopeKey = (s: Scope) => createHash('sha256').update(canonicalScope(s)).digest('hex');
export interface RecordValue<T> { version: number; value: T }

/** Private SDK records. Neither ciphertext nor decrypted custody is a tool result.
 * Scope, record ID, revision and key version are authenticated as encryption AAD. */
export function managedStore(pool: Pool, schema: string, keys: AgentStateKeys) {
  assertAgentPostgresSchema(schema);
  const table = `"${schema}"."managed_capability_records"`;
  const aad = (scope: Scope, id: string, version: number, key: string) =>
    Buffer.from(JSON.stringify(['managed-capabilities-v1', canonicalScope(scope), id, version, key]));
  return {
    async get<T>(scope: Scope, id: string): Promise<RecordValue<T> | null> {
      const { rows } = await pool.query(`SELECT version, key_ref, envelope FROM ${table} WHERE scope=$1 AND id=$2`, [scopeKey(scope), id]);
      if (!rows.length) return null;
      const r = rows[0], key = await keys.resolve(r.key_ref);
      return { version: r.version, value: open(r.envelope, key, aad(scope, id, r.version, r.key_ref)) as T };
    },
    async put<T>(scope: Scope, id: string, value: T, expected: number): Promise<void> {
      if (Buffer.byteLength(JSON.stringify(value)) > 65_536) throw Error('CAPABILITY_STORAGE_LIMIT');
      const { ref, key } = await keys.current(), version = expected + 1;
      const envelope = seal(value, key, aad(scope, id, version, ref));
      const result = expected === 0
        ? await pool.query(`INSERT INTO ${table}(scope,id,version,key_ref,envelope) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [scopeKey(scope), id, version, ref, envelope])
        : await pool.query(`UPDATE ${table} SET version=$3,key_ref=$4,envelope=$5 WHERE scope=$1 AND id=$2 AND version=$6`, [scopeKey(scope), id, version, ref, envelope, expected]);
      if (result.rowCount !== 1) throw Error('CAPABILITY_CONFLICT');
    },
    async list<T>(scope: Scope, prefix: string): Promise<Array<{ id: string; value: T }>> {
      const { rows } = await pool.query(`SELECT id,version,key_ref,envelope FROM ${table} WHERE scope=$1 AND starts_with(id,$2) ORDER BY id LIMIT 101`, [scopeKey(scope), prefix]);
      if (rows.length > 100) throw Error('CAPABILITY_ACCOUNT_LIMIT');
      return Promise.all(rows.map(async r => ({ id: r.id, value: open(r.envelope, await keys.resolve(r.key_ref), aad(scope, r.id, r.version, r.key_ref)) as T })));
    },
    /** Session lock spans commits before external IO. A second process cannot
     * operate the same account concurrently. Pool connections always release. */
    async lock<T>(scope: Scope, id: string, run: () => Promise<T>): Promise<T> {
      const client = await pool.connect(), lock = `managed:${schema}:${scopeKey(scope)}:${id}`;
      let held = false, discard = false;
      try {
        const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', [lock]);
        held = result.rows[0]?.held === true;
        if (!held) throw Error('CAPABILITY_BUSY');
        return await run();
      } finally {
        if (held) { try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); } catch { discard = true; } }
        client.release(discard);
      }
    },
  };
}
export type ManagedStore = ReturnType<typeof managedStore>;
