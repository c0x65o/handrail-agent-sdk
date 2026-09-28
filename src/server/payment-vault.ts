import type { VaultOperation, VaultPaymentDestination } from '../contracts/vault.js';
import { validateVaultOperationSchema } from '../contracts/vault.js';
import { createVaultEntry } from './vault-entry.js';
import type { VaultEntryHost, VaultEntryStore } from './vault-entry.js';
import type { TrustedVaultExecutor } from './vault-use.js';
import { sameLeaseValue } from './job-lease.js';

/** Trusted server custody only. Never a tool argument, observation or public DTO.
 * Security codes are deliberately unsupported: entry rejects them, including
 * unknown aliases. They must not be stored, even in encrypted custody. */
export interface VaultCardValue {
  readonly pan: string;
  readonly cardholderName: string;
  readonly expiryMonth: string;
  readonly expiryYear: string;
}
export function validateVaultCardValue(value: unknown): value is VaultCardValue {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = ['pan', 'cardholderName', 'expiryMonth', 'expiryYear'];
    if (Reflect.ownKeys(value).length !== keys.length) return false;
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string') return false;
    }
    const c = value as VaultCardValue;
    return /^[0-9]{12,19}$/.test(c.pan) && /^(0[1-9]|1[0-2])$/.test(c.expiryMonth)
      && /^[0-9]{4}$/.test(c.expiryYear) && c.cardholderName.length > 0 && c.cardholderName.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(c.cardholderName);
  } catch { return false; }
}

/** Authenticated private-entry facade over the existing session/outbox service.
 * The host authenticates every phase and origin independently of the handle.
 * capture accepts values only on that private route; selection takes no value.
 * Atomic storage consumes card completion once, persists encrypted custody and
 * exact consent, then delivers the original job's reference-only answer. */
export function createPaymentVault(host: VaultEntryHost, store: VaultEntryStore<VaultCardValue>) {
  const scoped: VaultEntryHost = { now: () => host.now(), withAuthority: (request, phase, run) => {
    if (request.metadata.kind !== 'payment_method') return Promise.resolve({ ok: false, code: 'invalid_payload' });
    return host.withAuthority(request, phase, run);
  } };
  const entry = createVaultEntry(scoped, store);
  return entry;
}

/** Registration-only private browser boundary. This is the existing trusted
 * executor extension point, not a browser controller. The browser owner must
 * fence lease/document/navigation and complete frame ancestry through the write;
 * compare the actual origin, frame, field kind and form endpoint again in the
 * renderer immediately before assignment; check isCurrent after async work.
 * It must suppress observations/screenshots/traces containing private fields,
 * never submit the form, and return only the fixed outcome. */
export interface PrivateCardDestination {
  withTarget<T>(request: VaultOperation, signal: AbortSignal,
    run: (target: {
      readonly destination: VaultPaymentDestination;
      fill(value: string, isCurrent: () => boolean): Promise<'verified' | 'unknown'>;
    }) => Promise<T>): Promise<T>;
}
/** Project only the single authorized card field into a registered private sink.
 * createVaultUse supplies durable effect identity, grant/cancel/lifecycle locks,
 * expiry rechecks, at-most-once dispatch and read-only unknown-effect recovery. */
export function createPaymentFillExecutor<PrivateValue>(
  registration: Pick<TrustedVaultExecutor<PrivateValue>, 'operationRef' | 'bind' | 'reconcile'>,
  browser: PrivateCardDestination,
): TrustedVaultExecutor<PrivateValue> {
  return {
    operationRef: registration.operationRef,
    bind: registration.bind.bind(registration),
    reconcile: registration.reconcile.bind(registration),
    async dispatch(request, value, signal, isCurrent) {
      if (!validateVaultOperationSchema(request).ok || request.operation !== 'fill'
        || request.item.metadata.kind !== 'payment_method' || !validateVaultCardValue(value)
        || signal.aborted || !isCurrent()) return 'unknown';
      const bound = JSON.parse(JSON.stringify(request)) as VaultOperation;
      const destination = bound.destination as VaultPaymentDestination;
      const field = { card_number: 'pan', cardholder_name: 'cardholderName',
        card_expiry_month: 'expiryMonth', card_expiry_year: 'expiryYear' }[destination.fieldKind] as keyof VaultCardValue;
      const privateField = value[field];
      let called = false;
      let observed: 'verified' | 'unknown' = 'unknown';
      try {
        const returned = await browser.withTarget(JSON.parse(JSON.stringify(bound)) as VaultOperation, signal, async target => {
          if (called || signal.aborted || !isCurrent() || !sameLeaseValue(target.destination, destination)) return 'unknown';
          called = true;
          const result = await target.fill(privateField, () => !signal.aborted && isCurrent());
          observed = result === 'verified' ? 'verified' : 'unknown';
          return observed;
        });
        return called && returned === observed ? observed : 'unknown';
      } catch { return 'unknown'; }
    },
  };
}
