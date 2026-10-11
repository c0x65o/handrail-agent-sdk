import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';

/** Only public HTTPS destinations are eligible for a user's explicit grant.
 * DNS is resolved at each connection and the checked address is pinned into the
 * socket. Chromium cannot resolve/bypass the proxy, including redirected hops. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254
      || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 || b === 2)
      || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  // Deliberately deny mapped, transition, link-local and unique-local ranges.
  return isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address)
    && !/^2001:(?:0{1,4}:|0?db8:|0{0,2}10:|0{0,2}20:|0{0,3}2:)/i.test(address) && !/^2002:/i.test(address);
}
export function website(value: string): URL {
  const u = new URL(value);
  if (value.length > 2048 || u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443'
    || isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || u.hostname.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(u.hostname)) throw Error('WEBSITE_NOT_ALLOWED');
  return u;
}
export async function createBrowserProxy(origins: readonly string[]) {
  const hosts = new Set(origins.map(origin => website(origin).hostname));
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => { res.writeHead(403).end(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_e, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  let closed = false;
  server.on('connect', (req, client, head) => {
    void (async () => {
      if (closed || !req.url || !/^[a-zA-Z0-9.-]+:443$/.test(req.url)) { client.destroy(); return; }
      const host = req.url.slice(0, -4).toLowerCase();
      if (!hosts.has(host)) { client.destroy(); return; }
      const addresses = await lookup(host, { all: true, verbatim: true });
      if (closed || client.destroyed || !addresses.length || addresses.some(a => !publicAddress(a.address))) { client.destroy(); return; }
      const target = addresses[0]!;
      const upstream = connect({ host: target.address, family: target.family, port: 443 });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      upstream.setTimeout(30_000, () => upstream.destroy());
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        if (closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    })().catch(() => client.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('BROWSER_PROXY_UNAVAILABLE');
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    closed = true; for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
