import { validateJobCommand, validateJobSnapshot } from '../contracts/job.js';
import type { JobEventKind, JobIdentity, JobRequirement } from '../contracts/job.js';
import type { JobStoreResult } from './job-store.js';
import { validLeaseAuthority } from './job-lease.js';
import type { JobLeaseAuthority } from './job-lease.js';

const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function exact(v: unknown, keys: readonly string[]): boolean {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(v).length === keys.length
    && keys.every(key => descriptors[key]?.enumerable && 'value' in descriptors[key]);
}

/** The host authenticates the resolver and holds original scope and grant
 * authority stable through the awaited database transaction. */
export interface JobAnswerHost {
  withAnswerAuthority<T>(identity: JobIdentity, resolverRef: string, operation: 'issue' | 'complete' | 'events',
    run: (authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  now(): number;
}
export interface JobChallenge {
  readonly identity: JobIdentity;
  readonly requirement: JobRequirement;
  readonly jobRevision: number;
  readonly expiresAt: number;
  readonly resolverRef: string;
}
export interface JobAnswerDelivery {
  readonly identity: JobIdentity;
  readonly requirementRef: string;
  readonly requirementRevision: number;
  readonly resolverRef: string;
  readonly deliveryKey: string;
  readonly status: 'verified';
  /** Host-approved opaque reference; never a raw credential or authorization code. */
  readonly responseRef: string;
}
export interface JobAnswerReceipt {
  readonly jobId: string;
  readonly eventCursor: number;
  readonly deliveryKey: string;
  readonly replayed: boolean;
  readonly resumable: true;
}
export interface JobAnswerEvent {
  readonly kind: JobEventKind;
  readonly revision: number;
  readonly jobId: string;
}
export interface JobAnswerStore {
  issue(challenge: JobChallenge, authority: JobLeaseAuthority, now: number): Promise<JobStoreResult<void>>;
  complete(delivery: JobAnswerDelivery, authority: JobLeaseAuthority, now: number): Promise<JobStoreResult<JobAnswerReceipt>>;
  events(identity: JobIdentity, authority: JobLeaseAuthority, afterRevision: number, limit: number): Promise<JobStoreResult<readonly JobAnswerEvent[]>>;
}

/** Completion is answer delivery only. A later host-verified resume command
 * queues the same original job; no second task is submitted here. */
export function createJobAnswer(host: JobAnswerHost, store: JobAnswerStore) {
  async function authorized<T>(identity: JobIdentity, resolverRef: string, operation: 'issue' | 'complete' | 'events',
    run: (authority: JobLeaseAuthority, now: number) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    try {
      return await host.withAnswerAuthority(copy(identity), resolverRef, operation, async authority => {
        if (!validLeaseAuthority(authority, identity)) return { ok: false, code: 'not_authorized' };
        const now = host.now();
        if (!integer(now)) return { ok: false, code: 'unavailable' };
        return run(copy(authority), now);
      });
    } catch { return { ok: false, code: 'not_authorized' }; }
  }
  return {
    issue(input: JobChallenge): Promise<JobStoreResult<void>> {
      try {
        if (!exact(input, ['identity', 'requirement', 'jobRevision', 'expiresAt', 'resolverRef'])
          || !validateJobCommand({ command: 'inspect', identity: input.identity }).ok
          || !ref(input.resolverRef) || !integer(input.jobRevision) || input.jobRevision < 1
          || !integer(input.expiresAt)
          || !validateJobSnapshot({ identity: input.identity, revision: input.jobRevision,
            state: 'waiting', requirement: input.requirement, effects: [] }).ok)
          return Promise.resolve({ ok: false, code: 'invalid_payload' });
        const challenge = copy(input);
        return authorized(challenge.identity, challenge.resolverRef, 'issue', (authority, now) =>
          store.issue(challenge, authority, now));
      } catch { return Promise.resolve({ ok: false, code: 'invalid_payload' }); }
    },
    complete(input: JobAnswerDelivery): Promise<JobStoreResult<JobAnswerReceipt>> {
      try {
        if (!exact(input, ['identity', 'requirementRef', 'requirementRevision', 'resolverRef', 'deliveryKey', 'status', 'responseRef'])
          || !ref(input.resolverRef) || !ref(input.deliveryKey) || input.status !== 'verified'
          || !validateJobCommand({ command: 'answer', identity: input.identity, expectedRevision: 1,
            answer: { requirementRef: input.requirementRef, requirementRevision: input.requirementRevision,
              responseRef: input.responseRef } }).ok) return Promise.resolve({ ok: false, code: 'invalid_payload' });
        const delivery = copy(input);
        return authorized(delivery.identity, delivery.resolverRef, 'complete', (authority, now) =>
          store.complete(delivery, authority, now));
      } catch { return Promise.resolve({ ok: false, code: 'invalid_payload' }); }
    },
    events(identity: JobIdentity, resolverRef: string, afterRevision: number, limit = 50): Promise<JobStoreResult<readonly JobAnswerEvent[]>> {
      if (!validateJobCommand({ command: 'inspect', identity }).ok || !ref(resolverRef)
        || !integer(afterRevision) || !integer(limit) || limit < 1 || limit > 100)
        return Promise.resolve({ ok: false, code: 'invalid_payload' });
      return authorized(identity, resolverRef, 'events', authority => store.events(copy(identity), authority, afterRevision, limit));
    },
  };
}
