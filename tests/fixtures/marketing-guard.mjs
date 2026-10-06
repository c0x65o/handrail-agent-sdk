// Installed module boundary, loaded before the example or either SDK.
import assert from 'node:assert/strict';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const root = realpathSync(dirname(fileURLToPath(import.meta.url))) + sep;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(result.url));
    assert.ok(path.startsWith(root), 'INSTALLED_BOUNDARY_VIOLATION');
    const relative = path.slice(root.length);
    assert.ok(relative.startsWith(`node_modules${sep}`)
      || ['out/marketing-consumer.mjs', 'out/marketing-onboarding.mjs', 'marketing-guard.mjs'].includes(relative),
    'UNDECLARED_CONSUMER_INPUT');
    assert.doesNotMatch(relative, /(?:^|\/)handrail-agent-sdk\/(?:src|reference|\.reference-build)\//);
  } else assert.ok(result.url.startsWith('node:'), 'NONLOCAL_IMPORT');
  return result;
} });
let attempts = 0;
function denied() { attempts++; throw Error('PROVIDER_IO_FORBIDDEN'); }
globalThis.fetch = denied;
http.request = http.get = https.request = https.get = denied;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = denied;
syncBuiltinESMExports();
process.on('exit', () => {
  assert.equal(attempts, 0, 'NETWORK_ATTEMPTED');
});
