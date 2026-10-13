import { isIP } from 'node:net';

/** Validate a public HTTPS account grant. Browser network enforcement belongs to the hosted provider. */
export function website(value: string): URL {
  const u = new URL(value);
  if (value.length > 2048 || u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443'
    || isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || u.hostname.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(u.hostname)) throw Error('WEBSITE_NOT_ALLOWED');
  return u;
}
