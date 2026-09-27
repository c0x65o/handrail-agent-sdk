import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, jsonb, pgSchema, primaryKey, text } from 'drizzle-orm/pg-core';
import type { JobDelivery, JobEvent, JobIdentity, JobSnapshot } from '../../../src/contracts/job.js';

export const referenceSchemaName = 'agent_reference';
/** Explicit namespace, including a harness-owned schema in tests. No search_path dependency. */
export function journalTables(namespace = referenceSchemaName) {
  const schema = pgSchema(namespace);
  const jobs = schema.table('jobs', {
    jobId: text('job_id').primaryKey(),
    identity: jsonb('identity').$type<JobIdentity>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
  }, t => [check('jobs_safe_revision', sql`${t.revision} between 0 and 9007199254740991`)]);
  const events = schema.table('job_events', {
    jobId: text('job_id').notNull().references(() => jobs.jobId),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    event: jsonb('event').$type<JobEvent>().notNull(),
  }, t => [primaryKey({ columns: [t.jobId, t.revision] }),
    check('events_safe_revision', sql`${t.revision} between 1 and 9007199254740991`)]);
  const deliveries = schema.table('job_deliveries', {
    jobId: text('job_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    attemptRef: text('attempt_ref').notNull(),
    delivery: jsonb('delivery').$type<JobDelivery>().notNull(),
  }, t => [primaryKey({ columns: [t.jobId, t.revision, t.attemptRef] }),
    foreignKey({ columns: [t.jobId, t.revision], foreignColumns: [events.jobId, events.revision] })]);
  const checkpoints = schema.table('job_checkpoints', {
    jobId: text('job_id').primaryKey().references(() => jobs.jobId),
    version: integer('version').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    snapshot: jsonb('snapshot').$type<JobSnapshot>().notNull(),
  }, t => [check('checkpoints_safe_revision', sql`${t.revision} between 1 and 9007199254740991`)]);
  return { jobs, events, deliveries, checkpoints };
}
export const { jobs, events, deliveries, checkpoints } = journalTables();
