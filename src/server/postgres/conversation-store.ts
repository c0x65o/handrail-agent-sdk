import type { Pool } from 'pg';
import type { ConversationStorage, ConversationRecord, ConversationCollection } from '../conversation.js';
import { canonicalAgentJson } from '../agent-state-binding.js';
import type { AgentStateKeys } from './keys.js';
import { assertAgentPostgresSchema } from './db/schema.js';
import { openPages, sealPages } from './paged-envelope.js';

/** Inert adapter; migrations and key custody belong to the trusted host.
 * Every scope transaction is serialized across processes. Payloads are encrypted
 * in <=64KiB pages, with AAD binding scope/collection/id/revision/page order. */
export function createPostgresConversationStorage(options: { client: Pool; schema: string; keys: AgentStateKeys;
  /** Explicit host resource quota for one record; does not bound transcript length. */
  maxRecordBytes: number }): ConversationStorage {
  assertAgentPostgresSchema(options.schema);
  if (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1) throw Error('CONVERSATION_STORAGE_LIMIT');
  const table = `"${options.schema}"."conversation_records"`;
  const collections = new Set(['transcript','state','pins','memory','work']);
  return {
    async transaction(scope, run) {
      const scopeKey = canonicalAgentJson(scope), c = await options.client.connect();
      const aad = (collection: string, id: string, revision: number, keyRef: string) =>
        Buffer.from(canonicalAgentJson(['conversation-record-v1', scope, collection, id, revision, keyRef]));
      async function decode(row: any): Promise<ConversationRecord> {
        const { keyRef, envelope } = row.payload;
        const value = openPages(envelope, await options.keys.resolve(keyRef), aad(row.collection,row.id,Number(row.revision),keyRef), options.maxRecordBytes);
        return { id:row.id, revision:Number(row.revision), order:Number(row.ordinal), active:row.active, value };
      }
      const check = (collection: ConversationCollection) => { if (!collections.has(collection)) throw Error('CONVERSATION_COLLECTION_INVALID'); };
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))', [`conversation:${options.schema}:${scopeKey}`]);
        const result = await run({
          async get(collection, id) {
            check(collection);
            const r = await c.query(`SELECT * FROM ${table} WHERE scope=$1 AND collection=$2 AND id=$3`, [scopeKey, collection, id]);
            return r.rows[0] ? decode(r.rows[0]) : null;
          },
          async page(collection, page) {
            check(collection);
            if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw Error('CONVERSATION_PAGE_LIMIT');
            const r = await c.query(`SELECT * FROM ${table} WHERE scope=$1 AND collection=$2
              AND ($6::boolean = false OR active) AND ($3::bigint IS NULL OR ordinal>$3) AND ($4::bigint IS NULL OR ordinal<$4)
              ORDER BY ordinal ${page.reverse ? 'DESC' : 'ASC'}, id LIMIT $5`, [scopeKey, collection, page.after ?? null, page.before ?? null, page.limit, page.activeOnly ?? false]);
            return Promise.all(r.rows.map(decode));
          },
          async put(collection, record) {
            check(collection);
            if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.order) || record.order < 1) throw Error('CONVERSATION_REVISION_INVALID');
            const key = await options.keys.current();
            const envelope = sealPages(record.value,key.key,aad(collection,record.id,record.revision,key.ref),options.maxRecordBytes);
            await c.query(`INSERT INTO ${table}(scope,collection,id,revision,ordinal,payload,active) VALUES($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT(scope,collection,id) DO UPDATE SET revision=excluded.revision,ordinal=excluded.ordinal,payload=excluded.payload,active=excluded.active`,
              [scopeKey,collection,record.id,record.revision,record.order,{keyRef:key.ref,envelope},record.active ?? true]);
          },
        });
        await c.query('COMMIT'); return result;
      } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    },
  };
}
