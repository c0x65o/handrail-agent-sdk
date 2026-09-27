// Private deterministic adapter: per-run random seed, never a production key.
import { createHmac, createSecretKey } from 'node:crypto';
import type { VaultItem } from '../../src/contracts/vault.js';
import type { VaultKeyService, VaultScope, VaultValue } from '../../reference/node/vault-store.js';
export const scope: VaultScope = { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'test', purposeRef: 'fixture' };
export function fixtures(seed: string, suffix = ''): { item: VaultItem; value: VaultValue }[] {
  const secret = (label: string) => createHmac('sha256', seed).update(label).digest('hex');
  const metadata: VaultItem['metadata'][] = [
    { kind: 'login', credential: 'password' }, { kind: 'token', tokenType: 'api' }, { kind: 'token', tokenType: 'refresh' },
    ...(['ssn', 'legal_name', 'date_of_birth', 'tax_id'] as const).map(field => ({ kind: 'identity' as const, field, classification: 'synthetic' as const, provenanceRef: 'private-fixture' })),
    { kind: 'payment_method', providerRef: 'provider', customerRef: 'customer', paymentAccountRef: 'payment-account' },
  ];
  return metadata.map((m, i) => {
    const item = { metadata: m, reference: m.kind === 'payment_method'
      ? { kind: 'payment_method', paymentRef: `payment-${i}${suffix}`, revision: 1 }
      : { kind: 'secret', itemRef: `secret-${i}${suffix}`, revision: 1 } } as VaultItem;
    const value = m.kind === 'payment_method' ? { adapterRef: `${secret('adapter').slice(0,8)}-abcd-4123-8123-${secret('adapter').slice(8,20)}` }
      : m.kind === 'login' ? { password: secret(`canary-${i}`) }
      : m.kind === 'token' ? { token: secret(`canary-${i}`) } : { value: secret(`canary-${i}`) };
    return { item, value };
  });
}
export function keyBytes(seed: string): Buffer { return createHmac('sha256', seed).update('private-test-key').digest(); }
export function keyService(seed: string): VaultKeyService & { calls: number } {
  return {
    calls: 0,
    async active() { this.calls++; return { keyHandle: 'private-key', keyVersion: 1 }; },
    async resolve(_scope, ref) {
      this.calls++;
      if (ref.keyHandle !== 'private-key' || ref.keyVersion !== 1) return null;
      const bytes = keyBytes(seed);
      try { return createSecretKey(bytes); } finally { bytes.fill(0); }
    },
  };
}
export function privateScan(seed: string, outputs: unknown): boolean {
  const serialized = JSON.stringify(outputs);
  const raw = fixtures(seed).flatMap(f => Object.values(f.value));
  const key = keyBytes(seed);
  const needles = [...raw.flatMap(v => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex')]), seed,
    key.toString('hex'), key.toString('base64'), JSON.stringify([...key])];
  key.fill(0);
  return needles.every(needle => !serialized.includes(needle));
}
