import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, jsonb, pgSchema, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import type { JobDelivery, JobEvent, JobIdentity, JobSnapshot } from '../../../src/contracts/job.js';

export const referenceSchemaName = 'agent_reference';
/** Explicit namespace, including a harness-owned schema in tests. No search_path dependency. */
export function journalTables(namespace = referenceSchemaName) {
  const schema = pgSchema(namespace);
  const jobs = schema.table('jobs', {
    jobId: text('job_id').primaryKey(),
    identity: jsonb('identity').$type<JobIdentity>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseEpoch: bigint('lease_epoch', { mode: 'number' }).notNull().default(0),
    leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
    leaseGrantRevision: bigint('lease_grant_revision', { mode: 'number' }),
    leaseCancellationRevision: bigint('lease_cancellation_revision', { mode: 'number' }),
  }, t => [check('jobs_safe_revision', sql`${t.revision} between 0 and 9007199254740991`),
    check('jobs_safe_lease_epoch', sql`${t.leaseEpoch} between 0 and 9007199254740991`),
    check('jobs_lease_shape', sql`(
      ${t.leaseOwner} is null and ${t.leaseExpiresAt} is null and ${t.leaseGrantRevision} is null and ${t.leaseCancellationRevision} is null
    ) or (
      ${t.leaseOwner} is not null and ${t.leaseExpiresAt} is not null and ${t.leaseGrantRevision} is not null and ${t.leaseCancellationRevision} is not null
      and ${t.leaseOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${t.leaseEpoch} > 0
      and ${t.leaseExpiresAt} between 0 and 9007199254740991
      and ${t.leaseGrantRevision} between 1 and 9007199254740991
      and ${t.leaseCancellationRevision} between 0 and 9007199254740991
    )`)]);
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
  const admissions = schema.table('job_admissions', {
    tenantRef: text('tenant_ref').notNull(),
    userRef: text('user_ref').notNull(),
    namespaceRef: text('namespace_ref').notNull(),
    requestKey: text('request_key').notNull(),
    digest: text('digest').notNull(),
    jobId: text('job_id').notNull().references(() => jobs.jobId),
  }, t => [primaryKey({ columns: [t.tenantRef, t.userRef, t.namespaceRef, t.requestKey] }),
    unique('admissions_job_id_unique').on(t.jobId)]);
  return { jobs, events, deliveries, checkpoints, admissions };
}
export const { jobs, events, deliveries, checkpoints, admissions } = journalTables();
