import { validateJobCommand, validateJobSnapshot } from '../contracts/job.js';
import type { JobIdentity, JobState } from '../contracts/job.js';
import type { JobAdmissionStore, JobStoreResult } from './job-store.js';

/** References only. The host must approve their provenance; syntax is not secret detection. */
export interface JobSubmission {
  readonly requestKey: string;
  readonly originTaskRef: string;
  readonly instructionRevision: number;
  readonly operation: { readonly operationRef: string; readonly inputRefs: Readonly<Record<string, string>> };
}
export interface JobAuthority {
  readonly namespaceRef: string;
  readonly host: JobIdentity['host'];
  readonly grantRevision: number;
}
export interface AuthorizedSubmission extends JobAuthority {
  readonly native: JobIdentity['native'];
  readonly origin: JobIdentity['origin'];
}
export interface JobAdmissionHost {
  /** Resolve the authenticated principal from trusted context, approve every input
   * reference and original instruction, and derive all scope/native/origin fields.
   * Called anew even for retries. null/throw denies without retaining a cause. */
  authorizeSubmit(input: JobSubmission): Promise<AuthorizedSubmission | null>;
  /** Authorize this exact job under current ACLs/instructions/grants before lookup.
   * Job ID possession must never suffice. Output references must be safe to release. */
  authorizeInspect(input: { readonly jobId: string }): Promise<JobAuthority | null>;
  /** Host-generated globally unique nonsecret ID; never a caller-provided ID. */
  newJobId(): string;
}
export interface JobInspection {
  readonly jobId: string;
  readonly originTaskRef: string;
  readonly instructionRevision: number;
  readonly state: JobState;
  readonly eventCursor: number;
}
export interface JobAdmissionReceipt extends JobInspection {
  readonly state: 'queued';
  readonly eventCursor: 1;
  readonly replayed: boolean;
}
export interface JobAdmission {
  submit(input: JobSubmission): Promise<JobStoreResult<JobAdmissionReceipt>>;
  inspect(input: { readonly jobId: string }): Promise<JobStoreResult<JobInspection>>;
}

const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
/** Copy decoded records without invoking getters/toJSON. Bounded and synchronous
 * before any await; reject executable objects, cycles, symbols and hidden fields. */
function copy(value: unknown, depth = 0): any {
  if (depth > 8) throw new Error();
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw new Error();
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error();
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!d.enumerable || !('value' in d)) throw new Error();
    result[key] = copy(d.value, depth + 1);
  }
  return result;
}
function exact(v: any, keys: string[]): boolean {
  return !!v && typeof v === 'object' && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
const dummyHost = { tenantRef: 'validation', userRef: 'validation', projectRef: 'validation', accountRef: 'validation', environmentRef: 'validation', purposeRef: 'validation' };
const dummyOrigin = { channelRef: 'validation', routeRef: 'validation', correlationRef: 'validation' };
function identityValid(identity: unknown): boolean { return validateJobCommand({ command: 'inspect', identity }).ok; }
function authorityValid(a: JobAuthority): boolean {
  return ref(a.namespaceRef) && Number.isSafeInteger(a.grantRevision) && a.grantRevision > 0
    && identityValid({ jobId: 'validation', requestKey: 'validation', originTaskRef: 'validation', instructionRevision: 1,
      host: a.host, native: {}, origin: dummyOrigin });
}
function submissionValid(s: JobSubmission): boolean {
  return exact(s, ['requestKey', 'originTaskRef', 'instructionRevision', 'operation'])
    && exact(s.operation, ['operationRef', 'inputRefs']) && ref(s.operation.operationRef)
    && !!s.operation.inputRefs && typeof s.operation.inputRefs === 'object'
    && Object.entries(s.operation.inputRefs).every(([k, v]) => ref(k) && ref(v))
    && identityValid({ jobId: 'validation', requestKey: s.requestKey, originTaskRef: s.originTaskRef,
      instructionRevision: s.instructionRevision, host: dummyHost, native: {}, origin: dummyOrigin });
}
/** Internal shared decoder; intentionally absent from the package entrypoint. */
export function decodeJobSubmission(input: unknown): JobSubmission | null {
  try { const value = copy(input); return submissionValid(value) ? value : null; }
  catch { return null; }
}
function same(a: any, b: any): boolean {
  if (a === b) return true;
  return !!a && !!b && typeof a === 'object' && typeof b === 'object'
    && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function projection(s: { identity: JobIdentity; state: JobState; revision: number }): JobInspection {
  return { jobId: s.identity.jobId, originTaskRef: s.identity.originTaskRef,
    instructionRevision: s.identity.instructionRevision, state: s.state, eventCursor: s.revision };
}

/** No connection, service or background work is created by this factory. */
export function createJobAdmission(host: JobAdmissionHost, store: JobAdmissionStore): JobAdmission {
  return {
    async submit(input) {
      let request: JobSubmission;
      try { request = copy(input); if (!submissionValid(request)) throw new Error(); }
      catch { return { ok: false, code: 'invalid_payload' }; }
      // Keep an independent copy: even an asynchronous host callback cannot alter the binding.
      let authorized: AuthorizedSubmission;
      try {
        authorized = copy(await host.authorizeSubmit(copy(request)));
        if (!exact(authorized, ['namespaceRef', 'host', 'grantRevision', 'native', 'origin']) || !authorityValid(authorized)) throw new Error();
      } catch { return { ok: false, code: 'not_authorized' }; }
      try {
        const identity: JobIdentity = { jobId: host.newJobId(), requestKey: request.requestKey,
          originTaskRef: request.originTaskRef, instructionRevision: request.instructionRevision,
          host: authorized.host, native: authorized.native, origin: authorized.origin };
        if (!identityValid(identity)) return { ok: false, code: 'not_authorized' };
        const result = await store.admit({ namespaceRef: authorized.namespaceRef, grantRevision: authorized.grantRevision,
          operation: request.operation, event: { kind: 'submitted', previousRevision: 0,
            snapshot: { identity, state: 'queued', revision: 1, effects: [] } } });
        if (!result.ok) return { ok: false, code: result.code === 'conflict' ? 'conflict' : 'unavailable' };
        const s = result.value.event.snapshot;
        if (!validateJobSnapshot(s).ok || s.state !== 'queued' || s.revision !== 1) return { ok: false, code: 'unavailable' };
        // Persistence may have waited on another admission. Recheck authority
        // before releasing a receipt; denial does not undo committed work.
        try {
          if (!same(copy(await host.authorizeSubmit(copy(request))), authorized)) throw new Error();
        } catch { return { ok: false, code: 'not_authorized' }; }
        return { ok: true, value: { ...projection(s), state: 'queued', eventCursor: 1, replayed: result.value.replayed } };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
    async inspect(input) {
      let request: { jobId: string };
      try { request = copy(input); if (!exact(request, ['jobId']) || !ref(request.jobId)) throw new Error(); }
      catch { return { ok: false, code: 'invalid_payload' }; }
      let authority: JobAuthority;
      try {
        authority = copy(await host.authorizeInspect(copy(request)));
        if (!exact(authority, ['namespaceRef', 'host', 'grantRevision']) || !authorityValid(authority)) throw new Error();
      } catch { return { ok: false, code: 'not_authorized' }; }
      try {
        const result = await store.inspectAdmission(request.jobId, authority);
        if (!result.ok) return { ok: false, code: ['not_found', 'not_authorized', 'identity_mismatch'].includes(result.code) ? 'not_authorized' : 'unavailable' };
        if (!validateJobSnapshot(result.value).ok || result.value.identity.jobId !== request.jobId) return { ok: false, code: 'unavailable' };
        try {
          if (!same(copy(await host.authorizeInspect(copy(request))), authority)) throw new Error();
        } catch { return { ok: false, code: 'not_authorized' }; }
        return { ok: true, value: projection(result.value) };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
  };
}
