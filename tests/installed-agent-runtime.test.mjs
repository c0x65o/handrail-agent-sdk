import test from 'node:test';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { services, identity } from './helpers/agent-fixture.mjs';

if (!process.env.HANDRAIL_INSTALLED_CONSUMER) throw Error('INSTALLED_CONSUMER_REQUIRED');
const entry = pathToFileURL(join(resolve(process.env.HANDRAIL_INSTALLED_CONSUMER), 'runtime.mjs'));
const { verifyInstalledRuntime } = await import(entry.href);
test('public Git installed runtime persists multi-step work and fences duplicate effects', async t => {
  await verifyInstalledRuntime(t, { createPostgresHarness, migrations, services, identity });
});
