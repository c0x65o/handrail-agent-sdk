import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, jsonb, pgSchema, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import type { JobDelivery, JobEvent, JobIdentity, JobSnapshot } from '../../../src/contracts/job.js';
import type { EffectRequest, EffectObservation } from '../../../src/server/effects.js';
import type { VaultItem } from '../../../src/contracts/vault.js';

export const referenceSchemaName = 'agent_reference';
/** Explicit namespace, including a harness-owned schema in tests. No search_path dependency. */
export function journalTables(namespace = referenceSchemaName) {
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
    admissionAuthority: jsonb('admission_authority').$type<import('../../../src/server/job-lease.js').JobLeaseFence>().notNull(),
    authority: jsonb('authority').$type<import('../../../src/server/job-lease.js').JobLeaseFence>().notNull(),
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

/** Separate custody table: no plaintext or key bytes, and no journal dependency. */
export function vaultTables(namespace = referenceSchemaName) {
  const items = pgSchema(namespace).table('vault_items', {
    itemId: text('item_id').primaryKey(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    scope: jsonb('scope').$type<JobIdentity['host']>().notNull(),
    item: jsonb('item').$type<VaultItem>().notNull(),
    envelopeVersion: integer('envelope_version').notNull(),
    algorithm: text('algorithm').notNull(),
    keyHandle: text('key_handle').notNull(),
    keyVersion: integer('key_version').notNull(),
    nonce: text('nonce').notNull(),
    ciphertext: text('ciphertext').notNull(),
    tag: text('tag').notNull(),
  }, t => [
    check('vault_safe_revision', sql`${t.revision} between 1 and 9007199254740991`),
    unique('vault_key_nonce_unique').on(t.keyHandle, t.keyVersion, t.nonce),
  ]);
  // Authoritative lifecycle ledger; never restore it from a ciphertext backup.
  const states = pgSchema(namespace).table('vault_states', {
    itemId: text('item_id').primaryKey(),
    scope: jsonb('scope').$type<JobIdentity['host']>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    status: text('status').$type<'active' | 'deleted' | 'revoked'>().notNull(),
    activeNonce: text('active_nonce'),
    lastRotation: text('last_rotation'),
  }, t => [check('vault_state_generation', sql`${t.generation} between 1 and 9007199254740991`),
    check('vault_state_shape', sql`(${t.status} = 'active' and ${t.activeNonce} is not null) or
      (${t.status} in ('deleted', 'revoked') and ${t.activeNonce} is null and ${t.lastRotation} is null)`)]);
  const preparations = pgSchema(namespace).table('vault_preparations', {
    rotationId: text('rotation_id').primaryKey(),
    itemId: text('item_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    sourceNonce: text('source_nonce').notNull(),
    envelope: jsonb('envelope').$type<typeof items.$inferSelect>().notNull(),
  });
  return { items, states, preparations };
}
export const { items: vaultItems, states: vaultStates, preparations: vaultPreparations } = vaultTables();

/** Item-scoped authorization only; custody and native organization ACLs stay separate. */
export function vaultGrantTables(namespace = referenceSchemaName) {
  const schema = pgSchema(namespace);
  const grants = schema.table('vault_item_grants', {
    grantRef: text('grant_ref').primaryKey(),
    itemId: text('item_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    grant: jsonb('grant').$type<import('../../../src/server/vault-use.js').VaultItemGrant>().notNull(),
  }, t => [check('vault_grant_revision', sql`${t.revision} between 1 and 9007199254740991`)]);
  const access = schema.table('vault_access', {
    receiptRef: text('receipt_ref').primaryKey(),
    itemId: text('item_id').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    phase: text('phase').$type<import('../../../src/server/vault-use.js').VaultAccessFact['phase']>().notNull(),
    outcome: text('outcome').$type<import('../../../src/server/vault-use.js').VaultAccessFact['outcome']>().notNull(),
  }, t => [index('vault_access_item_time').on(t.itemId, t.at, t.receiptRef),
    check('vault_access_phase', sql`${t.phase} in ('admit', 'dispatch')`),
    check('vault_access_outcome', sql`${t.outcome} in ('authorized', 'denied', 'expired', 'revoked', 'stale_grant', 'unknown', 'verified')`)]);
  return { grants, access };
}
export const { grants: vaultItemGrants, access: vaultAccess } = vaultGrantTables();

/** One completion/outbox fact per authenticated entry session. Never private input. */
export function vaultEntryTables(namespace = referenceSchemaName) {
  const { jobs } = journalTables(namespace);
  const sessions = pgSchema(namespace).table('vault_entry_sessions', {
    sessionRef: text('session_ref').primaryKey(),
    jobId: text('job_id').notNull().references(() => jobs.jobId),
    jobRevision: bigint('job_revision', { mode: 'number' }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    state: text('state').$type<'open' | 'captured' | 'delivered' | 'withdrawn' | 'expired'>().notNull(),
    binding: jsonb('binding').$type<import('../../../src/server/vault-entry.js').VaultEntryBinding>().notNull(),
    authority: jsonb('authority').$type<import('../../../src/server/job-lease.js').JobLeaseAuthority>().notNull(),
    completion: jsonb('completion').$type<import('../../../src/contracts/vault.js').VaultEntryCompletion>(),
    receipt: jsonb('receipt').$type<import('../../../src/server/answer.js').JobAnswerReceipt>(),
  }, t => [unique('vault_entry_job_revision').on(t.jobId, t.jobRevision),
    check('vault_entry_revision', sql`${t.revision} between 1 and 9007199254740991`),
    check('vault_entry_state', sql`${t.state} in ('open', 'captured', 'delivered', 'withdrawn', 'expired')`),
    check('vault_entry_completion', sql`(${t.state} != 'open' or ${t.completion} is null)
      and (${t.state} not in ('captured', 'delivered') or ${t.completion} is not null)
      and (${t.state} != 'delivered' or ${t.receipt} is not null)`) ]);
  return { sessions };
}
export const { sessions: vaultEntrySessions } = vaultEntryTables();

/** Browser custody is separate from generic vault records and job history. */
export function browserProfileTables(namespace = referenceSchemaName) {
  const schema = pgSchema(namespace);
  const snapshots = schema.table('browser_profile_snapshots', {
    profileRef: text('profile_ref').primaryKey(),
    metadata: jsonb('metadata').$type<import('../browser-profile-store.js').BrowserProfileMetadata>().notNull(),
    envelopeVersion: integer('envelope_version').notNull(),
    algorithm: text('algorithm').notNull(),
    keyHandle: text('key_handle').notNull(),
    keyVersion: integer('key_version').notNull(),
    nonce: text('nonce').notNull(),
    ciphertext: text('ciphertext').notNull(),
    tag: text('tag').notNull(),
  }, t => [unique('browser_profile_key_nonce_unique').on(t.keyHandle, t.keyVersion, t.nonce)]);
  // Never delete or restore this ledger from a snapshot backup.
  const states = schema.table('browser_profile_states', {
    profileRef: text('profile_ref').primaryKey(),
    scope: jsonb('scope').$type<JobIdentity['host']>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    authorityEpoch: bigint('authority_epoch', { mode: 'number' }).notNull(),
    status: text('status').$type<'active' | 'revoked' | 'deleted'>().notNull(),
    activeNonce: text('active_nonce'),
  }, t => [check('browser_profile_revision', sql`${t.revision} between 1 and 9007199254740991`),
    check('browser_profile_epoch', sql`${t.authorityEpoch} between 1 and 9007199254740991`),
    check('browser_profile_state', sql`(${t.status} = 'active' and ${t.activeNonce} is not null) or
      (${t.status} in ('revoked', 'deleted') and ${t.activeNonce} is null)`)]);
  return { snapshots, states };
}
export const { snapshots: browserProfileSnapshots, states: browserProfileStates } = browserProfileTables();
