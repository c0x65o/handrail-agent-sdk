// Fences ESM and CommonJS, including forked recovery processes. Only declared
// installed dependencies and these explicit host-domain test inputs may load.
import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
const root = realpathSync(dirname(fileURLToPath(import.meta.url))) + sep;
const inputs = new Set(['conversation.test.mjs','conversation-process.mjs','conversation-host.mjs','runtime.test.mjs','application.test.mjs','catalog.test.mjs','host.mjs','database.mjs','process.mjs','guard.mjs']);
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(result.url));
    if (!path.startsWith(root)) throw Error('INSTALLED_BOUNDARY_VIOLATION');
    const relative = path.slice(root.length);
    if (/(?:^|[/\\])\.reference-build(?:[/\\])/.test(relative)) throw Error('INSTALLED_BOUNDARY_VIOLATION');
    if (!relative.startsWith(`node_modules${sep}`) && !inputs.has(relative)) throw Error('INSTALLED_BOUNDARY_VIOLATION');
    const sdk = `node_modules${sep}handrail-agent-sdk${sep}`;
    if (relative.startsWith(sdk) && /(?:^|[/\\])(?:\.reference-build|reference|src)(?:[/\\])/.test(relative.slice(sdk.length)))
      throw Error('INSTALLED_BOUNDARY_VIOLATION');
  } else if (!result.url.startsWith('node:')) throw Error('INSTALLED_BOUNDARY_VIOLATION');
  return result;
} });
