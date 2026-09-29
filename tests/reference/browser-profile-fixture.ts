import { createHmac, createHash } from 'node:crypto';
import type { BrowserProfilePolicy, BrowserProfileState } from '../../reference/node/browser-profile-store.js';
import { scope, keyBytes } from './vault-fixture.js';
export { keyService, scope } from './vault-fixture.js';
export const profilePolicy: BrowserProfilePolicy = { scope, allowedOrigins: ['https://account.example.test'], authorityEpoch: 7, expiresAt: 4_000_000_000_000 };
export function profileState(seed: string): BrowserProfileState {
  const secret = (name: string) => createHmac('sha256', seed).update(name).digest('hex');
  return { cookies: [{ origin: profilePolicy.allowedOrigins[0], name: 'session', value: secret('cookie'), path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Strict' }], storage: [{ origin: profilePolicy.allowedOrigins[0],
    localStorage: [{ name: 'local', value: secret('local') }], sessionStorage: [{ name: 'session', value: secret('session') }] }] };
}
export function digest(value: unknown): string {
  // Fixed fixture field ordering is preserved by private serialization.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function scan(seed: string, output: unknown): { scanned: number; matches: number } {
  const s = profileState(seed), bytes = keyBytes(seed), wrong = keyBytes(seed, 99);
  const needles = [seed, s.cookies[0].value, s.storage[0].localStorage[0].value, s.storage[0].sessionStorage[0].value,
    bytes.toString('hex'), bytes.toString('base64'), JSON.stringify([...bytes]), wrong.toString('hex'), wrong.toString('base64')];
  bytes.fill(0); wrong.fill(0);
  const encoded = needles.flatMap(v => [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64')]);
  const serialized = JSON.stringify(output);
  return { scanned: encoded.length, matches: encoded.filter(v => serialized.includes(v)).length };
}
