import { createHash, type KeyObject } from 'node:crypto';
import { open, seal, type PrivateEnvelope } from './private-envelope.js';

/** Each encrypted page has <64KiB plaintext. Authenticated manifest binds size,
 * digest, page count and ordering. Quota is explicit host custody policy. */
export interface PagedEnvelope { format: 'pages-v1'; manifest: PrivateEnvelope; pages: PrivateEnvelope[] }
const pageBytes = 32768;
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pageAAD = (aad: Buffer, digest: string, index: number) => Buffer.concat([aad, Buffer.from(JSON.stringify([digest,index]))]);
export function sealPages(value: unknown, key: KeyObject, aad: Buffer, quota: number): PagedEnvelope {
  const data = Buffer.from(JSON.stringify(value));
  try {
    if (data.length > quota) throw Error('PRIVATE_RECORD_QUOTA');
    const digest = hash(data), pages = [];
    for (let i=0; i<data.length; i+=pageBytes) pages.push(seal(data.subarray(i,i+pageBytes).toString('base64'),key,pageAAD(aad,digest,pages.length)));
    return { format:'pages-v1', manifest:seal({bytes:data.length,hash:digest,count:pages.length},key,aad), pages };
  } finally { data.fill(0); }
}
export function openPages(envelope: PagedEnvelope, key: KeyObject, aad: Buffer, quota: number): unknown {
  if (envelope.format !== 'pages-v1') throw Error('PRIVATE_RECORD_INVALID');
  const m = open(envelope.manifest,key,aad) as {bytes:number;hash:string;count:number};
  if (!Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > quota || m.count !== Math.ceil(m.bytes/pageBytes)
    || !Array.isArray(envelope.pages) || envelope.pages.length !== m.count || !/^[a-f0-9]{64}$/.test(m.hash)) throw Error('PRIVATE_RECORD_INVALID');
  const parts: Buffer[] = [];
  let data: Buffer | undefined;
  try {
    for (const [i,page] of envelope.pages.entries()) {
      const text = open(page,key,pageAAD(aad,m.hash,i));
      if (typeof text !== 'string' || text.length > Math.ceil(pageBytes/3)*4) throw Error('PRIVATE_RECORD_INVALID');
      const part = Buffer.from(text,'base64'); parts.push(part);
      if (part.toString('base64') !== text || part.length !== Math.min(pageBytes,m.bytes-i*pageBytes)) throw Error('PRIVATE_RECORD_INVALID');
    }
    data = Buffer.concat(parts);
    if (hash(data) !== m.hash) throw Error('PRIVATE_RECORD_INVALID');
    return JSON.parse(data.toString('utf8'));
  } finally { for (const part of parts) part.fill(0); data?.fill(0); }
}
