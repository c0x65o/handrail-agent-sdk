import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { services, identity, modelBoundary, requirement } from './helpers/agent-fixture.mjs';
const ok = r => { assert.equal(r.ok,true,r.code); return r.value; };
async function setup(t,options = {}) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t,harness,client);
  await client.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY, receipt text NOT NULL, attempts integer NOT NULL DEFAULT 1)`);
  const key = randomBytes(32).toString('hex');
  const s = await services(harness.schema,key,options); t.after(() => s.close());
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'agent-task', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  return { ...s, harness, client, key };
}
test('real Runner executes inventory -> protected reservation -> verification; duplicate delivery has one effect', async t => {
  const s = await setup(t);
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  const final = ok(await s.journal.load(identity));
  assert.equal(final.state,'succeeded'); assert.equal(final.effects.length,1); assert.equal(final.effects[0].outcome,'verified');
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,1);
  const state = ok(await s.states.load(identity,s.authority()));
  assert.equal(state.output,'Reserved synthetic item.'); assert.equal(state.usage.requests,4);
  assert.ok(s.events.some(e => e.kind === 'model_progress'));
  const publicRows = JSON.stringify((await s.client.query(`SELECT event FROM ${s.harness.table('job_events')}`)).rows);
  const privateRows = JSON.stringify((await s.client.query(`SELECT * FROM ${s.harness.table('agent_run_states')}`)).rows);
  for (const text of ['Check stock','Reserved synthetic item.','synthetic-item']) {
    assert.ok(!publicRows.includes(text)); assert.ok(!privateRows.includes(text));
  }
});
test('different research task recovers from deliberate read-tool failure and computes a quote', async t => {
  const s = await setup(t,{scenario:'research'});
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  const state = ok(await s.states.load(identity,s.authority()));
  assert.equal(state.output,'Fallback quote: 21');
  assert.ok(Object.values(state.results).some(r => r.output.includes('tool_failed')));
  assert.ok(!JSON.stringify(state).includes('CONFIDENTIAL_PROVIDER_FAILURE'));
  assert.equal(s.calls.length,3); assert.equal(s.model.requests,4);
});
test('durable approval, answer and new input resume same job in a separate process', async t => {
  const s = await setup(t,{wait:true});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const waiting = ok(await s.journal.load(identity));
  ok(await s.answer.issue({ identity, requirement: waiting.requirement, jobRevision: waiting.revision,
    expiresAt: Date.now()+60_000,resolverRef:'actor' }));
  ok(await s.answer.complete({ identity, requirementRef: waiting.requirement.requirementRef,
    requirementRevision: 1, resolverRef:'actor',deliveryKey:'answer-one',status:'verified',responseRef:'approved-one' }));
  const result = await child(s,'resume');
  assert.equal(result.value,'succeeded'); assert.equal(ok(await s.journal.load(identity)).identity.jobId,identity.jobId);
  const state = ok(await s.states.load(identity,s.authority()));
  assert.equal((state.state.match(/Proceed with the approved synthetic item/g)??[]).length > 0,true);
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,1);
});
function child(s,mode) {
  return new Promise((resolve,reject) => {
    const p = fork(new URL('./helpers/agent-process.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});
    const timeout = setTimeout(() => { p.kill('SIGKILL'); reject(Error('CHILD_TIMEOUT')); },15_000);
    p.once('error',reject);
    p.once('message',message => {
      if (mode === 'crash') { p.kill('SIGKILL'); p.once('exit',() => {clearTimeout(timeout);resolve(message);}); }
      else { p.once('exit',() => {clearTimeout(timeout);resolve(message);}); }
    });
    p.send({schema:s.harness.schema,key:s.key,mode});
  });
}
test('SIGKILL after provider mutation reconciles across processes without duplicate execution', async t => {
  const s = await setup(t);
  assert.equal((await child(s,'crash')).event,'provider_committed');
  await new Promise(r => setTimeout(r,1400));
  const result = await child(s,'recover');
  assert.equal(result.value,'succeeded');
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,1);
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome,'verified');
  assert.equal((await s.client.query(`SELECT sum(attempts)::int AS attempts FROM ${s.harness.table('synthetic_provider')}`)).rows[0].attempts,1);
});
test('unknown external effect waits for reconciliation; schedule wake cannot authorize replay', async t => {
  const s = await setup(t,{state:{uncertain:true}});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome,'unknown');
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,0);
  s.state.uncertain=false; s.state.resolution={receiptRef:'reconciliation-wake'};
  ok(await s.runtime.resume(identity));
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
});
test('tenant isolation, revoked and changed grants deny private state and execution', async t => {
  const s = await setup(t,{wait:true});
  const other = {...identity,host:{...identity.host,tenantRef:'other'}};
  assert.equal((await s.runtime.wake(other)).ok,false);
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  assert.equal((await s.states.load(other,{...s.authority(),host:other.host})).ok,false);
  s.state.denied=true; assert.equal((await s.runtime.resume(identity)).ok,false);
  s.state.denied=false; s.state.grantRevision=2; s.state.resolution={receiptRef:'stale-approval'};
  assert.equal((await s.runtime.resume(identity)).ok,false);
  assert.equal((await s.states.load(identity,s.authority())).ok,false);
});
test('provider failure retains checkpoint and retry recovers without repeating completed tools', async t => {
  let failed=false;
  const s = await setup(t,{modelHooks:{before: async request => {
    if (!failed && Array.isArray(request.input) && request.input.some(i=>i.type==='function_call_result')) {
      failed=true; throw Error('PRIVATE_TRANSPORT_FAILURE');
    }
  }}});
  assert.equal(ok(await s.runtime.wake(identity)),'retryable');
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  assert.equal(s.calls.filter(c=>c.input.topic==='inventory').length,1);
  assert.ok(!JSON.stringify(s.events).includes('PRIVATE_TRANSPORT_FAILURE'));
});
test('process stop resumes checkpoint; explicit durable Stop fences late output and remains terminal', async t => {
  let entered, release;
  const started = new Promise(r=>entered=r), hold = new Promise(r=>release=r);
  const s = await setup(t,{read:async () => {entered();await hold;return 'late result';}});
  const pending = s.runtime.wake(identity); await started;
  const snap = ok(await s.journal.load(identity));
  ok(await s.cancel.stop({command:'cancel',identity,expectedRevision:snap.revision,reason:'explicit_stop'},'actor'));
  release(); await pending;
  assert.equal(ok(await s.journal.load(identity)).state,'cancelled');
  assert.equal(ok(await s.runtime.wake(identity)),'cancelled');
  assert.equal((await s.runtime.resume(identity)).ok,false);
});
test('process shutdown aborts model transport and fresh runtime recovers same job', async t => {
  let entered; const started=new Promise(r=>entered=r);
  const s = await setup(t,{modelHooks:{before:async r=>{entered();await new Promise(resolve=>r.signal.addEventListener('abort',resolve,{once:true}));throw Error('aborted');}}});
  const pending=s.runtime.wake(identity);await started;await s.runtime.stop();
  assert.equal(ok(await pending),'stopped');
  const next=await services(s.harness.schema,s.key);t.after(()=>next.close());
  assert.equal(ok(await next.runtime.wake(identity)),'succeeded');
});
test('invalid tool schema cannot mutate and repeated provider failure is bounded', async t => {
  const s=await setup(t,{scenario:'invalid',limits:{maxDispatches:1}});
  assert.equal(ok(await s.runtime.wake(identity)),'retryable');
  assert.equal(ok(await s.runtime.wake(identity)),'failed');
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,0);
});
test('lost lease during a pending read prevents tool result and terminal writes', async t => {
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const s=await setup(t,{read:async()=>{entered();await hold;return 'late';}});
  const pending=s.runtime.wake(identity);await started;
  await s.client.query(`UPDATE ${s.harness.table('jobs')} SET lease_expires_at=0 WHERE job_id=$1`,[identity.jobId]);
  release(); await pending;
  assert.equal(ok(await s.journal.load(identity)).state,'running');
  assert.equal(Object.keys(ok(await s.states.load(identity,s.authority())).results).length,0);
  const next=await services(s.harness.schema,s.key);t.after(()=>next.close());
  assert.equal(ok(await next.runtime.wake(identity)),'succeeded');
});
test('model context bound fails durably and oversized private state is not committed', async t => {
  const s=await setup(t,{limits:{maxContextBytes:100}});
  assert.equal(ok(await s.runtime.wake(identity)),'failed');
  assert.equal(ok(await s.journal.load(identity)).state,'failed');
  assert.equal(s.model.requests,0);
});
test('concurrent delivery is lease fenced; a second worker cannot execute tools', async t => {
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const s=await setup(t,{read:async()=>{entered();await hold;return 'bounded';}});
  const pending=s.runtime.wake(identity);await started;
  const next=await services(s.harness.schema,s.key);t.after(()=>next.close());
  assert.equal(ok(await next.runtime.wake(identity)),'busy');
  release();assert.equal(ok(await pending),'succeeded');
  assert.equal(next.model.requests,0);
});
test('Runner Vault tool composes real custody/grants/effects and never exposes the private token', async t => {
  const { createSecretKey }=await import('node:crypto');
  const { z }=await import('zod');
  const { createVaultUse }=await import('../.reference-build/src/server/vault-use.js');
  const { createVaultGrants,vaultEffectRequest }=await import('../.reference-build/reference/node/vault-grants.js');
  const { createVaultStore }=await import('../.reference-build/reference/node/vault-store.js');
  const { referenceDatabase }=await import('../.reference-build/reference/node/db/database.js');
  const { vaultTables }=await import('../.reference-build/reference/node/db/schema.js');
  let use,request,grants,s;
  const privateToken=randomBytes(24).toString('hex');let reads=0;
  const reserve={name:'reserve',description:'Use a synthetic private token in a private executor.',kind:'vault',
    parameters:z.object({itemRef:z.literal('synthetic-item')}).strict(),
    bind:async call=>{
      if(!request) {
        const current=ok(await s.journal.load(identity));
        request={identity,jobRevision:current.revision,grantRef:'private-use',grantRevision:1,
          effect:{effectRef:call.effectRef,actionRef:'use',operationRef:'private-request'},operation:'server_request',
          item:{metadata:{kind:'token',tokenType:'api'},reference:{kind:'secret',itemRef:'private-item',revision:1}},
          destination:{endpoint:'https://fixture.invalid/setup',method:'POST',resourceRef:'approved-resource',redirects:'deny'}};
        const now=Date.now();
        ok(await grants.administration.put({request,issuedAt:now,expiresAt:now+30000,state:'active',
          permissions:{use:true,reveal:false,export:false},itemExpiresAt:now+60000,taskExpiresAt:now+60000},0));
      }
      return request;
    },vault:{execute:(...args)=>use.execute(...args)}};
  s=await setup(t,{reserve});
  const db=referenceDatabase(s.pool),key=createSecretKey(randomBytes(32));
  const keys={active:async()=>({keyHandle:'vault-fixture',keyVersion:1}),resolve:async()=>key};
  const storage={authorize:async()=>identity.host};
  const custody=createVaultStore(db,storage,keys,vaultTables(s.harness.schema));
  ok(await custody.create({metadata:{kind:'token',tokenType:'api'},reference:{kind:'secret',itemRef:'private-item',revision:1}},{token:privateToken}));
  grants=createVaultGrants(db,{now:Date.now,withOwner:async(_i,_op,run)=>run(identity.host)},keys,s.harness.schema);
  let verified=false;
  use=createVaultUse({now:Date.now,withAuthority:async(_r,_phase,run)=>run({...s.authority(),actorRef:'actor'})},grants.use,[{
    operationRef:'private-request',bind:r=>vaultEffectRequest(r,'fixture-vault-provider'),
    reconcile:async()=>verified?'verified':'not_applied',
    dispatch:async(_r,value,_signal,isCurrent)=>{assert.equal(isCurrent(),true);assert.equal(value.token,privateToken);reads++;verified=true;return 'verified';},
  }]);
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  assert.equal(reads,1);
  const state=ok(await s.states.load(identity,s.authority()));
  const events=(await s.client.query(`SELECT event FROM ${s.harness.table('job_events')}`)).rows;
  assert.ok(!JSON.stringify([state,events,s.events]).includes(privateToken));
});
test('revocation after model approval is checked immediately before mutation dispatch', async t => {
  const s=await setup(t);
  s.host.decide=async call=>{if(call.toolName==='reserve')s.state.denied=true;return 'approve';};
  const result=await s.runtime.wake(identity);
  assert.equal(result.ok,false);assert.equal(result.code,'not_authorized');
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,0);
});
test('unknown first effect stops other tools emitted in the same model response', async t => {
  const model={async getResponse(){throw Error();},async *getStreamedResponse(){
    yield {type:'response_done',response:{id:'two-calls',usage:{requests:1,inputTokens:1,outputTokens:1,totalTokens:2},
      output:['first','second'].map(callId=>({type:'function_call',name:'reserve',callId,arguments:JSON.stringify({itemRef:'synthetic-item'})}))}};
  }};
  const s=await setup(t,{model,state:{uncertain:true}});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  assert.equal(ok(await s.journal.load(identity)).effects.length,1);
  assert.equal((await s.client.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rowCount,0);
});
test('official OpenAI Responses provider/client drive Runner through simulated HTTP SSE transport', async t => {
  const { default: OpenAI }=await import('openai');
  const { OpenAIProvider }=await import('@openai/agents');
  let requests=0;
  const client=new OpenAI({apiKey:'synthetic-fixture-only',baseURL:'https://model.fixture.invalid/v1',maxRetries:0,
    fetch:async (url,options)=>{
      assert.equal(String(url),'https://model.fixture.invalid/v1/responses');
      const body=JSON.parse(options.body);requests++;
      assert.equal(body.stream,true);assert.equal(body.store,false);
      const n=body.input.filter(i=>i.type==='function_call_output').length;
      const toolName=n===1?'reserve':'lookup';
      const args=n===1?{itemRef:'synthetic-item'}:{topic:n===0?'inventory':'receipt'};
      const output=n<3?[{type:'function_call',id:`fc-${n}`,call_id:`http-${n}`,name:toolName,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'HTTP transport completed.',annotations:[]}]}];
      const response={id:`resp-${n}`,object:'response',created_at:1,status:'completed',output,
        usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
      return new Response(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response,sequence_number:0})}\n\n`,
        {headers:{'content-type':'text/event-stream'}});
    }});
  const provider=new OpenAIProvider({openAIClient:client,useResponses:true});t.after(()=>provider.close());
  const s=await setup(t,{model:await provider.getModel('fixture-model')});
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(requests,4);
  const state=ok(await s.states.load(identity,s.authority()));
  assert.equal(state.output,'HTTP transport completed.');assert.equal(state.usage.requests,4);
  assert.equal((await s.client.query(`SELECT sum(attempts)::int AS attempts FROM ${s.harness.table('synthetic_provider')}`)).rows[0].attempts,1);
});
