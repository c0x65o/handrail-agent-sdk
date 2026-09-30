// Private host primitive shared by vault and browser custody. AAD belongs to
// each caller; changing a domain's projection requires a new envelope version.
import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from 'node:crypto';
export interface PrivateEnvelope { nonce: string; ciphertext: string; tag: string }
export function bytes(value: string, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 131_072) throw Error();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw Error();
  return decoded;
}
export function seal(value: unknown, key: KeyObject, aad: Buffer): PrivateEnvelope {
  const nonce = randomBytes(12), plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { plaintext.fill(0); }
}
export function open(envelope: PrivateEnvelope, key: KeyObject, aad: Buffer): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes(envelope.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(aad); decipher.setAuthTag(bytes(envelope.tag, 16));
  const partial = decipher.update(bytes(envelope.ciphertext));
  let plaintext: Buffer | undefined;
  try {
    plaintext = Buffer.concat([partial, decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } finally { partial.fill(0); plaintext?.fill(0); }
}
