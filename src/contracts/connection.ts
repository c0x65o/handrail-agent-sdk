/**
 * Pure connection.ensure wire contracts. The trusted host owns admission,
 * credential custody, provider verification and current authority. These checks
 * cannot authenticate a receipt or make provider calls. See connection-contract.md.
 */
import { validateJobCommand } from './job.js';
import type { JobEffect, JobIdentity, JobRequirement } from './job.js';

export type ConnectionScope = JobIdentity['host'];
export type ConnectionEffectIdentity = Pick<JobEffect, 'actionRef' | 'operationRef' | 'effectRef'>;
export interface ConnectionEnsureInput {
  readonly operation: 'connection.ensure';
  readonly identity: JobIdentity;
  readonly connectionRef: string;
  readonly providerRef: string;
  readonly prerequisiteVersion: string;
  readonly minimumCapabilities: readonly string[];
  /** Immutable admission mode: fixture results cannot be upgraded to provider proof. */
  readonly evidenceMode: 'fixture' | 'provider';
  readonly effect: ConnectionEffectIdentity;
  /** Opaque host-approved identifiers, never tokens, paths, cookies or bearer URLs. */
  readonly vaultRef?: string;
  readonly profileRef?: string;
}
export type ConnectionAuthorization =
  | { readonly state: 'unverified' }
  | { readonly state: 'active' | 'expired'; readonly expiresAt: number }
  | { readonly state: 'revoked'; readonly revokedAt: number };
export type ConnectionMissingRequirement = Pick<JobRequirement, 'requirementRef' | 'revision'> & (
  | { readonly kind: 'secure_input'; readonly actor: { readonly kind: 'user'; readonly actorRef: string };
      readonly reason: 'credentials_required' | 'authentication_challenge' }
  | { readonly kind: 'approval'; readonly actor: { readonly kind: 'user'; readonly actorRef: string };
      readonly reason: 'consent_required' | 'account_selection' | 'authority_required' }
  | { readonly kind: 'provider'; readonly actor: { readonly kind: 'provider'; readonly actorRef: string };
      readonly reason: 'review_pending' | 'access_level_required' | 'account_role_required' | 'prerequisite_unavailable' }
  | { readonly kind: 'provider'; readonly actor: { readonly kind: 'provider'; readonly actorRef: string };
      readonly reason: 'capability_missing'; readonly capabilityRef: string }
);
export interface ConnectionEvidence {
  readonly kind: 'api_capabilities';
  readonly receiptRef: string;
  readonly provenance:
    | { readonly kind: 'fixture'; readonly fixtureRef: string }
    | { readonly kind: 'provider'; readonly verificationRef: string };
  readonly scope: ConnectionScope;
  readonly providerRef: string;
  readonly prerequisiteVersion: string;
  readonly verifiedCapabilities: readonly string[];
  /** Unix milliseconds, supplied and checked against a trusted host clock. */
  readonly verifiedAt: number;
  readonly expiresAt: number;
}
interface ConnectionBase {
  readonly request: ConnectionEnsureInput;
  readonly authorization: ConnectionAuthorization;
}
export type ConnectionEnsureResult = ConnectionBase & (
  | { readonly state: 'requested' | 'inspecting' | 'authenticating' | 'configuring' | 'verifying' }
  | { readonly state: 'waiting_for_user' | 'waiting_for_provider'; readonly missingRequirements: readonly ConnectionMissingRequirement[] }
  | { readonly state: 'reauthorization_required'; readonly reason: 'expired' | 'revoked' | 'scope_changed' | 'provider_rejected';
      readonly missingRequirements: readonly ConnectionMissingRequirement[] }
  | { readonly state: 'unknown_effect'; readonly effect: JobEffect & { readonly outcome: 'unknown' }; readonly reconciliationRef: string }
  | { readonly state: 'ready'; readonly authorization: Extract<ConnectionAuthorization, { state: 'active' | 'expired' }> & { readonly state: 'active' };
      readonly evidence: ConnectionEvidence }
);
export type ConnectionState = ConnectionEnsureResult['state'];
export type ConnectionValidationCode = 'invalid_payload' | 'request_mismatch' | 'evidence_mismatch'
  | 'missing_capability' | 'provenance_mismatch' | 'not_current' | 'effect_conflict' | 'receipt_conflict';
export type ConnectionValidation<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ConnectionValidationCode };

type Check = (value: unknown) => boolean;
type Data = Record<string, unknown>;
const ref: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const time: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive: Check = v => time(v) && (v as number) > 0;
const oneOf = (...values: readonly unknown[]): Check => v => values.includes(v);
function record(v: unknown): v is Data {
  return v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function field(v: unknown, key: string): unknown {
  return record(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined;
}
/** Exact own enumerable data properties; never read an accessor or echo a key. */
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
  if (!Array.isArray(v) || v.length < 1 || v.length > 256) return false;
  const keys = Reflect.ownKeys(v);
  return keys.length === v.length + 1 && keys.every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const d = Object.getOwnPropertyDescriptor(v, key)!;
    return Number(key) < v.length && d.enumerable && 'value' in d && check(d.value);
  });
}
const capabilities: Check = v => list(v, ref) && new Set(v).size === v.length;
const identity: Check = v => validateJobCommand({ command: 'inspect', identity: v }).ok;
const scope: Check = v => shape(v, { tenantRef: ref, userRef: ref, projectRef: ref, accountRef: ref, environmentRef: ref, purposeRef: ref });
const effectFields = { actionRef: ref, operationRef: ref, effectRef: ref };
function input(v: unknown): v is ConnectionEnsureInput {
  if (!shape(v, { operation: oneOf('connection.ensure'), identity, connectionRef: ref, providerRef: ref,
    prerequisiteVersion: ref, minimumCapabilities: capabilities, evidenceMode: oneOf('fixture', 'provider'),
    effect: v => shape(v, effectFields) }, { vaultRef: ref, profileRef: ref })) return false;
  const request = v as ConnectionEnsureInput;
  // Native effect references, if present, must identify the same logical effect.
  return (['actionRef', 'operationRef', 'effectRef'] as const).every(key =>
    request.identity.native[key] === undefined || request.identity.native[key] === request.effect[key]);
}
function authorization(v: unknown): boolean {
  switch (field(v, 'state')) {
    case 'unverified': return shape(v, { state: oneOf('unverified') });
    case 'active': case 'expired': return shape(v, { state: oneOf('active', 'expired'), expiresAt: time });
    case 'revoked': return shape(v, { state: oneOf('revoked'), revokedAt: time });
    default: return false;
  }
}
function requirement(v: unknown): boolean {
  const kind = field(v, 'kind');
  const base = { requirementRef: ref, revision: positive, kind: oneOf(kind),
    actor: (v: unknown) => shape(v, { kind: oneOf(kind === 'provider' ? 'provider' : 'user'), actorRef: ref }) };
  switch (kind) {
    case 'secure_input': return shape(v, { ...base, reason: oneOf('credentials_required', 'authentication_challenge') });
    case 'approval': return shape(v, { ...base, reason: oneOf('consent_required', 'account_selection', 'authority_required') });
    case 'provider': return field(v, 'reason') === 'capability_missing'
      ? shape(v, { ...base, reason: oneOf('capability_missing'), capabilityRef: ref })
      : shape(v, { ...base, reason: oneOf('review_pending', 'access_level_required', 'account_role_required', 'prerequisite_unavailable') });
    default: return false;
  }
}
function evidence(v: unknown): boolean {
  return shape(v, { kind: oneOf('api_capabilities'), receiptRef: ref,
    provenance: v => field(v, 'kind') === 'fixture'
      ? shape(v, { kind: oneOf('fixture'), fixtureRef: ref })
      : shape(v, { kind: oneOf('provider'), verificationRef: ref }),
    scope, providerRef: ref, prerequisiteVersion: ref, verifiedCapabilities: capabilities, verifiedAt: time, expiresAt: time });
}
function result(v: unknown): v is ConnectionEnsureResult {
  const state = field(v, 'state');
  const base = { request: input, authorization, state: oneOf(state) };
  const missingRequirements: Check = v => list(v, requirement)
    && new Set((v as ConnectionMissingRequirement[]).map(r => r.requirementRef)).size === v.length;
  switch (state) {
    case 'requested': case 'inspecting': case 'authenticating': case 'configuring': case 'verifying': return shape(v, base);
    case 'waiting_for_user': case 'waiting_for_provider': return shape(v, { ...base, missingRequirements });
    case 'reauthorization_required': return shape(v, { ...base, missingRequirements,
      reason: oneOf('expired', 'revoked', 'scope_changed', 'provider_rejected') });
    case 'unknown_effect': return shape(v, { ...base, effect: v => shape(v, { ...effectFields, outcome: oneOf('unknown') }), reconciliationRef: ref });
    case 'ready': return shape(v, { ...base, authorization: v => shape(v, { state: oneOf('active'), expiresAt: time }), evidence });
    default: return false;
  }
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!record(a) || !record(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function failure(code: ConnectionValidationCode): { readonly ok: false; readonly code: ConnectionValidationCode } { return { ok: false, code }; }
function bindings(r: ConnectionEnsureResult): ConnectionValidationCode | undefined {
  if ('missingRequirements' in r) {
    if (r.state === 'waiting_for_user' && r.missingRequirements.some(m => m.actor.kind !== 'user')) return 'invalid_payload';
    if (r.state === 'waiting_for_provider' && r.missingRequirements.some(m => m.actor.kind !== 'provider')) return 'invalid_payload';
    if (r.missingRequirements.some(m => m.actor.actorRef !== (m.actor.kind === 'user' ? r.request.identity.host.userRef : r.request.providerRef))) return 'request_mismatch';
    if (r.missingRequirements.some(m => m.reason === 'capability_missing' && !r.request.minimumCapabilities.includes(m.capabilityRef))) return 'missing_capability';
  }
  if (r.state === 'reauthorization_required' && ((r.reason === 'expired' || r.reason === 'revoked')
    ? r.authorization.state !== r.reason : r.authorization.state !== 'unverified')) return 'invalid_payload';
  if (r.state === 'unknown_effect' && !same(r.request.effect, {
    actionRef: r.effect.actionRef, operationRef: r.effect.operationRef, effectRef: r.effect.effectRef,
  })) return 'effect_conflict';
  if (r.state === 'ready') {
    const e = r.evidence;
    if (!same(e.scope, r.request.identity.host) || e.providerRef !== r.request.providerRef
      || e.prerequisiteVersion !== r.request.prerequisiteVersion) return 'evidence_mismatch';
    if (e.provenance.kind !== r.request.evidenceMode) return 'provenance_mismatch';
    if (!r.request.minimumCapabilities.every(c => e.verifiedCapabilities.includes(c))) return 'missing_capability';
    if (e.verifiedAt >= e.expiresAt) return 'not_current';
  }
  return undefined;
}
/** Structural admission only; identity/ref possession is never authorization. */
export function validateConnectionEnsureInput(value: unknown): ConnectionValidation<ConnectionEnsureInput> {
  try { return input(value) ? { ok: true, value } : failure('invalid_payload'); }
  catch { return failure('invalid_payload'); }
}
/** Requires the host's admitted request and clock, never a caller-selected clock. */
export function validateConnectionEnsureResult(value: unknown, request: unknown, now: number): ConnectionValidation<ConnectionEnsureResult> {
  try {
    if (!time(now) || !input(request) || !result(value)) return failure('invalid_payload');
    if (!same(value.request, request)) return failure('request_mismatch');
    const code = bindings(value);
    if (code) return failure(code);
    const auth = value.authorization;
    if ((auth.state === 'active' && auth.expiresAt <= now) || (auth.state === 'expired' && auth.expiresAt > now)
      || (auth.state === 'revoked' && auth.revokedAt > now)) return failure('not_current');
    if (value.state === 'ready' && (value.evidence.verifiedAt > now || value.evidence.expiresAt <= now)) return failure('not_current');
    return { ok: true, value };
  } catch { return failure('invalid_payload'); }
}
/**
 * Compare with the canonical prior result on reconnect/replay. This is a binding
 * guard, not a lifecycle scheduler or permission to retry. Unknown effects remain
 * unresolved; only a separately qualified domain reconciliation can resolve them.
 */
export function validateConnectionReconnect(previous: unknown, value: unknown, now: number): ConnectionValidation<ConnectionEnsureResult> {
  try {
    // A historically ready result may now be expired; validate its bindings only.
    if (!result(previous)) return failure('invalid_payload');
    const code = bindings(previous);
    if (code) return failure(code);
    const parsed = validateConnectionEnsureResult(value, previous.request, now);
    if (!parsed.ok) return parsed;
    const next = parsed.value;
    if (previous.state === 'unknown_effect' && (next.state !== 'unknown_effect'
      || !same(previous.effect, next.effect) || previous.reconciliationRef !== next.reconciliationRef)) return failure('effect_conflict');
    if (previous.state === 'ready' && next.state === 'ready' && previous.evidence.receiptRef === next.evidence.receiptRef
      && !same(previous.evidence, next.evidence)) return failure('receipt_conflict');
    return parsed;
  } catch { return failure('invalid_payload'); }
}
