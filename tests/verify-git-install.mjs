// Public Git qualification. Never substitute local source/dist for the SDK.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, cp, rm, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publicSdkGitSpec, assertSdkGitLock } from './helpers/git-consumer-contract.mjs';

const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'FULL_GIT_SHA_REQUIRED');
const flags = process.argv.slice(3);
assert.ok(flags.every(flag => ['--reproduce-default', '--baseline', '--candidate-source'].includes(flag)), 'UNKNOWN_OPTION');
const reproduce = flags.includes('--reproduce-default');
const candidate = flags.includes('--candidate-source');
const baseline = flags.includes('--baseline'); // Distribution-only check for pre-runtime revisions.
assert.ok(!(reproduce && baseline) && !(candidate && (baseline || reproduce)), 'INCOMPATIBLE_OPTIONS');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidateManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const assistantSpec = candidateManifest.dependencies['@handrail/ai-assistant'];
assert.match(assistantSpec, /^git\+https:\/\/git@github\.com\/c0x65o\/handrail-sdk-ai-assistant-js\.git#[a-f0-9]{40}$/);
// Outside the repository: no accidental fallback to its node_modules or types.
const work = await mkdtemp(join(tmpdir(), 'handrail-git-consumer-'));
const spec = reproduce ? `git+https://github.com/c0x65o/handrail-agent-sdk.git#${sha}` : publicSdkGitSpec(sha);
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_ALLOW_PROTOCOL: 'https',
  npm_config_userconfig: '/dev/null', npm_config_registry: 'https://registry.npmjs.org' };
const results = [];
function run(command, args, cwd, extraEnv = {}, expectedFailure = false) {
  console.log(`Running ${command} ${args.join(' ')} (${cwd})`);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024, env: { ...env, ...extraEnv } });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (!expectedFailure && result.status !== 0) throw Error(`${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
const profiles = reproduce ? [{ name: 'default-unpinned', types: null }] : [
  { name: 'node-next', types: '22.20.4' },
  ...baseline ? [] : [{ name: 'bundler-explicit-provider', types: '22.18.0', provider: true }],
];
for (const profile of profiles) {
  const dir = await mkdtemp(join(work, `${profile.name}-`));
  const manifest = { name: 'agent-install-verification', private: true, type: 'module',
    dependencies: { 'handrail-agent-sdk': spec,
      // Candidate-only dependencies use ordinary package resolution. The SDK
      // itself remains a public SHA install followed by the labelled overlay.
      ...candidate ? candidateManifest.dependencies : {},
      ...baseline ? {} : { '@handrail/ai-assistant': assistantSpec, pg: '8.23.0', openai: '7.25.0', '@openai/agents': '0.18.0', zod: '4.3.6' },
      ...profile.provider ? { '@openai/agents': '0.18.0', zod: '4.3.6' } : {} },
    devDependencies: { typescript: '5.9.3', ...profile.types ? { '@types/node': profile.types, '@types/pg': '8.23.1' } : {} } };
  await save(join(dir, 'package.json'), manifest);
  const install = run('npm', ['install', '--include=dev', '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=http'], dir,
    { npm_config_cache: join(dir, 'install-cache') });
  await writeFile(join(dir, 'install.log'), install.stdout + install.stderr);
  const lockPath = join(dir, 'package-lock.json');
  let lock = await json(lockPath);
  const originalResolved = lock.packages['node_modules/handrail-agent-sdk'].resolved;
  if (!reproduce) {
    assertSdkGitLock(manifest, lock, sha);
    const before = await readFile(lockPath, 'utf8');
    // npm ci removes node_modules itself. An empty cache forces a new download
    // and normal Git prepare/build. No SSH protocol or credential helper exists.
    const ci = run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=http'], dir,
      { npm_config_cache: join(dir, 'reinstall-cache') });
    await writeFile(join(dir, 'reinstall.log'), ci.stdout + ci.stderr);
    assert.equal(await readFile(lockPath, 'utf8'), before, 'CI_CHANGED_LOCK');
    lock = await json(lockPath);
    assertSdkGitLock(manifest, lock, sha);
    const installedLock = await json(join(dir, 'node_modules/.package-lock.json'));
    assert.equal(installedLock.packages['node_modules/handrail-agent-sdk'].resolved, spec, 'INSTALLED_LOCK_NOT_HTTPS');
  }
  if (candidate) {
    // SOURCE QUALIFICATION ONLY, never a release/install substitute. Start with
    // an ordinary pinned HTTPS install, then compile the uncommitted candidate
    // inside that isolated package. No repo modules/symlinks or tarball installs.
    // Its lock still identifies the base; results explicitly record this overlay.
    const installed = join(dir, 'node_modules/handrail-agent-sdk');
    await rm(join(installed, 'dist'), {recursive:true,force:true});
    for (const path of ['src', 'scripts', 'examples', 'docs', 'tsconfig.json', 'package.json'])
      await cp(join(root,path), join(installed,path), {recursive:true});
    const prepare=run('npm', ['run','prepare'], installed);
    await writeFile(join(dir,'candidate-prepare.log'),prepare.stdout+prepare.stderr);
    // Runtime only gets the ordinary package file allowlist. No source/scripts
    // can accidentally supply a module during the installed-only test phase.
    for (const path of ['src','scripts','tsconfig.json']) await rm(join(installed,path),{recursive:true,force:true});
  }
  if (baseline) {
    await writeFile(join(dir, 'consumer.mts'), "import { createJobAdmission } from 'handrail-agent-sdk/server'; const factory: typeof createJobAdmission = createJobAdmission;\n");
  } else await copyFile(join(root, 'tests/fixtures/git-consumer.mts'), join(dir, 'consumer.mts'));
  const files = ['consumer.mts'];
  if (!baseline && !reproduce) {
    await copyFile(join(root, 'examples/postgres-application.mts'), join(dir, 'postgres-application.mts'));
    files.push('postgres-application.mts');
  }
  if (profile.provider) {
    await copyFile(join(root, 'examples/headless.mts'), join(dir, 'headless.mts'));
    await writeFile(join(dir, 'provider.mts'), "import { OpenAIProvider } from '@openai/agents'; import { createHeadlessWorker } from './headless.mjs';\ndeclare const ports: Omit<Parameters<typeof createHeadlessWorker>[0], 'model'>;\ndeclare const provider: OpenAIProvider;\ncreateHeadlessWorker({ ...ports, model: await provider.getModel('host-approved-model') });\n");
    files.push('headless.mts', 'provider.mts');
  }
  await save(join(dir, 'tsconfig.json'), { compilerOptions: { strict: true,
    module: profile.provider ? 'ESNext' : 'NodeNext', moduleResolution: profile.provider ? 'Bundler' : 'NodeNext',
    target: 'ES2022', noEmit: true, skipLibCheck: false }, files });
  const compile = run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], dir, {}, reproduce);
  await writeFile(join(dir, 'typecheck.log'), compile.stdout + compile.stderr);
  const versions = Object.fromEntries(Object.entries(lock.packages).filter(([path]) =>
    /node_modules\/(handrail-agent-sdk|@types\/node|@types\/ws|typescript|@openai\/agents(?:-core|-openai|-realtime)?|openai|zod)$/.test(path))
    .map(([path, pkg]) => [path, pkg.version]));
  if (profile.types) assert.equal(versions['node_modules/@types/node'], profile.types);
  if (reproduce) {
    assert.equal(compile.status, 2, 'DEFAULT_FAILURE_NOT_REPRODUCED');
    const diagnostics = compile.stdout.split('\n').filter(line => /error TS\d+/.test(line));
    assert.equal(diagnostics.length, 3, 'UNEXPECTED_DEFAULT_DIAGNOSTICS');
    for (const diagnostic of diagnostics) assert.match(diagnostic, /error TS2416:/);
    assert.equal(originalResolved, spec.replace('git+https://', 'git+ssh://git@'));
  } else {
    run(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const name = ${JSON.stringify(baseline ? 'handrail-agent-sdk/server' : 'handrail-agent-sdk/server/agents')};
      assert.ok(import.meta.resolve(name).startsWith(pathToFileURL(process.cwd() + '/node_modules/handrail-agent-sdk/').href));
      const entry = await import(name);
      assert.equal(typeof entry[${JSON.stringify(baseline ? 'createJobAdmission' : 'createAgentRuntime')}], 'function');
    `], dir);
    if (!baseline) {
      await cp(join(root, 'tests/fixtures/installed'), dir, {recursive:true});
      await mkdir(join(dir,'.reference-build'));
      await writeFile(join(dir,'.reference-build/probe.mjs'),"throw Error('REFERENCE_FALLBACK_LOADED');\n");
    }
  }
  const report = { profile: profile.name, sha, candidateSourceOverlay: candidate, node: process.version, npm: run('npm', ['--version'], dir).stdout.trim(),
    manifest, originalResolved, sdkLock: lock.packages['node_modules/handrail-agent-sdk'], versions,
    typecheckExit: compile.status, status: reproduce ? 'failures-reproduced' : 'passed', fixture: dir };
  await save(join(dir, 'result.json'), report); results.push(report);
}
if (!reproduce && !baseline) {
  // One installed runtime per qualification; the second consumer is a distinct
  // declaration-resolution setup, not a second runtime platform claim.
  const runtime = run(process.execPath, ['tests/run-local-postgres.mjs', '--installed-consumer', results[0].fixture], root);
  await writeFile(join(work, 'runtime.log'), runtime.stdout + runtime.stderr);
  process.stdout.write(runtime.stdout);
}
await save(join(work, 'results.json'), results);
console.log(JSON.stringify({ status: reproduce ? 'failures-reproduced' : 'passed', sha, evidence: work,
  runtime: reproduce || baseline ? 'not-run' : candidate ? 'candidate-source-overlay-public-only-composition' : 'public-git-installed-only-composition',
  profiles: results.map(({ profile, status }) => ({ profile, status })) }));
