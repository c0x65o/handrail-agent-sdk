import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgSchema, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import type { JobIdentity } from '../../../src/contracts/job.js';
import type { VaultItem } from '../../../src/contracts/vault.js';

import { agentPostgresDefaultSchema as referenceSchemaName, journalTables } from '../../../src/server/postgres/db/schema.js';
export { agentPostgresDefaultSchema as referenceSchemaName, journalTables, agentStateTables, jobs, events, deliveries, checkpoints, admissions, cancellationEvidence, challenges, answerDeliveries, effects, agentRunStates } from '../../../src/server/postgres/db/schema.js';

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

/** Immutable admissions, current private revisions, and canonical receipt history. */
export function connectionTables(namespace = referenceSchemaName) {
  const schema = pgSchema(namespace);
  const connections = schema.table('connections', {
    connectionRef: text('connection_ref').primaryKey(),
    scope: jsonb('scope').$type<JobIdentity['host']>().notNull(),
    providerRef: text('provider_ref').notNull(),
    capabilityDigest: text('capability_digest').notNull(),
    recipeVersion: text('recipe_version').notNull(),
    evidenceMode: text('evidence_mode').$type<'fixture' | 'provider'>().notNull(),
    request: jsonb('request').$type<import('../../../src/contracts/connection.js').ConnectionEnsureInput>().notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    snapshot: jsonb('snapshot').$type<import('../../../src/server/connection-store.js').ConnectionSnapshot>().notNull(),
  }, t => [unique('connections_logical_identity').on(t.scope, t.providerRef, t.capabilityDigest, t.recipeVersion, t.evidenceMode),
    check('connections_revision', sql`${t.revision} between 1 and 9007199254740991`),
    check('connections_mode', sql`${t.evidenceMode} in ('fixture', 'provider')`)]);
  const revisions = schema.table('connection_revisions', {
    connectionRef: text('connection_ref').notNull().references(() => connections.connectionRef),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    command: jsonb('command').$type<import('../connection-store.js').ConnectionMutation>().notNull(),
    snapshot: jsonb('snapshot').$type<import('../../../src/server/connection-store.js').ConnectionSnapshot>().notNull(),
  }, t => [primaryKey({ columns: [t.connectionRef, t.revision] }),
    check('connection_revisions_positive', sql`${t.revision} between 1 and 9007199254740991`)]);
  const receipts = schema.table('connection_receipts', {
    receiptRef: text('receipt_ref').primaryKey(),
    connectionRef: text('connection_ref').notNull().references(() => connections.connectionRef),
    credentialRevision: bigint('credential_revision', { mode: 'number' }).notNull(),
    grantRevision: bigint('grant_revision', { mode: 'number' }).notNull(),
    evidence: jsonb('evidence').$type<import('../../../src/contracts/connection.js').ConnectionEvidence>().notNull(),
  }, t => [check('connection_receipt_revisions', sql`${t.credentialRevision} between 1 and 9007199254740991 and ${t.grantRevision} between 1 and 9007199254740991`)]);
  return { connections, revisions, receipts };
}
export const { connections, revisions: connectionRevisions, receipts: connectionReceipts } = connectionTables();
