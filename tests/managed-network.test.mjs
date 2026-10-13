import assert from 'node:assert/strict';
import test from 'node:test';
import { website } from '../dist/server/managed/network.js';
test('account grants reject private literal, insecure and userinfo destinations', () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.com', 'https://localhost', 'https://metadata.internal', 'file:///etc/passwd', 'https://example.com:8080']) assert.throws(() => website(url));
  assert.equal(website('https://www.example.com/login').origin, 'https://www.example.com');
});
