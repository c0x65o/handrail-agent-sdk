import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, jsonb, pgSchema, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import type { JobDelivery, JobEvent, JobIdentity, JobSnapshot } from '../../../contracts/job.js';
import type { EffectRequest, EffectObservation } from '../../effects.js';
export const agentPostgresDefaultSchema = 'agent_reference';
/** Explicit namespace, including a harness-owned schema in tests. No search_path dependency. */
export function journalTables(namespace = agentPostgresDefaultSchema) {
  const schema = pgSchema(namespace);
  const jobs = schema.table('jobs', {
    jobId: text('job_id').primaryKey(),
    identity: jsonb('identity').$type<JobIdentity>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    cancellationEpoch: bigint('cancellation_epoch', { mode: 'number' }).notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseEpoch: bigint('lease_epoch', { mode: 'number' }).notNull().default(0),
    leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
    leaseGrantRevision: bigint('lease_grant_revision', { mode: 'number' }),
    leaseCancellationRevision: bigint('lease_cancellation_revision', { mode: 'number' }),
  }, t => [check('jobs_safe_revision', sql`${t.revision} between 0 and 9007199254740991`),
    check('jobs_safe_cancellation_epoch', sql`${t.cancellationEpoch} between 0 and 9007199254740991`),
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
  const cancellationEvidence = schema.table('job_cancellation_evidence', {
    jobId: text('job_id').notNull().references(() => jobs.jobId),
    effectRef: text('effect_ref').notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    outcome: text('outcome').$type<'unknown' | 'verified' | 'not_applied'>().notNull(),
    actorRef: text('actor_ref').notNull(),
  }, t => [primaryKey({ columns: [t.jobId, t.effectRef, t.evidenceRef] }),
    check('cancellation_evidence_outcome', sql`${t.outcome} in ('unknown', 'verified', 'not_applied')`)]);
  const challenges = schema.table('job_challenges', {
    jobId: text('job_id').primaryKey().references(() => jobs.jobId),
    requirementRef: text('requirement_ref').notNull(),
    requirementRevision: bigint('requirement_revision', { mode: 'number' }).notNull(),
    jobRevision: bigint('job_revision', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    resolverRef: text('resolver_ref').notNull(),
    grantRevision: bigint('grant_revision', { mode: 'number' }).notNull(),
    cancellationRevision: bigint('cancellation_revision', { mode: 'number' }).notNull(),
    consumed: integer('consumed').notNull().default(0),
  });
  const answerDeliveries = schema.table('job_answer_deliveries', {
    jobId: text('job_id').notNull().references(() => jobs.jobId),
    deliveryKey: text('delivery_key').notNull(),
    digest: text('digest').notNull(),
    eventCursor: bigint('event_cursor', { mode: 'number' }).notNull(),
  }, t => [primaryKey({ columns: [t.jobId, t.deliveryKey] })]);
  const effects = schema.table('job_effects', {
    jobId: text('job_id').notNull().references(() => jobs.jobId),
    effectRef: text('effect_ref').notNull(),
    providerRef: text('provider_ref').notNull(),
    idempotencyRef: text('idempotency_ref').notNull(),
    request: jsonb('request').$type<EffectRequest>().notNull(),
    admissionAuthority: jsonb('admission_authority').$type<import('../../job-lease.js').JobLeaseFence>().notNull(),
    authority: jsonb('authority').$type<import('../../job-lease.js').JobLeaseFence>().notNull(),
    reconciliation: jsonb('reconciliation').$type<EffectObservation>(),
    observation: jsonb('observation').$type<EffectObservation>().notNull(),
    resolvedRevision: bigint('resolved_revision', { mode: 'number' }),
  }, t => [primaryKey({ columns: [t.jobId, t.effectRef] }),
    unique('effects_provider_idempotency_unique').on(t.providerRef, t.idempotencyRef),
    check('effects_observation_shape', sql`(${t.observation}->>'outcome' = 'unknown' and ${t.resolvedRevision} is null)
      or (${t.observation}->>'outcome' = 'verified' and ${t.observation}->>'receiptRef' is not null)`)]);
  return { jobs, events, deliveries, checkpoints, admissions, cancellationEvidence, challenges, answerDeliveries, effects };
}
export const { jobs, events, deliveries, checkpoints, admissions, cancellationEvidence, challenges, answerDeliveries, effects } = journalTables();

/** OpenAI RunState is private encrypted custody, never public journal payload. */
export function agentStateTables(namespace = agentPostgresDefaultSchema) {
  const { jobs } = journalTables(namespace);
  return { states: pgSchema(namespace).table('agent_run_states', {
    jobId: text('job_id').primaryKey().references(() => jobs.jobId),
    version: bigint('version', { mode: 'number' }).notNull(),
    grantRevision: bigint('grant_revision', { mode: 'number' }).notNull(),
    keyRef: text('key_ref').notNull(),
    envelope: jsonb('envelope').$type<import('../private-envelope.js').PrivateEnvelope>().notNull(),
  }, t => [check('agent_run_states_version', sql`${t.version} between 1 and 9007199254740991`),
    check('agent_run_states_grant_revision', sql`${t.grantRevision} between 1 and 9007199254740991`)]) };
}
export const { states: agentRunStates } = agentStateTables();

export function assertAgentPostgresSchema(namespace: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(namespace) || namespace.toLowerCase() === 'public' || namespace.toLowerCase().startsWith('pg_') || namespace.toLowerCase() === 'information_schema') throw Error('invalid_agent_postgres_schema');
}
