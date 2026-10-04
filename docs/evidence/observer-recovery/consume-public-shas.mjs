#!/usr/bin/env node
// Main/qualifier handoff ONLY, after reviewed commits are publicly available.
// Does not publish, commit, push, deploy, migrate, or contact a model/runtime.
// Usage: node consume-public-shas.mjs agent <Agent-repo> <AI-full-SHA>
//        node consume-public-shas.mjs mills <Mills-repo> <AI-full-SHA> <Agent-full-SHA>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const [mode, directory, aiSha, agentSha] = process.argv.slice(2);
if (!['agent', 'mills'].includes(mode) || !directory || !/^[a-f0-9]{40}$/.test(aiSha ?? '') ||
    (mode === 'mills' && !/^[a-f0-9]{40}$/.test(agentSha ?? ''))) throw Error('Supply mode, existing repo path, and published full SHA(s).');
const cwd = resolve(directory), path = join(cwd, 'package.json');
const pkg = JSON.parse(readFileSync(path, 'utf8'));
if (pkg.name !== (mode === 'agent' ? 'handrail-agent-sdk' : 'mills-family-erp-v4')) throw Error('Wrong repository');
const dependencies = { '@handrail/ai-assistant': `git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#${aiSha}`,
  ...(mode === 'mills' ? { 'handrail-agent-sdk': `git+https://github.com/c0x65o/handrail-agent-sdk.git#${agentSha}` } : {}) };
for (const [name, pin] of Object.entries(dependencies)) {
  pkg.dependencies[name] = pin;
  if (pkg.allowScripts) pkg.allowScripts[pin] = true;
}
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
for (const args of [['install', '--include=dev'], ['run', 'build']]) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`npm ${args.join(' ')} failed; retain changes for investigation`);
}
const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
for (const [name, pin] of Object.entries(dependencies)) {
  if (lock.packages[''].dependencies[name] !== pin || !lock.packages[`node_modules/${name}`].resolved.endsWith(`#${pin.split('#')[1]}`)) {
    throw Error(`Lockfile does not match ${name}`);
  }
}
console.log('Public HTTPS full-SHA dependencies and lockfile verified; normal install/prepare/build completed. Review all changes and continue the original qualifier.');
