// Post-pipeline verification: only public HTTPS Git + immutable full SHA.
// --baseline qualifies the existing distribution channel, not the new runtime.
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('FULL_GIT_SHA_REQUIRED');
const baseline = process.argv.includes('--baseline');
await mkdir(resolve('.reference-build'), { recursive: true });
const dir = await mkdtemp(resolve('.reference-build/git-consumer-'));
const spec = `git+https://github.com/c0x65o/handrail-agent-sdk.git#${sha}`;
await writeFile(join(dir,'package.json'), JSON.stringify({name:'agent-install-verification',private:true,type:'module',
  dependencies:{'handrail-agent-sdk':spec},devDependencies:{typescript:'5.9.3'}},null,2));
function run(command,args) {
  const result=spawnSync(command,args,{cwd:dir,encoding:'utf8',timeout:180000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:''}});
  if(result.status!==0) {process.stderr.write(result.stderr||result.stdout);throw Error('GIT_CONSUMER_CHECK_FAILED');}
}
run('npm',['install','--include=dev','--no-audit','--no-fund']);
const lock=JSON.parse(await readFile(join(dir,'package-lock.json'),'utf8'));
if(lock.packages[''].dependencies['handrail-agent-sdk']!==spec
  || !lock.packages['node_modules/handrail-agent-sdk'].resolved.endsWith(`#${sha}`)) throw Error('GIT_LOCK_MISMATCH');
const source = baseline
  ? "import { createJobAdmission } from 'handrail-agent-sdk/server'; if(typeof createJobAdmission!=='function') throw Error();"
  : "import { createAgentRuntime } from 'handrail-agent-sdk/server/agents'; import type { AgentRuntimeHost, AgentStateStore } from 'handrail-agent-sdk/server/agents'; const factory: typeof createAgentRuntime = createAgentRuntime; if(typeof factory!=='function') throw Error();";
await writeFile(join(dir,'consumer.mts'),source);
await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022',noEmit:true},files:['consumer.mts']}));
run(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json']);
run(process.execPath,['--input-type=module','--eval',baseline
  ? "import {createJobAdmission} from 'handrail-agent-sdk/server'; if(typeof createJobAdmission!=='function') throw Error();"
  : "import {createAgentRuntime} from 'handrail-agent-sdk/server/agents'; if(typeof createAgentRuntime!=='function') throw Error();"]);
console.log(JSON.stringify({status:'passed',sha,mode:baseline?'baseline-channel-only':'installed-runtime',
  checks:['normal Git install/prepare','manifest and lock SHA equality','installed package export','installed consumer TypeScript'],fixture:dir}));
