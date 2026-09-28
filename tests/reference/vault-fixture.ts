// Private deterministic adapter: per-run random seed, never a production key.
import { createHmac, createSecretKey } from 'node:crypto';
import type { VaultItem } from '../../src/contracts/vault.js';
import type { VaultScope, VaultValue } from '../../reference/node/vault-store.js';
export const scope: VaultScope = { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'test', purposeRef: 'fixture' };
export function fixtures(seed: string, suffix = ''): { item: VaultItem; value: VaultValue }[] {
  const secret = (label: string) => createHmac('sha256', seed).update(label).digest('hex');
  const metadata: VaultItem['metadata'][] = [
    { kind: 'login', credential: 'password' }, { kind: 'token', tokenType: 'api' }, { kind: 'token', tokenType: 'refresh' },
    ...(['ssn', 'legal_name', 'date_of_birth', 'tax_id'] as const).map(field => ({ kind: 'identity' as const, field, classification: 'synthetic' as const, provenanceRef: 'private-fixture' })),
    { kind: 'payment_method', instrument: 'credit_card' },
  ];
  return metadata.map((m, i) => {
    const item = { metadata: m, reference: m.kind === 'payment_method'
      ? { kind: 'payment_method', paymentRef: `payment-${i}${suffix}`, revision: 1 }
      : { kind: 'secret', itemRef: `secret-${i}${suffix}`, revision: 1 } } as VaultItem;
    const value = m.kind === 'payment_method' ? { pan: [...secret('card').slice(0,16)].map(c => parseInt(c, 16) % 10).join(''), cardholderName: secret('cardholder'), expiryMonth: '12', expiryYear: '2099' }
      : m.kind === 'login' ? { password: secret(`canary-${i}`) }
      : m.kind === 'token' ? { token: secret(`canary-${i}`) } : { value: secret(`canary-${i}`) };
    return { item, value };
  });
}
export function keyBytes(seed: string, version = 1): Buffer {
  return createHmac('sha256', seed).update(version === 1 ? 'private-test-key' : `private-test-key-${version}`).digest();
}
export function keyService(seed: string) {
  return {
    calls: 0,
    version: 1,
    unavailable: new Set<number>(),
    wrong: new Set<number>(),
    // Deterministic barriers/faults, never a persistence fake.
    beforeResolve: undefined as ((version: number) => Promise<void>) | undefined,
    async active() { this.calls++; return { keyHandle: 'private-key', keyVersion: this.version }; },
    async resolve(_scope: VaultScope, ref: { keyHandle: string; keyVersion: number }) {
      this.calls++;
      await this.beforeResolve?.(ref.keyVersion);
      if (ref.keyHandle !== 'private-key' || ![1, 2, 3].includes(ref.keyVersion) || this.unavailable.has(ref.keyVersion)) return null;
      const bytes = keyBytes(seed, this.wrong.has(ref.keyVersion) ? 99 : ref.keyVersion);
      try { return createSecretKey(bytes); } finally { bytes.fill(0); }
    },
  };
}
export function privateScan(seed: string, outputs: unknown): boolean {
  const serialized = JSON.stringify(outputs);
  const raw = fixtures(seed).flatMap(f => Object.entries(f.value).filter(([k]) => !k.startsWith('expiry')).map(([,v]) => v));
  const key = keyBytes(seed);
  const versions = [2, 3, 99].flatMap(v => {
    const b = keyBytes(seed, v);
    try { return [b.toString('hex'), b.toString('base64'), JSON.stringify([...b])]; } finally { b.fill(0); }
  });
  const needles = [...versions, ...raw.flatMap(v => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex')]), seed,
    key.toString('hex'), key.toString('base64'), JSON.stringify([...key])];
  key.fill(0);
  return needles.every(needle => !serialized.includes(needle));
}
