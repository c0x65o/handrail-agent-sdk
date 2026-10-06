// Optional, bounded counterpart to verify-git-install.mjs. No live providers.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicSdkGitSpec, assertSdkGitLock, assertAssistantGitLock } from './helpers/git-consumer-contract.mjs';

const sha = process.argv[2], candidate = process.argv[3] === '--candidate-source';
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.argv.length === (candidate ? 4 : 3), 'UNKNOWN_ARGUMENTS');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const marketingSha = 'b5e725a1d2cff4864c98acb98f9e6e8e8e370f51';
const marketingSpec = `git+https://git@github.com/c0x65o/handrail-sdk-marketing-js.git#${marketingSha}`;
const work = await mkdtemp(join(tmpdir(), 'handrail-marketing-consumer-'));
console.log(`Evidence: ${work}`);
// No ambient credentials, provider configuration, Git rewrites or sibling roots.
const env = { PATH: process.env.PATH, TMPDIR: work, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '', GIT_ALLOW_PROTOCOL: 'https', npm_config_userconfig: '/dev/null',
  npm_config_registry: 'https://registry.npmjs.org' };
const commands = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function run(command, args, cwd, label, extra = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8',
    timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(work, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  commands.push({ command: [command, ...args], cwd, label, exit: result.status, signal: result.signal,
    milliseconds: Math.round(performance.now() - start) });
  await save(join(work, 'commands.json'), commands);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label} failed; see ${work}/${label}.log`);
  console.log(`${label}: passed (${commands.at(-1).milliseconds} ms)`);
  return result.stdout;
}
const consumerManifest = { name: 'optional-marketing-consumer', private: true, type: 'module',
  dependencies: { ...candidate ? manifest.dependencies : { 'handrail-agent-sdk': publicSdkGitSpec(sha) },
    '@handrail/marketing': marketingSpec },
  // The full example also imports AgentRuntimeTool. Use the repository's
  // supported Agents declaration profile, not Marketing's development types.
  devDependencies: { typescript: '5.9.3', '@types/node': '22.20.4', '@types/react': '19.2.14',
    '@types/pg': '8.23.1', esbuild: '0.25.12' } };
const first = join(work, 'lock-consumer'), dir = join(work, 'installed-consumer');
await mkdir(first); await mkdir(dir);
await save(join(first, 'package.json'), consumerManifest);
await run('npm', ['install', '--engine-strict', '--foreground-scripts', '--no-audit', '--no-fund',
  '--cache', join(work, 'install-cache')], first, 'install');
const lockBytes = await readFile(join(first, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
assert.equal(lock.packages['node_modules/@handrail/marketing'].resolved, marketingSpec);
assert.equal(lock.packages[''].dependencies['@handrail/marketing'], marketingSpec);
assertAssistantGitLock(lock, manifest.dependencies['@handrail/ai-assistant']);
if (!candidate) assertSdkGitLock(consumerManifest, lock, sha);
await cp(join(first, 'package.json'), join(dir, 'package.json'));
await cp(join(first, 'package-lock.json'), join(dir, 'package-lock.json'));
await run('npm', ['ci', '--engine-strict', '--foreground-scripts', '--no-audit', '--no-fund',
  '--cache', join(work, 'reinstall-cache')], dir, 'ci');
assert.deepEqual(await readFile(join(dir, 'package-lock.json')), lockBytes, 'CI_CHANGED_LOCK');
const installedLock = JSON.parse(await readFile(join(dir, 'node_modules/.package-lock.json')));
assert.equal(installedLock.packages['node_modules/@handrail/marketing'].resolved, marketingSpec);
assertAssistantGitLock(installedLock, manifest.dependencies['@handrail/ai-assistant']);
if (!candidate) assert.equal(installedLock.packages['node_modules/handrail-agent-sdk'].resolved, publicSdkGitSpec(sha));
const installed = join(dir, 'node_modules/handrail-agent-sdk');
let packed = null;
if (candidate) {
  // Same source/dependency separation as verify-git-install --candidate-source.
  // Pack with normal prepare, then retain ONLY the package allowlist. This is
  // source qualification, not a tarball dependency or committed-Git install.
  assert.equal((await run('git', ['rev-parse', 'HEAD'], root, 'baseline')).trim(), sha);
  assert.equal(lock.packages['node_modules/handrail-agent-sdk'], undefined);
  await mkdir(installed, { recursive: true });
  for (const path of ['src', 'scripts', 'examples', 'docs', 'tsconfig.json', 'package.json'])
    await cp(join(root, path), join(installed, path), { recursive: true });
  await run('npm', ['pack', '--json', '--pack-destination', work], installed, 'candidate-pack');
  const tarball = join(work, `${manifest.name}-${manifest.version}.tgz`);
  packed = { file: tarball, sha256: hash(await readFile(tarball)) };
  await rm(installed, { recursive: true }); await mkdir(installed);
  await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed], dir, 'candidate-unpack');
}
for (const name of ['handrail-agent-sdk', '@handrail/marketing'])
  assert.equal((await lstat(join(dir, 'node_modules', name))).isSymbolicLink(), false);
await cp(join(installed, 'examples/marketing-onboarding.mts'), join(dir, 'marketing-onboarding.mts'));
await cp(join(root, 'tests/fixtures/marketing-consumer.mts'), join(dir, 'marketing-consumer.mts'));
await cp(join(root, 'tests/fixtures/marketing-browser.mjs'), join(dir, 'marketing-browser.mjs'));
await cp(join(root, 'tests/fixtures/marketing-guard.mjs'), join(dir, 'marketing-guard.mjs'));
// Hash the exact consumer inputs before testing them. In committed mode the
// example belongs to the installed revision, which can differ from this checkout.
const files = {};
for (const [path, input] of [
  ['examples/marketing-onboarding.mts', 'marketing-onboarding.mts'],
  ['tests/fixtures/marketing-consumer.mts', 'marketing-consumer.mts'],
  ['tests/fixtures/marketing-browser.mjs', 'marketing-browser.mjs'],
  ['tests/fixtures/marketing-guard.mjs', 'marketing-guard.mjs'],
]) files[path] = hash(await readFile(join(dir, input)));
assert.equal(files['examples/marketing-onboarding.mts'], hash(await readFile(join(installed, 'examples/marketing-onboarding.mts'))));
if (candidate) assert.equal(files['examples/marketing-onboarding.mts'], hash(await readFile(join(root, 'examples/marketing-onboarding.mts'))));
files['tests/verify-marketing-install.mjs'] = hash(await readFile(fileURLToPath(import.meta.url)));
const versions = {};
for (const name of ['handrail-agent-sdk', '@handrail/marketing', '@handrail/ai-assistant', '@openai/agents',
  'typescript', '@types/node', '@types/react', '@types/pg', 'esbuild'])
  versions[name] = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'))).version;
for (const [name, version] of Object.entries(consumerManifest.devDependencies)) assert.equal(versions[name], version);
for (const mode of ['NodeNext', 'Bundler']) {
  await save(join(dir, `tsconfig.${mode}.json`), { compilerOptions: { strict: true, skipLibCheck: false,
    noUncheckedSideEffectImports: true,
    target: 'ES2022', module: mode === 'NodeNext' ? mode : 'ESNext', moduleResolution: mode,
    outDir: 'out', noEmit: mode === 'Bundler', noEmitOnError: true },
    files: ['marketing-onboarding.mts', 'marketing-consumer.mts'] });
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `tsconfig.${mode}.json`], dir, mode);
}
await run(process.execPath, ['--import', './marketing-guard.mjs', '--test', '--test-concurrency=1', 'out/marketing-consumer.mjs'], dir, 'runtime');
await run(process.execPath, ['marketing-browser.mjs'], dir, 'browser');
await run(process.execPath, ['--conditions=browser', '--input-type=module', '--eval',
  "import assert from 'node:assert/strict'; await assert.rejects(import('handrail-agent-sdk/server/marketing'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});"], dir, 'browser-condition');
assert.deepEqual(await readFile(join(dir, 'package-lock.json')), lockBytes, 'CHECKS_CHANGED_LOCK');
const report = { status: 'passed', qualification: candidate ? 'packed-candidate-source-only' : 'committed-Git',
  agentSha: sha, agentShaRole: candidate ? 'source-baseline-only' : 'installed-revision', marketingSha,
  node: process.version, lockSha256: hash(lockBytes), packed, files, versions, commands,
  fileOrigins: { example: 'installed package, copied byte-for-byte to consumer', fixturesAndHarness: 'review checkout' },
  hostAndLiveQualification: false, consumer: dir };
await save(join(work, 'result.json'), report);
console.log(JSON.stringify(report, null, 2));
