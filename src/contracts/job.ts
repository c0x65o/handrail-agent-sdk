/**
 * Pure wire contracts, not an execution owner. The host derives identities,
 * authorizes every command, verifies receipts, and atomically persists revisions.
 * References must be host-approved nonsecret identifiers, never credentials,
 * URLs or secret-derived hashes. Syntax validation cannot prove text secret-free.
 * Grant/receipt possession confers no authority. See docs/job-contract.md.
 */
export type JobState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type JobErrorCode = 'invalid_payload' | 'invalid_revision' | 'identity_mismatch'
  | 'invalid_transition' | 'requirement_mismatch' | 'effect_conflict'
  | 'not_authorized' | 'unavailable' | 'observation_withheld' | 'execution_failed';
export type JobValidation<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JobErrorCode };
export interface JobError {
  readonly code: JobErrorCode;
  readonly correlationRef: string;
}
export interface JobQueueRef {
  readonly queueRef: string;
  readonly messageRef: string;
}
/** Native identities are optional when the host has no corresponding object. */
export interface JobNativeRefs {
  readonly requestRef?: string;
  readonly threadRef?: string;
  readonly assistantProjectRef?: string;
  readonly objectiveRef?: string;
  readonly rootTaskRef?: string;
  readonly outcomeRef?: string;
  readonly backingWorkRequestRef?: string;
  readonly childWorkRequestRef?: string;
  readonly turnRef?: string;
  readonly runRef?: string;
  readonly actionRef?: string;
  readonly operationRef?: string;
  readonly effectRef?: string;
  readonly sourceQueue?: JobQueueRef;
}
export interface JobIdentity {
  readonly jobId: string;
  readonly originTaskRef: string;
  readonly requestKey: string;
  readonly instructionRevision: number;
  readonly host: {
    readonly tenantRef: string;
    readonly userRef: string;
    readonly projectRef: string;
    readonly accountRef: string;
    readonly environmentRef: string;
    readonly purposeRef: string;
  };
  readonly native: JobNativeRefs;
  readonly origin: {
    readonly channelRef: string;
    readonly routeRef: string;
    readonly correlationRef: string;
  };
}
export interface JobRequirement {
  readonly kind: 'approval' | 'secure_input' | 'provider' | 'host' | 'reconciliation';
  readonly requirementRef: string;
  readonly revision: number;
  readonly actor: { readonly kind: 'user' | 'provider' | 'host'; readonly actorRef: string };
}
export interface JobAnswer {
  readonly requirementRef: string;
  readonly requirementRevision: number;
  /** Reference to host-accepted private input/decision; never the answer bytes. */
  readonly responseRef: string;
}
export interface JobReceipt {
  readonly receiptRef: string;
  readonly verification: 'host_verified';
  readonly jobId: string;
  readonly revision: number;
}
export interface JobEffect {
  readonly actionRef: string;
  readonly operationRef: string;
  readonly effectRef: string;
  readonly outcome: 'unknown' | 'verified' | 'not_applied';
}
interface JobBase {
  readonly identity: JobIdentity;
  readonly revision: number;
  readonly effects: readonly JobEffect[];
}
export type JobSnapshot = JobBase & (
  | { readonly state: 'queued' | 'running' }
  | { readonly state: 'waiting'; readonly requirement: JobRequirement; readonly answer?: JobAnswer }
  | { readonly state: 'succeeded'; readonly receipt: JobReceipt }
  | { readonly state: 'failed'; readonly error: JobError }
  | { readonly state: 'cancelled'; readonly cancellation: { readonly reason: 'explicit_stop'; readonly actorRef: string } }
);
export interface JobDelivery {
  readonly attemptRef: string;
  readonly callbackRef?: string;
  readonly queue?: JobQueueRef;
}
export type JobEventKind = 'submitted' | 'started' | 'waiting' | 'answered' | 'resumed'
  | 'succeeded' | 'failed' | 'cancelled' | 'effects_recorded';
/** First event is submitted, 0 -> 1; every later event advances exactly one. */
interface JobEventBase {
  readonly previousRevision: number;
  readonly snapshot: JobSnapshot;
  readonly delivery?: JobDelivery;
}
export type JobEvent = JobEventBase & (
  | { readonly kind: 'answered'; readonly command: AnswerJobCommand }
  | { readonly kind: 'resumed'; readonly command: ResumeJobCommand }
  | { readonly kind: 'cancelled'; readonly command: CancelJobCommand }
  | { readonly kind: Exclude<JobEventKind, 'answered' | 'resumed' | 'cancelled'> }
);
interface JobTarget { readonly identity: JobIdentity }
interface JobMutation extends JobTarget { readonly expectedRevision: number }
export type SubmitJobCommand = JobTarget & { readonly command: 'submit' };
export type InspectJobCommand = JobTarget & { readonly command: 'inspect' };
export type EventsJobCommand = JobTarget & { readonly command: 'events'; readonly afterRevision: number };
export type AnswerJobCommand = JobMutation & { readonly command: 'answer'; readonly answer: JobAnswer };
export type ResumeJobCommand = JobMutation & {
  readonly command: 'resume'; readonly requirementRef: string; readonly requirementRevision: number;
  /** Host must verify resolution and current authority, even if an answer exists. */
  readonly resolutionReceiptRef: string;
};
export type CancelJobCommand = JobMutation & { readonly command: 'cancel'; readonly reason: 'explicit_stop' };
export type JobCommand = SubmitJobCommand | InspectJobCommand | EventsJobCommand
  | AnswerJobCommand | ResumeJobCommand | CancelJobCommand;
export type JobResult =
  | { readonly command: JobCommand['command']; readonly ok: false; readonly error: JobError }
  | { readonly command: 'inspect'; readonly ok: true; readonly snapshot: JobSnapshot }
  | { readonly command: 'submit' | 'resume'; readonly ok: true; readonly snapshot: JobSnapshot & { readonly state: 'queued' } }
  | { readonly command: 'answer'; readonly ok: true; readonly snapshot: JobSnapshot & { readonly state: 'waiting'; readonly answer: JobAnswer } }
  | { readonly command: 'cancel'; readonly ok: true; readonly snapshot: JobSnapshot & { readonly state: 'cancelled' } }
  | { readonly command: 'events'; readonly ok: true; readonly baseline: JobSnapshot; readonly events: readonly JobEvent[] };
/** Disposing observation is local cleanup. It is deliberately not a JobCommand. */
export interface JobObservation { dispose(): void }

type Check = (value: unknown) => boolean;
type RecordValue = Record<string, unknown>;
const errorCodes: readonly JobErrorCode[] = ['invalid_payload', 'invalid_revision', 'identity_mismatch',
  'invalid_transition', 'requirement_mismatch', 'effect_conflict', 'not_authorized',
  'unavailable', 'observation_withheld', 'execution_failed'];
const ref: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const revision: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive: Check = v => revision(v) && (v as number) > 0;
const oneOf = (...values: readonly unknown[]): Check => v => values.includes(v);
function record(v: unknown): v is RecordValue {
  return v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
/** Exact own data properties only: reject getters, symbols, hidden and unknown keys. */
function shape(v: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): boolean {
  if (!record(v)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(v).every(key => {
    if (typeof key !== 'string') return false;
    const d = descriptors[key];
    const check = Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
    return !!check && !!d.enumerable && 'value' in d && check(d.value);
  }) && Object.keys(required).every(key => Object.hasOwn(descriptors, key));
}
function list(v: unknown, check: Check): v is unknown[] {
  if (!Array.isArray(v)) return false;
  // Dense JSON arrays only, with no hidden payload properties or accessors.
  const keys = Reflect.ownKeys(v);
  return keys.length === v.length + 1 && keys.every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const d = Object.getOwnPropertyDescriptor(v, key)!;
    return Number(key) < v.length && d.enumerable && 'value' in d && check(d.value);
  });
}
const queue: Check = v => shape(v, { queueRef: ref, messageRef: ref });
const native: Check = v => shape(v, {}, {
  requestRef: ref, threadRef: ref, assistantProjectRef: ref, objectiveRef: ref, rootTaskRef: ref,
  outcomeRef: ref, backingWorkRequestRef: ref, childWorkRequestRef: ref, turnRef: ref, runRef: ref,
  actionRef: ref, operationRef: ref, effectRef: ref, sourceQueue: queue,
});
const identity: Check = v => shape(v, {
  jobId: ref, originTaskRef: ref, requestKey: ref, instructionRevision: positive,
  host: v => shape(v, { tenantRef: ref, userRef: ref, projectRef: ref, accountRef: ref, environmentRef: ref, purposeRef: ref }),
  native, origin: v => shape(v, { channelRef: ref, routeRef: ref, correlationRef: ref }),
});
const requirement: Check = v => shape(v, {
  kind: oneOf('approval', 'secure_input', 'provider', 'host', 'reconciliation'), requirementRef: ref, revision: positive,
  actor: v => shape(v, { kind: oneOf('user', 'provider', 'host'), actorRef: ref }),
});
const answer: Check = v => shape(v, { requirementRef: ref, requirementRevision: positive, responseRef: ref });
const receipt: Check = v => shape(v, { receiptRef: ref, verification: oneOf('host_verified'), jobId: ref, revision: positive });
const error: Check = v => shape(v, { code: oneOf(...errorCodes), correlationRef: ref });
const effect: Check = v => shape(v, { actionRef: ref, operationRef: ref, effectRef: ref, outcome: oneOf('unknown', 'verified', 'not_applied') });
const delivery: Check = v => shape(v, { attemptRef: ref }, { callbackRef: ref, queue });
function matchesRequirement(a: JobAnswer, r: JobRequirement): boolean {
  return a.requirementRef === r.requirementRef && a.requirementRevision === r.revision;
}
function snapshot(v: unknown): v is JobSnapshot {
  if (!record(v)) return false;
  const state = Object.getOwnPropertyDescriptor(v, 'state')?.value;
  const base = { identity, revision: positive, effects: (v: unknown) => list(v, effect), state: oneOf(state) };
  let valid = false;
  switch (state) {
    case 'queued': case 'running': valid = shape(v, base); break;
    case 'waiting': valid = shape(v, { ...base, requirement }, { answer }); break;
    case 'succeeded': valid = shape(v, { ...base, receipt }); break;
    case 'failed': valid = shape(v, { ...base, error }); break;
    case 'cancelled': valid = shape(v, { ...base, cancellation: v => shape(v, { reason: oneOf('explicit_stop'), actorRef: ref }) }); break;
  }
  if (!valid) return false;
  const s = v as unknown as JobSnapshot;
  if (new Set(s.effects.map(e => e.effectRef)).size !== s.effects.length) return false;
  if (s.state === 'waiting' && s.answer && !matchesRequirement(s.answer, s.requirement)) return false;
  return s.state !== 'succeeded' || (s.receipt.jobId === s.identity.jobId && s.receipt.revision === s.revision
    && s.effects.every(e => e.outcome !== 'unknown'));
}
function command(v: unknown): v is JobCommand {
  if (!record(v)) return false;
  const kind = Object.getOwnPropertyDescriptor(v, 'command')?.value;
  const base = { command: oneOf(kind), identity };
  const mutation = { ...base, expectedRevision: positive };
  switch (kind) {
    case 'submit': case 'inspect': return shape(v, base);
    case 'events': return shape(v, { ...base, afterRevision: revision });
    case 'answer': return shape(v, { ...mutation, answer });
    case 'resume': return shape(v, { ...mutation, requirementRef: ref, requirementRevision: positive, resolutionReceiptRef: ref });
    case 'cancel': return shape(v, { ...mutation, reason: oneOf('explicit_stop') });
    default: return false;
  }
}
function event(v: unknown): v is JobEvent {
  if (!record(v)) return false;
  const kind = Object.getOwnPropertyDescriptor(v, 'kind')?.value;
  const bound = kind === 'answered' || kind === 'resumed' || kind === 'cancelled';
  if (!shape(v, { ...(bound ? { command } : {}), kind: oneOf('submitted', 'started', 'waiting', 'answered', 'resumed', 'succeeded', 'failed', 'cancelled', 'effects_recorded'),
    previousRevision: revision, snapshot }, { delivery })) return false;
  const e = v as unknown as JobEvent;
  if ('command' in e && (!same(e.command.identity, e.snapshot.identity)
    || e.command.expectedRevision !== e.previousRevision
    || e.command.command !== (e.kind === 'answered' ? 'answer' : e.kind === 'resumed' ? 'resume' : 'cancel'))) return false;
  if (e.snapshot.revision !== e.previousRevision + 1) return false;
  switch (e.kind) {
    case 'submitted': return e.previousRevision === 0 && e.snapshot.state === 'queued' && e.snapshot.effects.length === 0;
    case 'started': return e.previousRevision > 0 && e.snapshot.state === 'running';
    case 'waiting': return e.previousRevision > 0 && e.snapshot.state === 'waiting' && !e.snapshot.answer;
    case 'answered': return e.previousRevision > 0 && e.snapshot.state === 'waiting' && !!e.snapshot.answer && same(e.command.answer, e.snapshot.answer);
    case 'resumed': return e.previousRevision > 0 && e.snapshot.state === 'queued';
    case 'effects_recorded': return e.previousRevision > 0 && e.snapshot.state === 'running';
    default: return e.previousRevision > 0 && e.snapshot.state === e.kind;
  }
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!record(a) || !record(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function failure(code: JobErrorCode): { readonly ok: false; readonly code: JobErrorCode } { return { ok: false, code }; }
function checked<T>(v: unknown, check: Check): JobValidation<T> {
  try { return check(v) ? { ok: true, value: v as T } : failure('invalid_payload'); }
  catch { return failure('invalid_payload'); } // Never surface raw getters/proxy/provider errors.
}
export function validateJobSnapshot(value: unknown): JobValidation<JobSnapshot> { return checked(value, snapshot); }
export function validateJobEvent(value: unknown): JobValidation<JobEvent> { return checked(value, event); }

/** With current supplied, also checks identity, optimistic revision and waiting binding. */
export function validateJobCommand(value: unknown, current?: unknown): JobValidation<JobCommand> {
  const parsed = checked<JobCommand>(value, command);
  if (!parsed.ok || current === undefined) return parsed;
  const state = validateJobSnapshot(current);
  if (!state.ok) return state;
  const c = parsed.value, s = state.value;
  if (!same(c.identity, s.identity)) return failure('identity_mismatch');
  if (c.command === 'submit') return failure('invalid_transition');
  if (c.command === 'inspect') return parsed;
  if (c.command === 'events') return c.afterRevision <= s.revision ? parsed : failure('invalid_revision');
  if (c.expectedRevision !== s.revision) return failure('invalid_revision');
  if (s.state === 'succeeded' || s.state === 'failed' || s.state === 'cancelled') return failure('invalid_transition');
  if (c.command === 'cancel') return parsed;
  if (s.state !== 'waiting') return failure('invalid_transition');
  if (c.command === 'answer') {
    if (s.answer || !matchesRequirement(c.answer, s.requirement)) return failure('requirement_mismatch');
  } else if (c.requirementRef !== s.requirement.requirementRef || c.requirementRevision !== s.requirement.revision) {
    return failure('requirement_mismatch');
  }
  return parsed;
}

/** Validate one new canonical event; duplicates must be handled as replay by the host. */
export function validateJobTransition(previous: unknown, value: unknown): JobValidation<JobEvent> {
  const parsed = validateJobEvent(value);
  if (!parsed.ok) return parsed;
  const e = parsed.value, next = e.snapshot;
  if (previous === null) return e.kind === 'submitted' ? parsed : failure('invalid_transition');
  const before = validateJobSnapshot(previous);
  if (!before.ok) return before;
  const s = before.value;
  if (!same(s.identity, next.identity)) return failure('identity_mismatch');
  if (e.previousRevision !== s.revision) return failure('invalid_revision');
  // Existing effects cannot disappear, be relabelled, or be "resolved" by lifecycle validation.
  if (!s.effects.every(old => next.effects.some(item => same(old, item)))) return failure('effect_conflict');
  if ('command' in e) {
    const binding = validateJobCommand(e.command, s);
    if (!binding.ok) return binding;
  }
  const active = s.state === 'queued' || s.state === 'running' || s.state === 'waiting';
  let allowed = false;
  switch (e.kind) {
    case 'started': allowed = s.state === 'queued'; break;
    case 'waiting': allowed = s.state === 'running'; break;
    case 'answered': allowed = s.state === 'waiting' && !s.answer && next.state === 'waiting'
      && same(s.requirement, next.requirement); break;
    case 'resumed': allowed = s.state === 'waiting'; break;
    case 'succeeded': allowed = s.state === 'running'; break;
    case 'failed': case 'cancelled': allowed = active; break;
    case 'effects_recorded': allowed = s.state === 'running'; break;
  }
  if (!allowed) return failure('invalid_transition');
  if (s.state !== 'running' && !same(s.effects, next.effects)) return failure('effect_conflict');
  return parsed;
}

function result(v: unknown): v is JobResult {
  if (!record(v)) return false;
  const ok = Object.getOwnPropertyDescriptor(v, 'ok')?.value;
  const kind = Object.getOwnPropertyDescriptor(v, 'command')?.value;
  const base = { command: oneOf('submit', 'inspect', 'events', 'answer', 'resume', 'cancel'), ok: oneOf(ok) };
  if (ok === false) return shape(v, { ...base, error });
  if (ok !== true) return false;
  if (kind === 'events') {
    if (!shape(v, { ...base, baseline: snapshot, events: v => list(v, event) })) return false;
    const r = v as unknown as Extract<JobResult, { command: 'events'; ok: true }>;
    let previous = r.baseline;
    for (const e of r.events) {
      if (!validateJobTransition(previous, e).ok) return false;
      previous = e.snapshot;
    }
    return true;
  }
  if (!shape(v, { ...base, snapshot })) return false;
  const s = v.snapshot as JobSnapshot;
  switch (v.command) {
    case 'submit': return s.state === 'queued' && s.revision === 1 && s.effects.length === 0;
    case 'inspect': return true;
    case 'answer': return s.state === 'waiting' && !!s.answer;
    case 'resume': return s.state === 'queued';
    case 'cancel': return s.state === 'cancelled';
    default: return false;
  }
}
export function validateJobResult(value: unknown): JobValidation<JobResult> { return checked(value, result); }
