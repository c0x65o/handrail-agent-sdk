/**
 * Reference-only browser contracts. Schema validity is not authentication,
 * adapter qualification, sanitization, encryption, or execution authorization.
 * All IDs must be host-approved nonsecret aliases, never paths or bearer handles.
 */
import { validateJobCommand, validateJobSnapshot } from './job.js';
import { validateVaultOperation } from './vault.js';
import type { JobEffect, JobIdentity, JobRequirement } from './job.js';
import type { VaultBrowserDestination } from './vault.js';
import type { BrowserOperationContext, BrowserTakeoverContext } from '../server/browser-policy.js';

export interface BrowserProfileReference {
  readonly profileRef: string;
  readonly revision: number;
  readonly scope: JobIdentity['host'];
}
/** Describes required custody, not evidence that an adapter implements it. */
export interface BrowserProfile {
  readonly reference: BrowserProfileReference;
  readonly state: 'active' | 'revoked' | 'deleted' | 'quarantined';
  readonly custody: {
    readonly protection: 'authenticated_encryption';
    readonly custodianRef: string;
    readonly envelopeRevision: number;
    readonly keyVersionRef: string;
  };
}
export interface BrowserLease {
  readonly leaseRef: string;
  readonly profile: BrowserProfileReference;
  readonly sessionRef: string;
  readonly owner: { readonly kind: 'agent' | 'human'; readonly ownerRef: string };
  readonly revision: number;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
/** Full ordered ancestry, including top and target frame; no selector authority. */
export type BrowserDocument = Pick<VaultBrowserDestination,
  'origin' | 'documentRef' | 'navigationRevision' | 'frames'> & { readonly tabRef: string };
export interface BrowserArtifactReference {
  readonly artifactRef: string;
  readonly revision: number;
  readonly scope: JobIdentity['host'];
}
export type BrowserAction =
  | { readonly kind: 'navigate'; readonly destinationRef: string }
  | { readonly kind: 'inspect' }
  | { readonly kind: 'locate'; readonly locatorRef: string }
  | { readonly kind: 'click'; readonly elementRef: string }
  | { readonly kind: 'type'; readonly elementRef: string; readonly textRef: string }
  | { readonly kind: 'tab_open'; readonly destinationRef: string }
  | { readonly kind: 'tab_select' | 'tab_close'; readonly tabRef: string }
  | { readonly kind: 'wait'; readonly condition: 'document_ready'; readonly timeoutMs: number }
  | { readonly kind: 'wait'; readonly condition: 'element_visible' | 'element_hidden'; readonly timeoutMs: number; readonly elementRef: string }
  | { readonly kind: 'upload' | 'download'; readonly elementRef: string; readonly artifact: BrowserArtifactReference }
  /** References resolve to existing purpose-bound VaultOperation grants in the host. */
  | { readonly kind: 'vault_fill' | 'vault_capture'; readonly grantRef: string; readonly grantRevision: number };
export interface BrowserOperation {
  readonly identity: JobIdentity;
  readonly jobRevision: number;
  readonly lease: BrowserLease;
  readonly document: BrowserDocument;
  readonly effect: Pick<JobEffect, 'actionRef' | 'operationRef' | 'effectRef'>;
  readonly action: BrowserAction;
}
export type BrowserObservation = {
  readonly request: BrowserOperation;
} & (
  | { readonly effect: JobEffect & { readonly outcome: 'unknown' }; readonly reconciliationRef: string }
  | { readonly effect: JobEffect & { readonly outcome: 'verified' | 'not_applied' } }
) & (
  | { readonly kind: 'sanitized'; readonly attestation: {
      readonly adapterRef: string; readonly qualificationRef: string; readonly policyRevision: number;
      readonly sessionRef: string; readonly leaseEpoch: number; readonly operationRef: string;
      readonly receiptRef: string;
    }; readonly facts: readonly { readonly kind: 'document_ready' | 'element_visible' | 'element_hidden' | 'action_complete'; readonly subjectRef: string }[] }
  | { readonly kind: 'redacted'; readonly status: 'observation_withheld' | 'unavailable' | 'not_authorized' }
  | { readonly kind: 'takeover'; readonly requirement: JobRequirement }
);
type BrowserChallenge = JobRequirement & { readonly kind: 'approval'; readonly actor: { readonly kind: 'user'; readonly actorRef: string } };
interface BrowserTakeoverBase {
  readonly takeoverRef: string;
  readonly identity: JobIdentity;
  readonly jobRevision: number;
  readonly requirement: BrowserChallenge;
  readonly revision: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lease: BrowserLease;
}
export type BrowserTakeover = BrowserTakeoverBase & (
  | { readonly state: 'requested' | 'leased' }
  | { readonly state: 'handed_back'; readonly authorizationRef: string; readonly authorizationRevision: number }
  | { readonly state: 'expired'; readonly fencedEpoch: number }
);
/** Local cleanup is independent of a separately authorized remote operation. */
export interface BrowserRevocationResult {
  readonly profile: BrowserProfileReference;
  readonly local: { readonly state: 'revoked' | 'deleted' | 'unavailable'; readonly receiptRef: string };
  readonly remote: { readonly state: 'revoked'; readonly receiptRef: string }
    | { readonly state: 'unavailable' | 'unverified' | 'not_requested'; readonly receiptRef?: string };
}
export type BrowserErrorCode = 'invalid_payload' | 'binding_mismatch' | 'not_current' | 'not_authorized' | 'effect_conflict' | 'invalid_transition';
export type BrowserValidation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: BrowserErrorCode };

type Check = (v: unknown) => boolean;
type Data = Record<string, unknown>;
const ref: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const time: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive: Check = v => time(v) && (v as number) > 0;
const bool: Check = v => typeof v === 'boolean';
const oneOf = (...values: readonly unknown[]): Check => v => values.includes(v);
const identity: Check = v => validateJobCommand({ command: 'inspect', identity: v }).ok;
const job: Check = v => validateJobSnapshot(v).ok;
function record(v: unknown): v is Data {
  return v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function field(v: unknown, key: string): unknown { return record(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined; }
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
function list(v: unknown, check: Check, minimum = 0): v is unknown[] {
  if (!Array.isArray(v) || v.length < minimum || v.length > 32) return false;
  return Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const d = Object.getOwnPropertyDescriptor(v, key)!;
    return Number(key) < v.length && d.enumerable && 'value' in d && check(d.value);
  });
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!record(a) || !record(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function origin(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && v === u.origin; } catch { return false; }
}
const scope: Check = v => shape(v, { tenantRef: ref, userRef: ref, projectRef: ref, accountRef: ref, environmentRef: ref, purposeRef: ref });
const profileReference: Check = v => shape(v, { profileRef: ref, revision: positive, scope });
const profile: Check = v => shape(v, { reference: profileReference, state: oneOf('active', 'revoked', 'deleted', 'quarantined'),
  custody: c => shape(c, { protection: oneOf('authenticated_encryption'), custodianRef: ref, envelopeRevision: positive, keyVersionRef: ref }) });
function lease(v: unknown): v is BrowserLease {
  return shape(v, { leaseRef: ref, profile: profileReference, sessionRef: ref,
    owner: o => shape(o, { kind: oneOf('agent', 'human'), ownerRef: ref }), revision: positive, epoch: positive,
    issuedAt: time, expiresAt: time }) && (v as BrowserLease).expiresAt > (v as BrowserLease).issuedAt;
}
function document(v: unknown): v is BrowserDocument {
  if (!shape(v, { origin, documentRef: ref, navigationRevision: positive, tabRef: ref,
    frames: a => list(a, f => shape(f, { frameRef: ref, origin }), 1) })) return false;
  const d = v as BrowserDocument;
  return d.frames[0].origin === d.origin && new Set(d.frames.map(f => f.frameRef)).size === d.frames.length;
}
function action(v: unknown): v is BrowserAction {
  const kind = field(v, 'kind'), base = { kind: oneOf(kind) };
  switch (kind) {
    case 'navigate': case 'tab_open': return shape(v, { ...base, destinationRef: ref });
    case 'inspect': return shape(v, base);
    case 'locate': return shape(v, { ...base, locatorRef: ref });
    case 'click': return shape(v, { ...base, elementRef: ref });
    case 'type': return shape(v, { ...base, elementRef: ref, textRef: ref });
    case 'tab_select': case 'tab_close': return shape(v, { ...base, tabRef: ref });
    case 'wait': return shape(v, { ...base, condition: oneOf('document_ready', 'element_visible', 'element_hidden'),
      timeoutMs: n => positive(n) && (n as number) <= 30_000,
      ...(field(v, 'condition') === 'document_ready' ? {} : { elementRef: ref }) });
    case 'upload': case 'download': return shape(v, { ...base, elementRef: ref,
      artifact: a => shape(a, { artifactRef: ref, revision: positive, scope }) });
    case 'vault_fill': case 'vault_capture': return shape(v, { ...base, grantRef: ref, grantRevision: positive });
    default: return false;
  }
}
const effectFields = { actionRef: ref, operationRef: ref, effectRef: ref };
function operation(v: unknown): v is BrowserOperation {
  if (!shape(v, { identity, jobRevision: positive, lease, document, effect: e => shape(e, effectFields), action })) return false;
  const r = v as BrowserOperation;
  return r.lease.owner.kind === 'agent' && same(r.identity.host, r.lease.profile.scope)
    && (['actionRef', 'operationRef', 'effectRef'] as const).every(k => r.identity.native[k] === undefined || r.identity.native[k] === r.effect[k])
    && (!('artifact' in r.action) || same(r.action.artifact.scope, r.identity.host));
}
const requirement: Check = v => shape(v, { kind: oneOf('approval'), requirementRef: ref, revision: positive,
  actor: a => shape(a, { kind: oneOf('user'), actorRef: ref }) });
function takeover(v: unknown): v is BrowserTakeover {
  const state = field(v, 'state');
  if (!shape(v, { takeoverRef: ref, identity, jobRevision: positive, requirement, revision: positive,
    issuedAt: time, expiresAt: time, lease, state: oneOf('requested', 'leased', 'handed_back', 'expired'),
    ...(state === 'handed_back' ? { authorizationRef: ref, authorizationRevision: positive } : {}),
    ...(state === 'expired' ? { fencedEpoch: positive } : {}) })) return false;
  const t = v as BrowserTakeover;
  return t.expiresAt > t.issuedAt && t.expiresAt - t.issuedAt <= 900_000
    && same(t.identity.host, t.lease.profile.scope) && t.requirement.actor.actorRef === t.identity.host.userRef
    && (t.state !== 'leased' || (t.lease.owner.kind === 'human' && t.lease.owner.ownerRef === t.identity.host.userRef && t.lease.expiresAt <= t.expiresAt))
    && (t.state !== 'requested' && t.state !== 'handed_back' || t.lease.owner.kind === 'agent')
    && (t.state !== 'expired' || t.fencedEpoch > t.lease.epoch);
}
function observation(v: unknown): v is BrowserObservation {
  const kind = field(v, 'kind');
  if (!shape(v, { request: operation, effect: e => shape(e, { ...effectFields, outcome: oneOf('unknown', 'verified', 'not_applied') }),
    kind: oneOf('sanitized', 'redacted', 'takeover'),
    ...(field(field(v, 'effect'), 'outcome') === 'unknown' ? { reconciliationRef: ref } : {}),
    ...(kind === 'sanitized' ? {
      attestation: (a: unknown) => shape(a, { adapterRef: ref, qualificationRef: ref, policyRevision: positive,
        sessionRef: ref, leaseEpoch: positive, operationRef: ref, receiptRef: ref }),
      facts: (a: unknown) => list(a, f => shape(f, { kind: oneOf('document_ready', 'element_visible', 'element_hidden', 'action_complete'), subjectRef: ref })),
    } : kind === 'takeover' ? { requirement } : { status: oneOf('observation_withheld', 'unavailable', 'not_authorized') }) })) return false;
  const o = v as BrowserObservation;
  return (['actionRef', 'operationRef', 'effectRef'] as const).every(k => o.effect[k] === o.request.effect[k])
    && (o.kind !== 'sanitized' || (o.attestation.sessionRef === o.request.lease.sessionRef
      && o.attestation.leaseEpoch === o.request.lease.epoch && o.attestation.operationRef === o.request.effect.operationRef))
    && (o.kind !== 'takeover' || o.requirement.actor.actorRef === o.request.identity.host.userRef);
}
function failure(code: BrowserErrorCode): { readonly ok: false; readonly code: BrowserErrorCode } { return { ok: false, code }; }
function checked<T>(v: unknown, check: Check): BrowserValidation<T> {
  try { return check(v) ? { ok: true, value: v as T } : failure('invalid_payload'); } catch { return failure('invalid_payload'); }
}
function active(l: BrowserLease, now: number): boolean { return l.issuedAt <= now && now < l.expiresAt; }
/** Shape checks only. Encryption and approved ID provenance remain host duties. */
export function validateBrowserProfile(value: unknown): BrowserValidation<BrowserProfile> { return checked(value, profile); }
export function validateBrowserLease(value: unknown): BrowserValidation<BrowserLease> { return checked(value, lease); }
export function validateBrowserOperationSchema(value: unknown): BrowserValidation<BrowserOperation> { return checked(value, operation); }
export function validateBrowserTakeover(value: unknown): BrowserValidation<BrowserTakeover> { return checked(value, takeover); }
/** Requires a strictly higher epoch AND revision; host must CAS and fence old control. */
export function validateBrowserLeaseSuccessor(value: unknown, previous: unknown, now: number): BrowserValidation<BrowserLease> {
  try {
    if (!time(now) || !lease(value) || !lease(previous)) return failure('invalid_payload');
    if (!same(value.profile, previous.profile)) return failure('binding_mismatch');
    if (value.epoch <= previous.epoch || value.revision <= previous.revision || value.issuedAt < previous.issuedAt || !active(value, now)) return failure('not_current');
    return { ok: true, value };
  } catch { return failure('invalid_payload'); }
}
const contextFields = { currentJob: job, profile, currentLease: lease, authenticated: bool, authorized: bool, taskExpiresAt: time };
/**
 * Trusted current context only, never client JSON. No dispatch is implemented.
 * Immediately before dispatch AND output release the executor must recheck real
 * account/origin, complete frame ancestry, document/navigation, unique field,
 * form/destination and redirects; comparing these assertions does not do that.
 */
export function validateBrowserOperation(value: unknown, context: unknown, now: number): BrowserValidation<BrowserOperation> {
  try {
    if (!time(now) || !operation(value) || !shape(context, { ...contextFields, admittedOperation: operation,
      nonSensitiveTextAuthorized: bool, transferAuthorized: bool }, { vaultUse: () => true })) return failure('invalid_payload');
    const c = context as BrowserOperationContext, r = value, j = c.currentJob;
    if (!c.authenticated || !c.authorized) return failure('not_authorized');
    if (!same(r, c.admittedOperation) || !same(r.identity, j.identity) || !same(r.lease, c.currentLease)
      || !same(r.lease.profile, c.profile.reference)) return failure('binding_mismatch');
    if (c.profile.state !== 'active' || j.state !== 'running' || j.revision !== r.jobRevision
      || now >= c.taskExpiresAt || !active(r.lease, now)) return failure('not_current');
    if (j.effects.some(e => e.effectRef === r.effect.effectRef)) return failure('effect_conflict');
    if (r.action.kind === 'type' && !c.nonSensitiveTextAuthorized) return failure('not_authorized');
    if (('artifact' in r.action) && !c.transferAuthorized) return failure('not_authorized');
    if (r.action.kind === 'vault_fill' || r.action.kind === 'vault_capture') {
      // Validate the entire vault context before reading nested policy facts.
      const request = field(field(c.vaultUse, 'grant'), 'request');
      const parsed = validateVaultOperation(request, c.vaultUse, now);
      if (!parsed.ok) return failure('not_authorized');
      const v = parsed.value;
      if (v.operation === 'server_request' || v.operation !== (r.action.kind === 'vault_fill' ? 'fill' : 'capture')) return failure('binding_mismatch');
      if (!same(c.vaultUse!.currentJob, j) || !same(v.identity, r.identity) || v.jobRevision !== r.jobRevision
        || v.grantRef !== r.action.grantRef || v.grantRevision !== r.action.grantRevision || !same(v.effect, r.effect)
        || v.destination.profileRef !== r.lease.profile.profileRef || v.destination.leaseEpoch !== r.lease.epoch
        || v.destination.origin !== r.document.origin || v.destination.documentRef !== r.document.documentRef
        || v.destination.navigationRevision !== r.document.navigationRevision || !same(v.destination.frames, r.document.frames)) return failure('binding_mismatch');
    } else if (c.vaultUse !== undefined) return failure('invalid_payload');
    return { ok: true, value };
  } catch { return failure('invalid_payload'); }
}
/** Structure/request binding only, not proof of actual sanitization or safe release. */
export function validateBrowserObservation(value: unknown, request: unknown): BrowserValidation<BrowserObservation> {
  try {
    if (!operation(request) || !observation(value)) return failure('invalid_payload');
    return same(value.request, request) ? { ok: true, value } : failure('binding_mismatch');
  } catch { return failure('invalid_payload'); }
}
/** Validate a new transition, not a replay or a grant to resume the job. */
export function validateBrowserTakeoverTransition(value: unknown, context: unknown, now: number): BrowserValidation<BrowserTakeover> {
  try {
    if (!time(now) || !takeover(value) || !shape(context, { ...contextFields,
      previous: p => p === null || takeover(p), priorControllerFenced: bool, previousAuthorizationRef: ref,
    }, { handbackAuthorization: a => shape(a, { authorizationRef: ref, revision: positive, leaseEpoch: positive,
      jobRevision: positive, requirementRef: ref, requirementRevision: positive, issuedAt: time, expiresAt: time }) })) return failure('invalid_payload');
    const c = context as BrowserTakeoverContext, t = value, p = c.previous, j = c.currentJob;
    if (!c.authenticated || !c.authorized) return failure('not_authorized');
    if (!same(t.identity, j.identity) || !same(t.lease.profile, c.profile.reference)) return failure('binding_mismatch');
    if (c.profile.state !== 'active' || j.state !== 'waiting' || j.answer || j.revision !== t.jobRevision
      || !same(j.requirement, t.requirement) || now >= c.taskExpiresAt) return failure('not_current');
    if (t.state !== 'expired' && (now < t.issuedAt || now >= t.expiresAt || t.expiresAt > c.taskExpiresAt || !active(t.lease, now))) return failure('not_current');
    if (p === null) {
      if (t.state !== 'requested' || t.revision !== 1 || !same(t.lease, c.currentLease)) return failure('invalid_transition');
    } else {
      if (!same(p.identity, t.identity) || !same(p.requirement, t.requirement) || p.jobRevision !== t.jobRevision
        || p.takeoverRef !== t.takeoverRef || p.issuedAt !== t.issuedAt || p.expiresAt !== t.expiresAt
        || !same(p.lease, c.currentLease)) return failure('binding_mismatch');
      if (t.revision !== p.revision + 1 || !c.priorControllerFenced) return failure('not_current');
      if (t.state === 'expired') {
        if ((p.state !== 'requested' && p.state !== 'leased') || !same(t.lease, p.lease)
          || (now < p.expiresAt && now < p.lease.expiresAt)) return failure('invalid_transition');
      } else {
        if (!((p.state === 'requested' && t.state === 'leased') || (p.state === 'leased' && t.state === 'handed_back'))) return failure('invalid_transition');
        if (!active(p.lease, now) || !validateBrowserLeaseSuccessor(t.lease, p.lease, now).ok) return failure('not_current');
        if (t.state === 'handed_back') {
          const a = c.handbackAuthorization;
          if (!a || a.authorizationRef === c.previousAuthorizationRef || a.authorizationRef !== t.authorizationRef
            || a.revision !== t.authorizationRevision || a.leaseEpoch !== t.lease.epoch || a.jobRevision !== j.revision
            || a.requirementRef !== t.requirement.requirementRef || a.requirementRevision !== t.requirement.revision
            || a.issuedAt < t.lease.issuedAt || a.issuedAt > now || a.expiresAt <= now
            || a.expiresAt > t.lease.expiresAt || a.expiresAt > c.taskExpiresAt) return failure('not_authorized');
        }
      }
    }
    return { ok: true, value };
  } catch { return failure('invalid_payload'); }
}
export function validateBrowserRevocationResult(value: unknown, expectedProfile: unknown): BrowserValidation<BrowserRevocationResult> {
  try {
    if (!profileReference(expectedProfile) || !shape(value, { profile: profileReference,
      local: l => shape(l, { state: oneOf('revoked', 'deleted', 'unavailable'), receiptRef: ref }),
      remote: r => shape(r, { state: oneOf('revoked', 'unavailable', 'unverified', 'not_requested'),
        ...(field(r, 'state') === 'revoked' ? { receiptRef: ref } : {}) }, field(r, 'state') === 'revoked' ? {} : { receiptRef: ref }),
    })) return failure('invalid_payload');
    const r = value as BrowserRevocationResult;
    return same(r.profile, expectedProfile) ? { ok: true, value: r } : failure('binding_mismatch');
  } catch { return failure('invalid_payload'); }
}
