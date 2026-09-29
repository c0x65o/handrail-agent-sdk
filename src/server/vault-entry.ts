import type { VaultEntryCompletion, VaultEntryRequest } from '../contracts/vault.js';
import { validateVaultEntryRequest, validateVaultOperationSchema } from '../contracts/vault.js';
import type { JobAnswerReceipt } from './answer.js';
import type { JobLeaseAuthority } from './job-lease.js';
import { sameLeaseValue, validLeaseAuthority } from './job-lease.js';
import type { JobStoreResult } from './job-store.js';
import type { VaultItemGrant } from './vault-use.js';

export interface VaultEntryHandle { readonly sessionRef: string; readonly revision: number }
export interface VaultEntryBinding {
  readonly request: VaultEntryRequest;
  readonly source: VaultEntryCompletion['source'];
  /** Exact host-approved future use, including destination, purpose and revision. */
  readonly grant: VaultItemGrant;
}
export interface VaultEntryAuthority extends JobLeaseAuthority {
  readonly actorRef: string;
  readonly source: VaultEntryCompletion['source'];
  readonly grant: VaultItemGrant;
}
export type VaultEntryPhase = 'issue' | 'capture' | 'deliver' | 'withdraw' | 'expire';
export interface VaultEntryHost {
  /** Authenticate independently of the link. Resolve current job/scope and exact
   * item ACL/consent and destination from trusted host state, never request facts.
   * New-input item aliases must be host-issued, unique and nonsecret. Preserve the
   * approved binding on retry; hold authority stable through callback AND commit.
   * Authenticate private entry origin/CSRF independently; never accept card data from model input. */
  withAuthority<T>(request: VaultEntryRequest, phase: VaultEntryPhase,
    run: (authority: VaultEntryAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>>;
  now(): number;
}
/** Trusted atomic storage port. PrivateValue never enters a public contract,
 * completion, digest or outbox. lookup is internal and confers no authority. */
export interface VaultEntryStore<PrivateValue> {
  lookup(handle: VaultEntryHandle): Promise<JobStoreResult<VaultEntryBinding>>;
  issue(binding: VaultEntryBinding, authority: JobLeaseAuthority, now: () => number): Promise<JobStoreResult<VaultEntryHandle>>;
  capture(handle: VaultEntryHandle, binding: VaultEntryBinding, authority: JobLeaseAuthority, now: () => number,
    privateValue?: PrivateValue): Promise<JobStoreResult<VaultEntryCompletion>>;
  deliver(handle: VaultEntryHandle, binding: VaultEntryBinding, authority: JobLeaseAuthority, now: () => number): Promise<JobStoreResult<JobAnswerReceipt>>;
  close(handle: VaultEntryHandle, binding: VaultEntryBinding, authority: JobLeaseAuthority, now: () => number,
    reason: 'withdraw' | 'expire'): Promise<JobStoreResult<void>>;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const denied = (): { ok: false; code: 'not_authorized' } => ({ ok: false, code: 'not_authorized' });
const validHandle = (h: VaultEntryHandle) => h && Object.keys(h).length === 2
  && typeof h.sessionRef === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(h.sessionRef)
  && Number.isSafeInteger(h.revision) && h.revision > 0;

/** No surface-close callback: dismissing a surface leaves the original job waiting. */
export function createVaultEntry<PrivateValue>(host: VaultEntryHost, store: VaultEntryStore<PrivateValue>) {
  async function authorized<T>(request: VaultEntryRequest, phase: VaultEntryPhase, expected: VaultEntryBinding | undefined,
    run: (binding: VaultEntryBinding, authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    try {
      return await host.withAuthority(copy(request), phase, async input => {
        const a = copy(input), grant = a.grant;
        if (!grant || Object.keys(grant).sort().join(',') !== 'expiresAt,issuedAt,itemExpiresAt,permissions,request,state,taskExpiresAt'
          || !grant.permissions || Object.keys(grant.permissions).sort().join(',') !== 'export,reveal,use'
          || grant.state !== 'active'
          || ![grant.issuedAt, grant.expiresAt, grant.itemExpiresAt, grant.taskExpiresAt].every(v => Number.isSafeInteger(v) && v >= 0)
          || grant.expiresAt <= grant.issuedAt || grant.expiresAt - grant.issuedAt > 300_000
          || request.expiresAt > Math.min(grant.expiresAt, grant.itemExpiresAt, grant.taskExpiresAt)
          || grant.permissions.use !== true || grant.permissions.reveal !== false || grant.permissions.export !== false) return denied();
        if (!validLeaseAuthority({ host: a.host, grantRevision: a.grantRevision, cancellationRevision: a.cancellationRevision }, request.identity) || a.actorRef !== request.requirement.actor.actorRef
          || !['new_input', 'existing_item'].includes(a.source) || !validateVaultOperationSchema(grant?.request).ok
          || !sameLeaseValue(grant.request.identity, request.identity)
          || !sameLeaseValue(grant.request.effect, request.effect)
          || !sameLeaseValue(grant.request.item.metadata, request.metadata)
          || grant.request.jobRevision <= request.jobRevision) return denied();
        const binding = { request, source: a.source, grant };
        if (expected && !sameLeaseValue(binding, expected)) return denied();
        return run(binding, { host: a.host, grantRevision: a.grantRevision, cancellationRevision: a.cancellationRevision });
      });
    } catch { return { ok: false, code: 'unavailable' }; }
  }
  async function session<T>(input: VaultEntryHandle, phase: VaultEntryPhase,
    run: (h: VaultEntryHandle, b: VaultEntryBinding, a: JobLeaseAuthority) => Promise<JobStoreResult<T>>): Promise<JobStoreResult<T>> {
    try {
      if (!validHandle(input)) return { ok: false, code: 'invalid_payload' };
      const h = copy(input), found = await store.lookup(h);
      if (!found.ok) return found;
      return authorized(found.value.request, phase, found.value, (b, a) => run(h, b, a));
    } catch { return { ok: false, code: 'unavailable' }; }
  }
  return {
    issue(request: VaultEntryRequest): Promise<JobStoreResult<VaultEntryHandle>> {
      if (!validateVaultEntryRequest(request).ok)
        return Promise.resolve({ ok: false, code: 'invalid_payload' });
      return authorized(copy(request), 'issue', undefined, (b, a) => store.issue(b, a, () => host.now()));
    },
    capture: (handle: VaultEntryHandle, privateValue?: PrivateValue) =>
      session(handle, 'capture', (h, b, a) => store.capture(h, b, a, () => host.now(), privateValue)),
    deliver: (handle: VaultEntryHandle) => session(handle, 'deliver', (h, b, a) => store.deliver(h, b, a, () => host.now())),
    withdraw: (handle: VaultEntryHandle) => session(handle, 'withdraw', (h, b, a) => store.close(h, b, a, () => host.now(), 'withdraw')),
    expire: (handle: VaultEntryHandle) => session(handle, 'expire', (h, b, a) => store.close(h, b, a, () => host.now(), 'expire')),
  };
}
