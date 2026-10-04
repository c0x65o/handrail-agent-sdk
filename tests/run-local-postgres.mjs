// Optional Linux fixture runner. Creates only its own temporary PostgreSQL 15
// cluster; never reads DATABASE_URL or connects to an existing database.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
const bin = '/usr/lib/postgresql/15/bin';
await mkdir(resolve('.reference-build'), { recursive: true });
const dir = await mkdtemp(resolve('.reference-build/postgres-'));
const password = randomBytes(24).toString('hex');
const pwfile = join(dir, 'pw');
let started = false;
try {
  await writeFile(pwfile, password, { mode: 0o600 });
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let result = spawnSync(`${bin}/initdb`, ['-D', join(dir, 'data'), '-U', 'fixture_admin', '--pwfile', pwfile, '--auth=scram-sha-256', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('LOCAL_FIXTURE_INIT_FAILED');
  result = spawnSync(`${bin}/pg_ctl`, ['-D', join(dir, 'data'), '-l', join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`, '-w', 'start'], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('LOCAL_FIXTURE_START_FAILED');
  started = true;
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'fixture_admin', password, database: 'postgres' });
  try {
    await admin.connect();
    await admin.query(`CREATE ROLE fixture_role LOGIN PASSWORD '${password}'`);
    await admin.query('CREATE DATABASE sdk_disposable OWNER fixture_role');
  } finally { await admin.end(); }
  const env = { ...process.env, HANDRAIL_TEST_POSTGRES_URL: `postgresql://fixture_role:${password}@127.0.0.1:${port}/sdk_disposable?sslmode=disable`, HANDRAIL_TEST_POSTGRES_DISPOSABLE: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('PG') || key === 'NODE_PG_FORCE_NATIVE') delete env[key];
  console.log('Fresh isolated PostgreSQL 15 cluster initialized; dedicated disposable database and non-superuser fixture role; connection values withheld.');
  const installedConsumer = process.argv[2] === '--installed-consumer' ? process.argv[3] : null;
  const suites = installedConsumer ? [] : process.argv.slice(2);
  const allowed = ['test:observer-recovery', 'test:conversation', 'test:assistance', 'test:connection-store', 'test:browser-profile', 'test:vault-request', 'test:payment-vault', 'test:vault-entry', 'test:vault-use', 'test:vault-lifecycle', 'test:vault', 'test:lease', 'test:effects', 'test:cancel', 'test:answer', 'test:agents', 'test:submit', 'test:journal', 'test:postgres'];
  if (suites.some(suite => !allowed.includes(suite))) throw Error('INVALID_FIXTURE_SUITE');
  if (installedConsumer) {
    result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${resolve(installedConsumer)}`, '--allow-child-process', '--import', './guard.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', 'runtime.test.mjs', 'application.test.mjs', 'conversation.test.mjs'], {
      cwd: resolve(installedConsumer), env: { PATH: process.env.PATH, NODE_OPTIONS: '', NODE_PATH: '',
        HANDRAIL_TEST_POSTGRES_URL: env.HANDRAIL_TEST_POSTGRES_URL, HANDRAIL_TEST_POSTGRES_DISPOSABLE: '1',
        HANDRAIL_INSTALLED_BOUNDARY: '1', HANDRAIL_FORBIDDEN_REPO_FILE: resolve('package.json') }, stdio: 'inherit',
    });
    if (result.status !== 0) process.exitCode = 1;
  }
  for (const command of installedConsumer ? [] : suites.length ? suites : allowed) {
    result = spawnSync('npm', ['run', command], { env, stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
  }
} catch (error) {
  const safeCodes = ['LOCAL_FIXTURE_INIT_FAILED', 'LOCAL_FIXTURE_START_FAILED'];
  console.error(safeCodes.includes(error?.message) ? error.message : 'LOCAL_DISPOSABLE_POSTGRES_RUN_FAILED');
  process.exitCode = 1;
}
finally {
  let removable = true;
  if (started || existsSync(join(dir, 'data/postmaster.pid'))) {
    const stopped = spawnSync(`${bin}/pg_ctl`, ['-D', join(dir, 'data'), '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
    if (stopped.status !== 0) {
      removable = false;
      console.error('LOCAL_FIXTURE_STOP_FAILED_OWNED_DIRECTORY_RETAINED');
      process.exitCode = 1;
    }
    else console.log('Owned temporary PostgreSQL cluster stopped.');
  }
  if (removable) await rm(dir, { recursive: true, force: true });
}
