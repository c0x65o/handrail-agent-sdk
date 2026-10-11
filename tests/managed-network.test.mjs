import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { publicAddress, website, createBrowserProxy } from '../dist/server/managed/network.js';
test('deny private, loopback, metadata, multicast, mapped IPv6 and insecure/userinfo destinations', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1', '2001:0000::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true);
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.com', 'https://localhost', 'https://metadata.internal', 'file:///etc/passwd', 'https://example.com:8080']) assert.throws(() => website(url));
  assert.equal(website('https://www.example.com/login').origin, 'https://www.example.com');
});
test('proxy rejects unauthorized CONNECT and plaintext HTTP without upstream IO', async t => {
  const proxy = await createBrowserProxy(['https://allowed.example.com']); t.after(() => proxy.close());
  const rejected = target => new Promise(resolve => {
    const req = request(proxy.url, { method: 'CONNECT', path: target }); req.on('connect', () => resolve(false)); req.on('error', () => resolve(true)); req.end();
  });
  assert.equal(await rejected('127.0.0.1:443'), true); assert.equal(await rejected('not-allowed.example.com:443'), true);
  const status = await new Promise(resolve => { const req = request(proxy.url, { path: 'http://allowed.example.com/' }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
  assert.equal(status, 403);
});
