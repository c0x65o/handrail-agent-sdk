import { canonicalAgentJson } from '../agent-state-binding.js';
import { eq } from 'drizzle-orm';
import { validateJobTransition } from '../../contracts/job.js';
import type { JobEvent, JobIdentity, JobSnapshot } from '../../contracts/job.js';
import type { AgentCheckpoint, AgentStateStore } from '../agent-runtime.js';
import { sameLeaseValue, validLeaseAuthority } from '../job-lease.js';
import type { JobLeaseAuthority } from '../job-lease.js';
import type { JobStoreErrorCode, JobStoreResult } from '../job-store.js';
import { agentStateTables, journalTables } from './db/schema.js';
import type { AgentPostgresDatabase } from './db/database.js';
import { createJobJournal } from './job-journal.js';
import { copyAppendFence, matchesJobFence, releasedLease } from './job-lease-fence.js';
import { open, seal } from './private-envelope.js';
import { openPages, sealPages } from './paged-envelope.js';

import type { AgentStateKeys } from './keys.js';
export type { AgentStateKeys } from './keys.js';
class Rejected extends Error { constructor(readonly code: JobStoreErrorCode) { super(code); } }
const reject = (code: JobStoreErrorCode): never => { throw new Rejected(code); };
const value = <T>(r: JobStoreResult<T>): T => r.ok ? r.value : reject(r.code);
async function safe<T>(run: () => Promise<T>): Promise<JobStoreResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (e) { return { ok: false, code: e instanceof Rejected ? e.code : 'unavailable' }; }
}
export function createAgentStateStore(db: AgentPostgresDatabase, keys: AgentStateKeys, namespace?: string, checkpointQuotaBytes?: number): AgentStateStore {
  if (checkpointQuotaBytes !== undefined && (!Number.isSafeInteger(checkpointQuotaBytes) || checkpointQuotaBytes < 65_536)) throw Error('INVALID_CHECKPOINT_QUOTA');
  const tables = journalTables(namespace), { states } = agentStateTables(namespace);
  type Tx = Parameters<Parameters<AgentPostgresDatabase['transaction']>[0]>[0];
  type Row = typeof states.$inferSelect;
  const aad = (identity: JobIdentity, row: Pick<Row, 'version' | 'grantRevision' | 'keyRef'>) =>
    Buffer.from(canonicalAgentJson(['agent-run-state-v1', identity, row.version, row.grantRevision, row.keyRef]));
  async function lock(tx: Tx, identity: JobIdentity, authority: JobLeaseAuthority) {
    if (!validLeaseAuthority(authority, identity)) reject('not_authorized');
    const [head] = await tx.select().from(tables.jobs).where(eq(tables.jobs.jobId, identity.jobId)).for('update');
    if (!head || !sameLeaseValue(head.identity, identity) || head.cancellationEpoch > authority.cancellationRevision) reject('not_authorized');
    const [row] = await tx.select().from(states).where(eq(states.jobId, identity.jobId));
    if (row && row.grantRevision !== authority.grantRevision) reject('not_authorized');
    return { head, row };
  }
  async function decode(identity: JobIdentity, row: Row): Promise<AgentCheckpoint> {
    const key = await keys.resolve(row.keyRef);
    const result = ('format' in row.envelope
      ? openPages(row.envelope, key, aad(identity, row), checkpointQuotaBytes ?? 65_536)
      : open(row.envelope, key, aad(identity, row))) as AgentCheckpoint;
    if (!result || result.version !== row.version || typeof result.definitionRef !== 'string'
      || !Number.isSafeInteger(result.dispatches) || !(typeof result.input === 'string' || Array.isArray(result.input))
      || !result.results || (result.state !== undefined && typeof result.state !== 'string')) reject('invalid_checkpoint');
    return result;
  }
  async function write(tx: Tx, identity: JobIdentity, checkpoint: AgentCheckpoint, grantRevision: number) {
    // Bound private custody independently of caller-provided runtime limits.
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > (checkpointQuotaBytes ?? 65_536)) reject('invalid_checkpoint');
    const key = await keys.current();
    if (typeof key.ref !== 'string' || key.ref.length === 0
      || key.key.type !== 'secret' || key.key.symmetricKeySize !== 32) reject('invalid_checkpoint');
    const row = { jobId: identity.jobId, version: checkpoint.version, grantRevision, keyRef: key.ref };
    const record = { ...row, envelope: checkpointQuotaBytes === undefined ? seal(checkpoint, key.key, aad(identity, row)) : sealPages(checkpoint, key.key, aad(identity, row), checkpointQuotaBytes) };
    await tx.insert(states).values(record).onConflictDoUpdate({ target: states.jobId, set: record });
  }
  return {
    checkpointQuotaBytes,
    load(identity, authority) {
      return safe(() => db.transaction(async tx => {
        const { row } = await lock(tx, identity, authority);
        return row ? decode(identity, row) : null;
      }));
    },
    commit(input, expectedVersion, inputCheckpoint, change, inputAccess) {
      const identity = structuredClone(input), checkpoint = structuredClone(inputCheckpoint);
      return safe(async () => {
        const access = copyAppendFence(inputAccess);
        return db.transaction(async tx => {
          const { head, row } = await lock(tx, identity, access.authority);
          if (!matchesJobFence(head, access)) reject('lease_lost');
          if ((row?.version ?? 0) !== expectedVersion || checkpoint.version !== expectedVersion + 1) reject('conflict');
          const current = value(await createJobJournal(tx, tables).load(identity, false));
          if (current.state !== 'running') reject('invalid_transition');
          const base = { identity, revision: current.revision + 1, effects: current.effects };
          if (change.kind !== 'checkpoint') {
            let snapshot: JobSnapshot;
            if (change.kind === 'waiting') snapshot = { ...base, state: 'waiting', requirement: change.requirement };
            else if (change.kind === 'failed') snapshot = { ...base, state: 'failed', error: { code: 'execution_failed', correlationRef: identity.origin.correlationRef } };
            else {
              if (current.effects.some(e => e.outcome === 'unknown') || typeof checkpoint.output !== 'string') reject('effect_conflict');
              snapshot = { ...base, state: 'succeeded', receipt: { receiptRef: change.receiptRef, verification: 'host_verified', jobId: identity.jobId, revision: base.revision } };
            }
            value(await createJobJournal(tx, tables).append({ kind: change.kind, previousRevision: current.revision, snapshot }, access));
            await tx.update(tables.jobs).set(releasedLease).where(eq(tables.jobs.jobId, identity.jobId));
          }
          await write(tx, identity, checkpoint, access.authority.grantRevision);
          if (!matchesJobFence(head, access)) reject('lease_lost');
        });
      });
    },
    resume(input, expectedRevision, resolution, authority) {
      const identity = structuredClone(input), resolved = structuredClone(resolution);
      return safe(() => db.transaction(async tx => {
        const { head, row } = await lock(tx, identity, authority);
        if (!row) reject('not_found');
        const current = value(await createJobJournal(tx, tables).load(identity, false));
        if (current.state !== 'waiting' || current.revision !== expectedRevision) return reject('invalid_transition');
        const checkpoint = await decode(identity, row);
        const snapshot: JobSnapshot = { identity, state: 'queued', revision: current.revision + 1, effects: current.effects };
        const event: JobEvent = { kind: 'resumed', previousRevision: current.revision, snapshot,
          command: { command: 'resume', identity, expectedRevision, requirementRef: current.requirement.requirementRef,
            requirementRevision: current.requirement.revision, resolutionReceiptRef: resolved.receiptRef } };
        value(validateJobTransition(current, event));
        // Waiting jobs have no executor lease. This host-authorized, row-locked
        // transition is the sole exception; it grants no execution authority.
        await tx.insert(tables.events).values({ jobId: identity.jobId, revision: snapshot.revision, event });
        await tx.update(tables.jobs).set({ revision: snapshot.revision, ...releasedLease }).where(eq(tables.jobs.jobId, head.jobId));
        await tx.insert(tables.checkpoints).values({ jobId: head.jobId, version: 1, revision: snapshot.revision, snapshot })
          .onConflictDoUpdate({ target: tables.checkpoints.jobId, set: { version: 1, revision: snapshot.revision, snapshot } });
        await write(tx, identity, { ...checkpoint, version: checkpoint.version + 1, resolution: resolved }, authority.grantRevision);
      }));
    },
  };
}
