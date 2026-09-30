import { createHash } from 'node:crypto';
import { canonicalAgentJson } from './agent-state-binding.js';
import type { JobIdentity } from '../contracts/job.js';
import { validateJobCommand } from '../contracts/job.js';
import { resolveScheduleTime } from './assistance-time.js';
import type { LocalScheduleTime } from './assistance-time.js';
export { resolveScheduleTime, assistanceClock } from './assistance-time.js';
export type { LocalScheduleTime } from './assistance-time.js';

export type AssistanceScope = JobIdentity['host'];
export interface AssistanceKey { readonly scope: AssistanceScope; readonly id: string }
export type AssistanceSpec =
  | { readonly kind: 'schedule'; readonly at: LocalScheduleTime; readonly contentRef: string }
  | { readonly kind: 'watch'; readonly adapterRef: string; readonly subjectRef: string;
      readonly contentRef: string; readonly pollMs: number; readonly maxAgeMs: number;
      readonly expiresAt: number };
export type ObservationStatus = 'pending' | 'delayed' | 'matched' | 'cancelled' | 'stale' | 'needs_input';
/** A domain adapter translates observed facts, never estimated arrival timers.
 * subjectRef must identify an exact occurrence (e.g. flight/date/airports), not
 * merely a reusable flight number. No credentials or private payloads here. */
export interface AssistanceObservation {
  readonly subjectRef: string;
  readonly status: ObservationStatus;
  readonly observedAt: number;
  readonly evidenceRef: string;
  readonly detailRef?: string;
}
export interface ObservationAdapter {
  read(key: AssistanceKey, spec: Extract<AssistanceSpec, { kind: 'watch' }>, signal: AbortSignal): Promise<AssistanceObservation>;
}
export interface AssistanceRecord extends AssistanceKey {
  readonly revision: number;
  readonly spec: AssistanceSpec;
  readonly state: 'active' | 'completed' | 'cancelled' | 'expired' | 'revoked';
  readonly nextAt: number;
  readonly observed?: AssistanceObservation;
}
/** The inbox fact is canonical. Push/email is a separate uncertain effect. */
export interface NotificationFact extends AssistanceKey {
  readonly factId: string;
  readonly kind: 'due' | ObservationStatus | 'expired';
  readonly contentRef: string;
  readonly evidenceRef: string;
  readonly createdAt: number;
}
export interface AssistanceTransaction {
  get(): Promise<AssistanceRecord | null>;
  put(record: AssistanceRecord): Promise<void>;
  receipt(commandId: string): Promise<{ digest: string; record: AssistanceRecord } | null>;
  saveReceipt(commandId: string, digest: string, record: AssistanceRecord): Promise<void>;
  /** Unique factId; identical retry returns original, conflicting content rejects. */
  notify(fact: NotificationFact): Promise<void>;
}
export interface AssistanceStore {
  /** Serialize the whole callback against edits, cancellations and other workers;
   * commit record, command receipt and facts atomically, or roll everything back. */
  transaction<T>(key: AssistanceKey, run: (tx: AssistanceTransaction) => Promise<T>): Promise<T>;
  /** Internal worker references only. Fair ordering by nextAt then key. */
  due(now: number, limit: number): Promise<readonly AssistanceKey[]>;
  list(scope: AssistanceScope, after: string | null, limit: number): Promise<readonly AssistanceRecord[]>;
  facts(scope: AssistanceScope, after: string | null, limit: number): Promise<readonly NotificationFact[]>;
}
export interface AssistanceHost {
  now(): number;
  /** Derive scope on server. Recheck current account/membership/environment and
   * saved mandate for EVERY operation; hold authorization through commit.
   * Background work uses a durable mandate, never a stored browser session.
   * For a permanently revoked mandate, observe must call run(false) while
   * holding its authority lock: SDK persists a terminal revoked record. Throw
   * for transient authorization-service failures; never restore a revoked
   * mandate merely because account access later returns. */
  withAuthority<T>(key: AssistanceKey, operation: 'manage' | 'observe' | 'read', run: (authorized?: boolean) => Promise<T>): Promise<T>;
}
export const assistanceDigest = (value: unknown): string => createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
function ref(value: string) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw Error('invalid_reference'); }
function keyValid(key: AssistanceKey) {
  ref(key.id);
  if (!validateJobCommand({ command: 'inspect', identity: {
    jobId: 'scope-check', requestKey: 'scope-check', originTaskRef: 'scope-check', instructionRevision: 1,
    host: key.scope, native: {}, origin: { channelRef: 'scope-check', routeRef: 'scope-check', correlationRef: 'scope-check' },
  } }).ok) throw Error('invalid_scope');
}
function positive(n: number) { if (!Number.isSafeInteger(n) || n <= 0) throw Error('invalid_interval'); }
async function boundedRead(adapter: ObservationAdapter, key: AssistanceKey,
  spec: Extract<AssistanceSpec, { kind: 'watch' }>, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => adapter.read(clone(key), clone(spec), controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('observation_unavailable')); }, timeoutMs); })]);
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Shared schedule/condition state machine. The timer is a wake hint only;
 * durable storage controls every transition. Construction starts no service. */
export function createAssistance(deps: {
  readonly store: AssistanceStore; readonly host: AssistanceHost;
  readonly adapters: Readonly<Record<string, ObservationAdapter>>;
  readonly batchSize: number; readonly readTimeoutMs: number;
}) {
  positive(deps.batchSize); positive(deps.readTimeoutMs);
  function transact<T>(key: AssistanceKey, operation: 'manage' | 'observe' | 'read', run: (tx: AssistanceTransaction, authorized: boolean) => Promise<T>) {
    key = clone(key);
    keyValid(key);
    return deps.host.withAuthority(clone(key), operation, (authorized = true) => {
      if (!authorized && operation !== 'observe') throw Error('not_authorized');
      return deps.store.transaction(key, tx => run(tx, authorized));
    });
  }
  async function command(key: AssistanceKey, commandId: string, payload: unknown,
    apply: (current: AssistanceRecord | null) => AssistanceRecord) {
    key = clone(key); ref(commandId);
    const digest = assistanceDigest(payload);
    return transact(key, 'manage', async tx => {
      const prior = await tx.receipt(commandId);
      if (prior) {
        if (prior.digest !== digest) throw Error('assistance_conflict');
        return prior.record;
      }
      const record = apply(await tx.get());
      await tx.put(record); await tx.saveReceipt(commandId, digest, record);
      return clone(record);
    });
  }
  function nextAt(spec: AssistanceSpec): number {
    ref(spec.contentRef);
    const now = deps.host.now();
    if (spec.kind === 'schedule') return resolveScheduleTime(spec.at, now);
    if (spec.kind !== 'watch') throw Error('invalid_assistance_spec');
    ref(spec.adapterRef); ref(spec.subjectRef); positive(spec.pollMs); positive(spec.maxAgeMs);
    if (!Object.hasOwn(deps.adapters, spec.adapterRef)) throw Error('observation_adapter_unavailable');
    if (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= now) throw Error('invalid_watch_expiry');
    return now;
  }
  async function tickOne(key: AssistanceKey) {
    key = clone(key);
    return transact(key, 'observe', async (tx, authorized) => {
      let record = await tx.get();
      const now = deps.host.now();
      if (!record || record.state !== 'active' || record.nextAt > now) return;
      if (!authorized) {
        await tx.put({ ...record, state: 'revoked', revision: record.revision + 1 });
        return;
      }
      const original = record;
      const notify = async (kind: NotificationFact['kind'], evidenceRef: string, occurrence: unknown) => {
        await tx.notify({ ...key, factId: `notice:${assistanceDigest([key, occurrence])}`, kind,
          contentRef: original.spec.contentRef, evidenceRef, createdAt: now });
      };
      if (record.spec.kind === 'schedule') {
        await notify('due', `schedule:${record.revision}`, ['due', record.revision]);
        record = { ...record, state: 'completed' };
      } else if (record.spec.expiresAt <= now) {
        await notify('expired', 'watch:expired', ['expired']);
        record = { ...record, state: 'expired' };
      } else {
        const spec = record.spec;
        let observed: AssistanceObservation;
        try {
          const adapter = deps.adapters[spec.adapterRef];
          if (!adapter) throw Error('observation_adapter_unavailable');
          observed = await boundedRead(adapter, key, spec, deps.readTimeoutMs);
          ref(observed.evidenceRef);
          if (observed.detailRef !== undefined) ref(observed.detailRef);
          if (observed.subjectRef !== spec.subjectRef || !Number.isSafeInteger(observed.observedAt)
            || observed.observedAt > deps.host.now()
            || !['pending', 'delayed', 'matched', 'cancelled', 'stale', 'needs_input'].includes(observed.status)) throw Error('invalid_observation');
          if (now - observed.observedAt > spec.maxAgeMs
            || (record.observed && observed.observedAt < record.observed.observedAt)) throw Error('stale_observation');
        } catch {
          // Unavailable/stale observations cannot become a condition match.
          observed = { subjectRef: spec.subjectRef, status: 'stale', observedAt: record.observed?.observedAt ?? 0,
            evidenceRef: 'observation:unverified' };
        }
        if (observed.status !== 'pending' && observed.status !== record.observed?.status) {
          await notify(observed.status, observed.evidenceRef, [observed.status, observed.evidenceRef]);
        }
        record = { ...record, observed,
          nextAt: Math.min(deps.host.now() + spec.pollMs, spec.expiresAt),
          state: observed.status === 'matched' ? 'completed' : observed.status === 'cancelled' ? 'cancelled' : 'active' };
      }
      await tx.put({ ...record, revision: record.revision + 1 });
    });
  }
  return {
    create(key: AssistanceKey, commandId: string, input: AssistanceSpec) {
      key = clone(key);
      const spec = clone(input);
      return command(key, commandId, ['create', spec], current => {
        if (current) throw Error('assistance_conflict');
        return { ...clone(key), spec, revision: 1, state: 'active', nextAt: nextAt(spec) };
      });
    },
    reschedule(key: AssistanceKey, commandId: string, expectedRevision: number, at: LocalScheduleTime) {
      at = clone(at);
      return command(key, commandId, ['reschedule', expectedRevision, at], current => {
        if (!current || current.state !== 'active' || current.revision !== expectedRevision || current.spec.kind !== 'schedule') throw Error('assistance_conflict');
        const spec = { ...current.spec, at };
        return { ...current, spec, nextAt: nextAt(spec), revision: current.revision + 1 };
      });
    },
    cancel(key: AssistanceKey, commandId: string, expectedRevision: number) {
      return command(key, commandId, ['cancel', expectedRevision], current => {
        if (!current || current.revision !== expectedRevision) throw Error('assistance_conflict');
        if (current.state !== 'active') return current;
        return { ...current, revision: current.revision + 1, state: 'cancelled' };
      });
    },
    get(key: AssistanceKey) { return transact(clone(key), 'read', tx => tx.get()); },
    list(scope: AssistanceScope, after: string | null = null, limit = deps.batchSize) {
      const key = { scope: clone(scope), id: 'list' }; keyValid(key); positive(limit);
      return deps.host.withAuthority(key, 'read', (authorized = true) => {
        if (!authorized) throw Error('not_authorized');
        return deps.store.list(key.scope, after, limit);
      });
    },
    facts(scope: AssistanceScope, after: string | null = null, limit = deps.batchSize) {
      const key = { scope: clone(scope), id: 'inbox' }; keyValid(key); positive(limit);
      return deps.host.withAuthority(key, 'read', (authorized = true) => {
        if (!authorized) throw Error('not_authorized');
        return deps.store.facts(key.scope, after, limit);
      });
    },
    tickOne,
    async tick() {
      const results: { key: AssistanceKey; outcome: 'checked' | 'unavailable' }[] = [];
      for (const key of await deps.store.due(deps.host.now(), deps.batchSize)) {
        try { await tickOne(key); results.push({ key, outcome: 'checked' }); }
        catch { results.push({ key, outcome: 'unavailable' }); }
      }
      return results;
    },
  };
}

/** Optional lifecycle driver for the existing application server/worker role.
 * A timer is only a wake hint; storage remains authoritative across processes.
 * Closing the worker drains local work without cancelling durable mandates. */
export function createAssistanceWorker(deps: {
  readonly assistance: Pick<ReturnType<typeof createAssistance>, 'tick'>;
  readonly notifications?: { drain(): Promise<unknown> };
  readonly intervalMs: number;
  readonly onError?: () => void;
}) {
  positive(deps.intervalMs);
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const wake = () => {
    pending ??= Promise.resolve().then(async () => {
      try { await deps.assistance.tick(); await deps.notifications?.drain(); }
      catch { try { deps.onError?.(); } catch { /* diagnostics are not authority */ } }
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    wake,
    start() {
      if (timer) return;
      timer = setInterval(() => { void wake(); }, deps.intervalMs); timer.unref();
      void wake();
    },
    async stop() { clearInterval(timer); timer = undefined; await pending; },
  };
}
