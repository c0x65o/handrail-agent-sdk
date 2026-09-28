/**
 * Metadata/reference contracts only. References are host-approved nonsecret IDs,
 * never bearer authority, provider handles, secret-derived hashes or key material.
 * Validators compare host-supplied facts; they do not authenticate those facts.
 */
import { validateJobCommand, validateJobSnapshot } from './job.js';
import type { JobAnswer, JobEffect, JobIdentity, JobRequirement } from './job.js';
import type { VaultEntryContext, VaultUseContext } from '../server/vault-policy.js';

export interface VaultSecretReference {
  readonly kind: 'secret'; readonly itemRef: string; readonly revision: number;
}
/** Opaque card reference, incompatible with generic secret references. No card fields here. */
export interface VaultPaymentReference {
  readonly kind: 'payment_method'; readonly paymentRef: string; readonly revision: number;
}
export type VaultCardField = 'card_number' | 'cardholder_name' | 'card_expiry_month' | 'card_expiry_year';
export type VaultIdentityField = 'ssn' | 'legal_name' | 'date_of_birth' | 'tax_id';
export type VaultMetadata =
  | { readonly kind: 'login'; readonly credential: 'password' }
  | { readonly kind: 'token'; readonly tokenType: 'api' | 'refresh' }
  | { readonly kind: 'identity'; readonly field: VaultIdentityField; readonly classification: 'synthetic'; readonly provenanceRef: string }
  | { readonly kind: 'payment_method'; readonly instrument: 'credit_card' };
export type VaultItem =
  | { readonly metadata: Exclude<VaultMetadata, { kind: 'payment_method' }>; readonly reference: VaultSecretReference }
  | { readonly metadata: Extract<VaultMetadata, { kind: 'payment_method' }>; readonly reference: VaultPaymentReference };
export type VaultEffectIdentity = Pick<JobEffect, 'actionRef' | 'operationRef' | 'effectRef'>;
export type VaultEntryRequirement = Pick<JobRequirement, 'requirementRef' | 'revision'> & {
  readonly kind: 'secure_input'; readonly actor: { readonly kind: 'user'; readonly actorRef: string };
};
export interface VaultEntryRequest {
  readonly operation: 'vault.secure_entry';
  readonly identity: JobIdentity;
  readonly jobRevision: number;
  readonly requirement: VaultEntryRequirement;
  /** Canonical HTTPS origin: no trailing slash, path, query, credentials or fragment. */
  readonly origin: string;
  readonly metadata: VaultMetadata;
  readonly effect: VaultEffectIdentity;
  /** Host-issued Unix milliseconds; maximum 15 minutes, never automatically renewed. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface VaultEntryCompletion {
  readonly request: VaultEntryRequest;
  readonly source: 'new_input' | 'existing_item';
  readonly item: VaultItem;
  readonly answer: JobAnswer;
}
export interface VaultBrowserDestination {
  readonly origin: string;
  readonly profileRef: string;
  readonly leaseEpoch: number;
  readonly documentRef: string;
  readonly navigationRevision: number;
  /** Ordered, complete ancestry including the top document and target frame. */
  readonly frames: readonly { readonly frameRef: string; readonly origin: string }[];
  readonly fieldRef: string;
  readonly fieldKind: 'password' | 'token' | VaultIdentityField | VaultCardField;
  readonly formEndpoint: string;
}
export interface VaultRequestDestination {
  readonly endpoint: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly resourceRef: string;
  readonly redirects: 'deny';
}
export interface VaultPaymentDestination extends VaultBrowserDestination {
  readonly fieldKind: VaultCardField;
  readonly purposeRef: string;
}
interface VaultOperationBase {
  readonly identity: JobIdentity;
  readonly jobRevision: number;
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly effect: VaultEffectIdentity;
}
type ItemOf<K extends VaultMetadata['kind']> = {
  readonly metadata: Extract<VaultMetadata, { kind: K }>;
  readonly reference: K extends 'payment_method' ? VaultPaymentReference : VaultSecretReference;
};
export type VaultOperation = VaultOperationBase & (
  | { readonly operation: 'capture'; readonly item: ItemOf<'login' | 'token'>; readonly destination: VaultBrowserDestination }
  | { readonly operation: 'fill'; readonly item: ItemOf<'login'>; readonly destination: VaultBrowserDestination }
  | { readonly operation: 'fill'; readonly item: ItemOf<'identity'>; readonly destination: VaultBrowserDestination & {
      readonly recipientRef: string; readonly purposeRef: string; readonly identityField: VaultIdentityField } }
  | { readonly operation: 'server_request'; readonly item: ItemOf<'token'>; readonly destination: VaultRequestDestination }
  | { readonly operation: 'fill'; readonly item: ItemOf<'payment_method'>; readonly destination: VaultPaymentDestination }
);
export type VaultErrorCode = 'invalid_payload' | 'binding_mismatch' | 'not_authorized' | 'not_current'
  | 'stale_completion' | 'duplicate_conflict' | 'operation_denied' | 'unavailable' | 'observation_withheld';
export type VaultValidation<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: VaultErrorCode };
export type VaultCompletionValidation =
  | { readonly ok: true; readonly value: VaultEntryCompletion; readonly disposition: 'accept' | 'replay' }
  | { readonly ok: false; readonly code: VaultErrorCode };
export type VaultReceipt = { readonly request: VaultOperation; readonly receiptRef: string } & (
  | { readonly effect: JobEffect & { readonly outcome: 'verified' | 'not_applied' } }
  | { readonly effect: JobEffect & { readonly outcome: 'unknown' }; readonly reconciliationRef: string }
);
export type VaultBrokerResult = { readonly ok: true; readonly receipt: VaultReceipt }
  | { readonly ok: false; readonly error: { readonly code: VaultErrorCode; readonly correlationRef: string } };
/** No public getters, reveal, export, request bodies, headers or raw response data. */
export interface VaultBroker {
  capture(request: Extract<VaultOperation, { operation: 'capture' }>): Promise<VaultBrokerResult>;
  fill(request: Extract<VaultOperation, { operation: 'fill' }>): Promise<VaultBrokerResult>;
  serverRequest(request: Extract<VaultOperation, { operation: 'server_request' }>): Promise<VaultBrokerResult>;
}

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
function list(v: unknown, check: Check): v is unknown[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 32) return false;
  return Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const d = Object.getOwnPropertyDescriptor(v, key)!;
    return Number(key) < v.length && d.enumerable && 'value' in d && check(d.value);
  });
}
function https(v: unknown, originOnly: boolean): boolean {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !v.includes('?') && !v.includes('#')
      && v === (originOnly ? u.origin : u.href);
  } catch { return false; }
}
const origin: Check = v => https(v, true);
const endpoint: Check = v => https(v, false);
const identityField: Check = oneOf('ssn', 'legal_name', 'date_of_birth', 'tax_id');
function metadata(v: unknown): boolean {
  switch (field(v, 'kind')) {
    case 'login': return shape(v, { kind: oneOf('login'), credential: oneOf('password') });
    case 'token': return shape(v, { kind: oneOf('token'), tokenType: oneOf('api', 'refresh') });
    case 'identity': return shape(v, { kind: oneOf('identity'), field: identityField, classification: oneOf('synthetic'), provenanceRef: ref });
    case 'payment_method': return shape(v, { kind: oneOf('payment_method'), instrument: oneOf('credit_card') });
    default: return false;
  }
}
function item(v: unknown): v is VaultItem {
  return shape(v, { metadata, reference: r => field(field(v, 'metadata'), 'kind') === 'payment_method'
    ? shape(r, { kind: oneOf('payment_method'), paymentRef: ref, revision: positive })
    : shape(r, { kind: oneOf('secret'), itemRef: ref, revision: positive }) });
}
const effectFields = { actionRef: ref, operationRef: ref, effectRef: ref };
const actor: Check = v => shape(v, { kind: oneOf('user'), actorRef: ref });
const requirement: Check = v => shape(v, { kind: oneOf('secure_input'), requirementRef: ref, revision: positive, actor });
function effectBinding(v: { identity: JobIdentity; effect: VaultEffectIdentity }): boolean {
  return (['actionRef', 'operationRef', 'effectRef'] as const).every(k => v.identity.native[k] === undefined || v.identity.native[k] === v.effect[k]);
}
function entryRequest(v: unknown): v is VaultEntryRequest {
  if (!shape(v, { operation: oneOf('vault.secure_entry'), identity, jobRevision: positive, requirement,
    origin, metadata, effect: v => shape(v, effectFields), issuedAt: time, expiresAt: time })) return false;
  const r = v as VaultEntryRequest;
  return effectBinding(r) && r.requirement.actor.actorRef === r.identity.host.userRef
    && r.expiresAt > r.issuedAt && r.expiresAt - r.issuedAt <= 900_000;
}
function completion(v: unknown): v is VaultEntryCompletion {
  if (!shape(v, { request: entryRequest, source: oneOf('new_input', 'existing_item'), item,
    answer: v => shape(v, { requirementRef: ref, requirementRevision: positive, responseRef: ref }) })) return false;
  const c = v as VaultEntryCompletion;
  return same(c.item.metadata, c.request.metadata) && c.answer.requirementRef === c.request.requirement.requirementRef
    && c.answer.requirementRevision === c.request.requirement.revision;
}
function browserDestination(v: unknown, identityDisclosure: boolean, card: boolean): boolean {
  if (!shape(v, { origin, profileRef: ref, leaseEpoch: positive, documentRef: ref, navigationRevision: positive,
    frames: v => list(v, f => shape(f, { frameRef: ref, origin })), fieldRef: ref,
    fieldKind: oneOf('password', 'token', 'ssn', 'legal_name', 'date_of_birth', 'tax_id', 'card_number', 'cardholder_name', 'card_expiry_month', 'card_expiry_year'), formEndpoint: endpoint,
    ...(identityDisclosure ? { recipientRef: ref, purposeRef: ref, identityField } : card ? { purposeRef: ref } : {}) })) return false;
  const d = v as VaultBrowserDestination;
  return d.frames[0].origin === d.origin && new Set(d.frames.map(f => f.frameRef)).size === d.frames.length;
}
function operation(v: unknown): v is VaultOperation {
  if (!shape(v, { identity, jobRevision: positive, grantRef: ref, grantRevision: positive,
    effect: v => shape(v, effectFields), operation: oneOf('capture', 'fill', 'server_request'), item,
    destination: d => {
      const kind = field(field(field(v, 'item'), 'metadata'), 'kind');
      if (field(v, 'operation') !== 'server_request') return browserDestination(d, kind === 'identity', kind === 'payment_method');
      return shape(d, { endpoint, method: oneOf('GET', 'POST', 'PUT', 'PATCH', 'DELETE'), resourceRef: ref, redirects: oneOf('deny') });
    } })) return false;
  const r = v as VaultOperation, m = r.item.metadata;
  if (!effectBinding(r)) return false;
  if (r.operation === 'capture' || r.operation === 'fill') {
    if (m.kind === 'login') return r.destination.fieldKind === 'password';
    if (m.kind === 'token') return r.operation === 'capture' && r.destination.fieldKind === 'token';
    if (m.kind === 'payment_method') return r.operation === 'fill'
      && ['card_number', 'cardholder_name', 'card_expiry_month', 'card_expiry_year'].includes(r.destination.fieldKind)
      && (r.destination as VaultPaymentDestination).purposeRef === r.identity.host.purposeRef;
    const d = r.destination as VaultBrowserDestination & { identityField: VaultIdentityField; purposeRef: string };
    return r.operation === 'fill' && m.kind === 'identity' && d.identityField === m.field
      && d.fieldKind === m.field && d.purposeRef === r.identity.host.purposeRef;
  }
  return m.kind === 'token';
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!record(a) || !record(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function failure(code: VaultErrorCode): { readonly ok: false; readonly code: VaultErrorCode } { return { ok: false, code }; }
function checked<T>(v: unknown, check: Check): VaultValidation<T> {
  try { return check(v) ? { ok: true, value: v as T } : failure('invalid_payload'); }
  catch { return failure('invalid_payload'); }
}
const contextFields = {
  currentJob: job, item, authenticated: bool, authenticatedActor: actor, authorized: bool,
  itemAuthorized: bool, itemState: oneOf('active', 'revoked', 'deleted'), itemExpiresAt: time,
  taskExpiresAt: time, maxLifetimeMs: positive,
};
function entryContext(v: unknown): v is VaultEntryContext {
  return shape(v, { ...contextFields, request: entryRequest, state: oneOf('active', 'revoked'), responseRef: ref,
    source: oneOf('new_input', 'existing_item') }, { previous: completion });
}
function useContext(v: unknown): v is VaultUseContext {
  return shape(v, { ...contextFields, grant: g => shape(g, { request: operation, issuedAt: time, expiresAt: time,
    state: oneOf('active', 'revoked'), permissions: p => shape(p, { use: bool, reveal: bool, export: bool }) }) });
}
function current(c: VaultEntryContext | VaultUseContext, id: JobIdentity, now: number): VaultErrorCode | undefined {
  if (!c.authenticated || !c.authorized || !c.itemAuthorized || c.authenticatedActor.actorRef !== id.host.userRef) return 'not_authorized';
  if (!same(c.currentJob.identity, id)) return 'binding_mismatch';
  if (c.itemState !== 'active' || now >= c.itemExpiresAt || now >= c.taskExpiresAt
    || c.currentJob.state === 'cancelled' || c.currentJob.state === 'failed') return 'not_current';
  return undefined;
}
function lifetime(issued: number, expires: number, now: number, maximum: number, c: VaultEntryContext | VaultUseContext): boolean {
  return c.maxLifetimeMs <= maximum && issued <= now && now < expires && expires > issued
    && expires - issued <= c.maxLifetimeMs && expires <= c.itemExpiresAt && expires <= c.taskExpiresAt;
}
/** Shape only: host must admit the authenticated original job/challenge separately. */
export function validateVaultItem(value: unknown): VaultValidation<VaultItem> { return checked(value, item); }
export function validateVaultEntryRequest(value: unknown): VaultValidation<VaultEntryRequest> { return checked(value, entryRequest); }
/**
 * Context is authoritative host state, never request JSON. The host must consume
 * atomically and retain the canonical completion. Replay returns that fact only,
 * without a new job answer, grant, effect, submission or automatic resume.
 */
export function validateVaultEntryCompletion(value: unknown, context: unknown, now: number): VaultCompletionValidation {
  try {
    if (!time(now) || !completion(value) || !entryContext(context)) return failure('invalid_payload');
    const r = value.request, c = context;
    if (!same(r, c.request) || !same(value.item, c.item) || value.source !== c.source) return failure('binding_mismatch');
    const error = current(c, r.identity, now);
    if (error) return failure(error);
    if (!same(c.authenticatedActor, r.requirement.actor)) return failure('not_authorized');
    if (c.state !== 'active' || !lifetime(r.issuedAt, r.expiresAt, now, 900_000, c)) return failure('not_current');
    if (c.previous) {
      if (!same(c.previous, value)) return failure('duplicate_conflict');
      if (value.answer.responseRef !== c.responseRef) return failure('binding_mismatch');
      if (c.currentJob.revision <= r.jobRevision) return failure('stale_completion');
      return { ok: true, value, disposition: 'replay' };
    }
    if (value.answer.responseRef !== c.responseRef) return failure('binding_mismatch');
    const j = c.currentJob;
    if (j.state !== 'waiting' || j.answer || j.revision !== r.jobRevision || !same(j.requirement, r.requirement)) return failure('stale_completion');
    return { ok: true, value, disposition: 'accept' };
  } catch { return failure('invalid_payload'); }
}
/** Server dispatch structural check; this does not authorize use. */
export function validateVaultOperationSchema(value: unknown): VaultValidation<VaultOperation> { return checked(value, operation); }
/** Exact current one-item/operation/destination/effect grant; at most five minutes. */
export function validateVaultOperation(value: unknown, context: unknown, now: number): VaultValidation<VaultOperation> {
  try {
    if (!time(now) || !operation(value) || !useContext(context)) return failure('invalid_payload');
    const c = context, g = c.grant;
    if (!same(value, g.request) || !same(value.item, c.item)) return failure('binding_mismatch');
    const error = current(c, value.identity, now);
    if (error) return failure(error);
    if (!g.permissions.use || c.currentJob.effects.some(e => e.effectRef === value.effect.effectRef)) return failure('operation_denied');
    if (g.state !== 'active' || !lifetime(g.issuedAt, g.expiresAt, now, 300_000, c)
      || c.currentJob.state !== 'running' || c.currentJob.revision !== value.jobRevision) return failure('not_current');
    return { ok: true, value };
  } catch { return failure('invalid_payload'); }
}
function receipt(v: unknown): v is VaultReceipt {
  const unknownEffect = field(field(v, 'effect'), 'outcome') === 'unknown';
  if (!shape(v, { request: operation, receiptRef: ref,
    effect: e => shape(e, { ...effectFields, outcome: oneOf('verified', 'not_applied', 'unknown') }),
    ...(unknownEffect ? { reconciliationRef: ref } : {}) })) return false;
  const r = v as VaultReceipt;
  return (['actionRef', 'operationRef', 'effectRef'] as const).every(k => r.effect[k] === r.request.effect[k]);
}
/** Structural, request-bound receipts, not proof of execution or output authority. */
export function validateVaultBrokerResult(value: unknown, request: unknown): VaultValidation<VaultBrokerResult> {
  try {
    if (!operation(request)) return failure('invalid_payload');
    if (field(value, 'ok') === false) return checked(value, v => shape(v, { ok: oneOf(false), error: e => shape(e, {
      code: oneOf('invalid_payload', 'binding_mismatch', 'not_authorized', 'not_current', 'stale_completion',
        'duplicate_conflict', 'operation_denied', 'unavailable', 'observation_withheld'), correlationRef: ref,
    }) }));
    if (!shape(value, { ok: oneOf(true), receipt })) return failure('invalid_payload');
    const result = value as Extract<VaultBrokerResult, { ok: true }>;
    return same(result.receipt.request, request) ? { ok: true, value: result } : failure('binding_mismatch');
  } catch { return failure('invalid_payload'); }
}
