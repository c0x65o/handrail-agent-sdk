import type { VaultEntryRequest } from '../contracts/vault.js';
import { validateVaultEntryRequest, validateVaultOperationSchema } from '../contracts/vault.js';
import type { JobStoreResult } from './job-store.js';
import { sameLeaseValue, validLeaseAuthority } from './job-lease.js';
import type { JobLeaseAuthority } from './job-lease.js';
import type { VaultEntryBinding, VaultEntryHandle, VaultEntryHost, VaultEntryPhase, VaultEntryStore } from './vault-entry.js';

/** Server-owned registration, never a client capability declaration. No production
 * qualification is available. A fixture pass cannot enable production custody. */
export interface PaymentAdapterRegistration {
  readonly adapterRef: string;
  readonly version: string;
  readonly environmentRef: string;
  readonly qualification: 'synthetic_boundary_only';
}
export interface PaymentSession {
  readonly handle: VaultEntryHandle;
  readonly binding: VaultEntryBinding;
  readonly adapter: PaymentAdapterRegistration;
}
export interface PaymentCompletion {
  readonly session: PaymentSession;
  /** Authenticated completion origin, independently established by the adapter. */
  readonly origin: string;
  /** Host-approved nonsecret UUID alias, NOT a provider token or instrument ID. */
  readonly custody: { readonly adapterRef: string };
}
export interface SpecializedPaymentAdapter {
  /** Idempotently bind hosted/tokenized entry or existing-reference selection.
   * Card data and transient security codes stay wholly inside this adapter.
   * No URL, provider handle, raw field, error body or telemetry returns to SDK. */
  open(session: PaymentSession): Promise<void>;
  /** Resolve authenticated server-side completion independently of client input.
   * Authenticate provider callbacks and session/origin/account/environment/purpose;
   * verify existing-item ownership on selection. Hold reference validity and consent
   * stable through run AND its storage commit. Never create authority from a token
   * string supplied by a client. Returned custody alias must be host-approved. */
  withCompletion<T>(session: PaymentSession,
    run: (completion: PaymentCompletion) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  /** Recheck revocation, reference ownership and consent even on delivery retry;
   * hold that authority until run and commit finish. No provider mutation. */
  withReference<T>(session: PaymentSession, run: () => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
}
export interface PaymentVaultHost extends VaultEntryHost {
  readonly paymentMode: 'synthetic_sandbox' | 'unsupported';
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const denied = (): JobStoreResult<never> => ({ ok: false, code: 'not_authorized' });
const invalid = (): JobStoreResult<never> => ({ ok: false, code: 'invalid_payload' });
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return Reflect.ownKeys(v).length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return d?.enumerable && 'value' in d;
  });
}
function handle(v: unknown): v is VaultEntryHandle {
  return exact(v, ['sessionRef', 'revision']) && typeof v.sessionRef === 'string'
    && /^[A-Za-z0-9_-]{32,128}$/.test(v.sessionRef) && Number.isSafeInteger(v.revision) && (v.revision as number) > 0;
}
function alias(v: unknown): v is { adapterRef: string } {
  return exact(v, ['adapterRef']) && typeof v.adapterRef === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.adapterRef);
}
/** Reference handoff only: no purchase, charge, provider token input or raw capture.
 * Store must consume payment completion once atomically, persist consent and the
 * original-job answer outbox, and fence expiry/cancel/revisions at commit. */
export function createPaymentVault(host: PaymentVaultHost, store: VaultEntryStore<{ readonly adapterRef: string }>,
  registration: PaymentAdapterRegistration, adapter: SpecializedPaymentAdapter) {
  const registered = copy(registration);
  async function authorized<T>(request: VaultEntryRequest, phase: VaultEntryPhase, expected: VaultEntryBinding | undefined,
    run: (b: VaultEntryBinding, a: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    if (host.paymentMode !== 'synthetic_sandbox' || registered.qualification !== 'synthetic_boundary_only'
      || !exact(registered, ['adapterRef', 'version', 'environmentRef', 'qualification'])
      || ![registered.adapterRef, registered.version, registered.environmentRef].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))
      || request.identity.host.environmentRef !== registered.environmentRef) return denied();
    return host.withAuthority(copy(request), phase, async input => {
      const a = copy(input), g = a.grant, lease = { host: a.host, grantRevision: a.grantRevision, cancellationRevision: a.cancellationRevision };
      const now = host.now();
      if (!validLeaseAuthority(lease, request.identity) || a.actorRef !== request.requirement.actor.actorRef
        || !['new_input', 'existing_item'].includes(a.source)
        || !exact(g, ['request', 'issuedAt', 'expiresAt', 'state', 'permissions', 'itemExpiresAt', 'taskExpiresAt'])
        || !exact(g.permissions, ['use', 'reveal', 'export']) || !validateVaultOperationSchema(g.request).ok
        || g.request.item.metadata.kind !== 'payment_method' || !sameLeaseValue(g.request.identity, request.identity)
        || !sameLeaseValue(g.request.effect, request.effect) || !sameLeaseValue(g.request.item.metadata, request.metadata)
        || g.request.jobRevision <= request.jobRevision || g.state !== 'active' || g.permissions.use !== true
        || g.permissions.reveal !== false || g.permissions.export !== false || !Number.isSafeInteger(now) || now < 0
        || ![g.issuedAt, g.expiresAt, g.itemExpiresAt, g.taskExpiresAt].every(Number.isSafeInteger)
        || g.issuedAt < 0 || g.issuedAt > now || request.issuedAt > now || g.expiresAt <= g.issuedAt || g.expiresAt - g.issuedAt > 300_000
        || request.expiresAt > Math.min(g.expiresAt, g.itemExpiresAt, g.taskExpiresAt)
        || (phase !== 'expire' && now >= request.expiresAt)) return denied();
      const b = { request, source: a.source, grant: g, paymentAdapter: registered };
      if (expected && !sameLeaseValue(b, expected)) return denied();
      return run(b, lease);
    });
  }
  async function safe<T>(run: () => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    try { return await run(); } catch { return { ok: false, code: 'unavailable' }; }
  }
  // Only release the SDK/store's result, never an arbitrary adapter error/body.
  async function guarded<A, T>(invoke: (run: (arg: A) => Promise<JobStoreResult<T>>) => Promise<JobStoreResult<T>>,
    run: (arg: A) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    let result: JobStoreResult<T> | undefined, called = false;
    const returned = await invoke(async arg => {
      if (called) return denied();
      called = true;
      result = copy(await run(arg));
      return copy(result);
    });
    return result && sameLeaseValue(returned, result) ? result : denied();
  }
  async function session<T>(input: VaultEntryHandle, phase: VaultEntryPhase,
    run: (s: PaymentSession, a: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    return safe(async () => {
      if (!handle(input)) return invalid();
      const h = copy(input), found = await store.lookup(h);
      if (!found.ok) return found;
      if (!validateVaultEntryRequest(found.value.request).ok || found.value.request.metadata.kind !== 'payment_method') return denied();
      return authorized(found.value.request, phase, found.value, (b, a) => run({ handle: h, binding: b, adapter: registered }, a));
    });
  }
  return {
    issue: (request: VaultEntryRequest) => safe(async () => {
      if (!validateVaultEntryRequest(request).ok || request.metadata.kind !== 'payment_method') return invalid();
      return authorized(copy(request), 'issue', undefined, async (b, a) => {
        const result = await store.issue(b, a, () => host.now());
        if (result.ok) await adapter.open(copy({ handle: result.value, binding: b, adapter: registered }));
        return result;
      });
    }),
    complete: (input: VaultEntryHandle) => session(input, 'capture', (s, a) =>
      guarded<PaymentCompletion, import('../contracts/vault.js').VaultEntryCompletion>(run => adapter.withCompletion(copy(s), run), c => {
        if (!exact(c, ['session', 'origin', 'custody']) || !alias(c.custody)
          || c.origin !== s.binding.request.origin || !sameLeaseValue(c.session, s)) return Promise.resolve(denied());
        return store.capture(s.handle, s.binding, a, () => host.now(), copy(c.custody));
      })),
    deliver: (input: VaultEntryHandle) => session(input, 'deliver', (s, a) =>
      guarded<void, import('./answer.js').JobAnswerReceipt>(run => adapter.withReference(copy(s), () => run()),
        () => store.deliver(s.handle, s.binding, a, () => host.now()))),
    withdraw: (input: VaultEntryHandle) => session(input, 'withdraw', (s, a) => store.close(s.handle, s.binding, a, () => host.now(), 'withdraw')),
    expire: (input: VaultEntryHandle) => session(input, 'expire', (s, a) => store.close(s.handle, s.binding, a, () => host.now(), 'expire')),
  };
}
