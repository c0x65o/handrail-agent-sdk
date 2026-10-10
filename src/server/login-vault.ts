import type { VaultBrowserDestination, VaultOperation } from '../contracts/vault.js';
import { validateVaultOperationSchema } from '../contracts/vault.js';
import { createVaultEntry } from './vault-entry.js';
import type { VaultEntryHost, VaultEntryStore } from './vault-entry.js';
import type { TrustedVaultExecutor } from './vault-use.js';
import { sameLeaseValue } from './job-lease.js';

/** Private server custody. Account/user aliases are resolved separately; never
 * collect passwords or verification codes through model-visible tool input. */
export interface VaultLoginValue { readonly password: string }
export function validateVaultLoginValue(value: unknown): value is VaultLoginValue {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== 1) return false;
    const d = Object.getOwnPropertyDescriptor(value, 'password');
    return !!d?.enumerable && 'value' in d && typeof d.value === 'string' && d.value.length > 0 && d.value.length <= 4096;
  } catch { return false; }
}
/** Secure-entry facade; the authenticated host route supplies capture values.
 * Existing-item selection has no value. Entry/outbox custody stays in the
 * existing store and resumes the original waiting job by opaque reference. */
export function createLoginVault(host: VaultEntryHost, store: VaultEntryStore<VaultLoginValue>) {
  const entry = createVaultEntry({ now: () => host.now(), withAuthority: (request, phase, run) => {
    if (request.metadata.kind !== 'login') return Promise.resolve({ ok: false, code: 'invalid_payload' });
    return host.withAuthority(request, phase, run);
  } }, store);
  return { ...entry, capture: (handle: Parameters<typeof entry.capture>[0], value?: VaultLoginValue) => {
    if (value !== undefined && !validateVaultLoginValue(value))
      return Promise.resolve({ ok: false as const, code: 'invalid_payload' as const });
    return entry.capture(handle, value);
  } };
}
/** Browser owner verifies actual account, origin, full frame ancestry, unique
 * password field and form endpoint in the renderer under navigation/lease fences.
 * Recheck isCurrent immediately before assignment. Suppress private observation
 * and never submit the form: submission requires a separately admitted action. */
export interface PrivateLoginDestination {
  withTarget<T>(request: VaultOperation, signal: AbortSignal, run: (target: {
    readonly destination: VaultBrowserDestination;
    fill(password: string, isCurrent: () => boolean): Promise<'verified' | 'unknown'>;
  }) => Promise<T>): Promise<T>;
}
export function createLoginFillExecutor<PrivateValue>(
  registration: Pick<TrustedVaultExecutor<PrivateValue>, 'operationRef' | 'bind' | 'reconcile'>,
  browser: PrivateLoginDestination,
): TrustedVaultExecutor<PrivateValue> {
  return { operationRef: registration.operationRef, bind: registration.bind.bind(registration),
    reconcile: registration.reconcile.bind(registration),
    async dispatch(request, value, signal, isCurrent) {
      if (!validateVaultOperationSchema(request).ok || request.operation !== 'fill'
        || request.item.metadata.kind !== 'login' || request.destination.fieldKind !== 'password'
        || !validateVaultLoginValue(value) || signal.aborted || !isCurrent()) return 'unknown';
      const bound = JSON.parse(JSON.stringify(request)) as typeof request;
      const password = value.password;
      let called = false, active = true;
      const observed: { outcome: 'verified' | 'unknown' } = { outcome: 'unknown' };
      try {
        const result = await browser.withTarget(JSON.parse(JSON.stringify(bound)), signal, async target => {
          if (!active || called || signal.aborted || !isCurrent() || !sameLeaseValue(target.destination, bound.destination)) return 'unknown';
          called = true;
          const outcome = await target.fill(password, () => active && !signal.aborted && isCurrent());
          observed.outcome = outcome === 'verified' ? 'verified' : 'unknown';
          return observed.outcome;
        });
        return called && result === 'verified' && observed.outcome === 'verified' ? 'verified' : 'unknown';
      } catch { return 'unknown'; }
      finally { active = false; }
    },
  };
}
