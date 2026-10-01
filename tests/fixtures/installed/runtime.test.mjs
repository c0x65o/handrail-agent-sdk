import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createPostgresHarness } from './database.mjs';
import { migrations } from './database.mjs';
import { services, identity, modelBoundary, requirement } from './host.mjs';
const ok = r => { assert.equal(r.ok,true,r.code); return r.value; };

test('host structured history survives an approval checkpoint without flattening roles or image references', async t => {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Check this controlled fixture.' },
    { type: 'input_image', image: 'fixture-image-reference', detail: 'low' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect the fixture.' }], status: 'completed' }];
  const s = await setup(t, { wait: true, host: { input: async () => input } });
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  const checkpoint = ok(await s.states.load(identity, s.authority()));
  assert.deepEqual(checkpoint.input, input);
  assert.ok(checkpoint.state.includes('fixture-image-reference'));
  const next = await services(s.harness.schema, s.key); t.after(() => next.close());
  assert.deepEqual(ok(await next.states.load(identity, next.authority())).input, input);
});

test('verified effects expose bounded host results and a failed result read never repeats the effect', async t => {
  let reads = 0;
  const s = await setup(t, { readEffectResult: async (_call, receipt) => {
    assert.equal(receipt.outcome, 'verified');
    if (++reads === 1) throw Error('private result read unavailable');
    return JSON.stringify({ canonicalRecordId: 'synthetic-reservation', version: 1 });
  } });
  const first = await s.runtime.wake(identity);
  assert.equal(ok(first), 'retryable');
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  const state = ok(await s.states.load(identity, s.authority()));
  assert.ok(Object.values(state.results).some(r => r.output.includes('synthetic-reservation')));
  assert.equal((await s.client.query(`SELECT sum(attempts)::int AS attempts FROM ${s.harness.table('synthetic_provider')}`)).rows[0].attempts, 1);
  assert.ok(!JSON.stringify(state).includes('private result read unavailable'));
});

test('unknown effects cannot release a domain result', async t => {
  let reads = 0;
  const s = await setup(t, { state: { uncertain: true }, readEffectResult: async () => { reads++; return 'must not escape'; } });
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  assert.equal(reads, 0);
});
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
    const p = fork(new URL('./process.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});
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

test('current catalog hides unauthorized tools and opaque attachments resolve only at model boundary', async t => {
  const history=[{role:'user',content:[{type:'input_image',image:'opaque:owned-image'}]}];
  let prepared=0, seen=0;
  const s=await setup(t,{host:{input:async()=>history,visibleTools:async()=>['lookup'],
    prepareModelInput:async(_identity,input)=>{prepared++;assert.equal(input[0].content[0].image,'opaque:owned-image');return [{role:'user',content:[{type:'input_text',text:'authorized attachment fixture'}]}];}},
    model:{async getResponse(){throw Error('stream expected');},async *getStreamedResponse(request){
      seen++;assert.deepEqual(request.tools.map(t=>t.name),['lookup']);assert.equal(request.input[0].content[0].text,'authorized attachment fixture');
      yield {type:'response_done',response:{id:'attachment-response',usage:{requests:1,inputTokens:1,outputTokens:1,totalTokens:2},
        output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Attachment inspected.'}]}]}};
    }}});
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(prepared,1);assert.equal(seen,1);
  const state=ok(await s.states.load(identity,s.authority()));assert.deepEqual(state.input,history);
  assert.ok(!JSON.stringify(state).includes('authorized attachment fixture'));
});

test('concurrent tenant scopes share a namespace without sharing state or effects; stale correction is fenced', async t => {
  const s = await setup(t);
  const second = { ...identity, jobId: 'second-job', host: { ...identity.host, tenantRef: 'second-tenant' } };
  const other = await services(s.harness.schema, s.key, { identity: second }); t.after(() => other.close());
  ok(await other.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'agent-task', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity: second, revision: 1, state: 'queued', effects: [] } } }));
  assert.deepEqual((await Promise.all([s.runtime.wake(identity), other.runtime.wake(second)])).map(ok), ['succeeded','succeeded']);
  assert.equal((await s.states.load(second,s.authority())).ok,false);
  assert.equal((await other.admission.inspectAdmission(identity.jobId,{namespaceRef:'fixture',host:second.host,grantRevision:1})).ok,false);
  const correction = { ...identity, instructionRevision: 2 };
  assert.equal((await s.journal.load(correction)).ok,false);
  assert.equal((await s.runtime.wake(correction)).ok,false);
  assert.equal((await s.states.load(correction,s.authority())).ok,false);
  assert.equal((await s.client.query(`SELECT sum(attempts)::int AS n FROM ${s.harness.table('synthetic_provider')}`)).rows[0].n,2);
});

test('native answer retries are identical, changed delivery conflicts, and revoked actor cannot answer', async t => {
  const s = await setup(t,{wait:true});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const waiting = ok(await s.journal.load(identity));
  const challenge = {identity,requirement:waiting.requirement,jobRevision:waiting.revision,expiresAt:Date.now()+60000,resolverRef:'actor'};
  ok(await s.answer.issue(challenge));
  const delivery = {identity,requirementRef:waiting.requirement.requirementRef,requirementRevision:1,resolverRef:'actor',deliveryKey:'native-one',status:'verified',responseRef:'approved-one'};
  s.state.denied=true;assert.equal((await s.answer.complete(delivery)).ok,false);s.state.denied=false;
  assert.equal(ok(await s.answer.complete(delivery)).replayed,false);
  assert.equal(ok(await s.answer.complete(delivery)).replayed,true);
  assert.equal((await s.answer.complete({...delivery,responseRef:'different'})).ok,false);
  s.state.resolution={receiptRef:'wrong'};assert.equal((await s.runtime.resume(identity)).ok,false);
  s.state.approved=true;s.state.resolution={receiptRef:'approved-one'};ok(await s.runtime.resume(identity));
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
});

for (const sampling of [undefined, {temperature:0.3,topP:0.8}]) {
  test(`injected official provider ${sampling ? 'accepts configured sampling' : 'rejects temperature; default omits it'}`, async t => {
    const { default: OpenAI } = await import('openai');
    const { OpenAIProvider } = await import('@openai/agents');
    let requests=0;
    const client=new OpenAI({apiKey:'synthetic-fixture-only',maxRetries:0,baseURL:'https://model.fixture.invalid/v1',fetch:async(_url,options)=>{
      const body=JSON.parse(options.body);requests++;
      if(!sampling && Object.hasOwn(body,'temperature'))return new Response(JSON.stringify({error:{type:'invalid_request_error',param:'temperature',message:'unsupported'}}),{status:400});
      if(sampling){assert.equal(body.temperature,sampling.temperature);assert.equal(body.top_p,sampling.topP);}
      else {assert.equal(Object.hasOwn(body,'temperature'),false);assert.equal(Object.hasOwn(body,'top_p'),false);}
      const response={id:'sampling-response',object:'response',created_at:1,status:'completed',output:[{type:'message',id:'sampling-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'Sampling boundary qualified.',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
      return new Response(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response,sequence_number:0})}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }});
    const provider=new OpenAIProvider({openAIClient:client,useResponses:true});t.after(()=>provider.close());
    const s=await setup(t,{model:await provider.getModel('host-approved-fixture-model'),sampling});
    assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(requests,1);
  });
}

test('public migrations serialize, are repeatable, preserve uncertain identities, and reject drift', async t => {
  const {migrateAgentPostgres,agentPostgresMigrations}=await import('handrail-agent-sdk/server/postgres');
  const s=await setup(t,{state:{uncertain:true}});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const before=(await s.client.query(`SELECT * FROM ${s.harness.table('job_effects')}`)).rows;
  await Promise.all([migrateAgentPostgres(s.pool,s.harness.schema),migrateAgentPostgres(s.pool,s.harness.schema)]);
  assert.deepEqual((await s.client.query(`SELECT * FROM ${s.harness.table('job_effects')}`)).rows,before);
  assert.equal((await agentPostgresMigrations(s.harness.schema)).length,8);
  assert.equal((await agentPostgresMigrations(s.harness.schema)).at(-1).id,'0014_conversation_records');
  await assert.rejects(agentPostgresMigrations('public'),/invalid_agent_postgres_schema/);
  await s.client.query(`UPDATE ${s.harness.table('journal_migrations')} SET hash='drift' WHERE id=(SELECT min(id) FROM ${s.harness.table('journal_migrations')})`);
  await assert.rejects(migrateAgentPostgres(s.pool,s.harness.schema),/agent_migration_history_conflict/);
});

test('private state requires host key handles; rotation preserves old decryption and rejects substitution', async t => {
  const {createAgentStateStore}=await import('handrail-agent-sdk/server/postgres');
  const {createSecretKey}=await import('node:crypto');
  const s=await setup(t,{wait:true});assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const original=createSecretKey(Buffer.from(s.key,'hex')), newer=createSecretKey(randomBytes(32));
  const keys={current:async()=>({ref:'rotated-key',key:newer}),resolve:async ref=>ref==='fixture-key'?original:newer};
  const store=createAgentStateStore(s.pool,keys,s.harness.schema);
  assert.equal(ok(await store.load(identity,s.authority())).definitionRef,'fixture-agent-v1');
  const wrong=createAgentStateStore(s.pool,{...keys,resolve:async()=>newer},s.harness.schema);
  assert.equal((await wrong.load(identity,s.authority())).ok,false);
  const absent=createAgentStateStore(s.pool,{...keys,resolve:async()=>{throw Error('host key unavailable');}},s.harness.schema);
  assert.equal((await absent.load(identity,s.authority())).ok,false);
  const waiting=ok(await s.journal.load(identity));
  ok(await s.answer.issue({identity,requirement:waiting.requirement,jobRevision:waiting.revision,expiresAt:Date.now()+60000,resolverRef:'actor'}));
  ok(await s.answer.complete({identity,requirementRef:waiting.requirement.requirementRef,requirementRevision:1,resolverRef:'actor',deliveryKey:'rotation-answer',status:'verified',responseRef:'approved-one'}));
  const answered=ok(await s.journal.load(identity));
  ok(await store.resume(identity,answered.revision,{receiptRef:'approved-one'},s.authority()));
  assert.equal((await s.client.query(`SELECT key_ref FROM ${s.harness.table('agent_run_states')}`)).rows[0].key_ref,'rotated-key');
  assert.ok(ok(await store.load(identity,s.authority())));
  assert.equal((await s.states.load(identity,s.authority())).ok,false); // Old-only resolver cannot read new writes.
  await s.client.query(`UPDATE ${s.harness.table('agent_run_states')} SET key_ref='fixture-key'`);
  assert.equal((await store.load(identity,s.authority())).ok,false);
});

test('bootstrap failure rolls back new tables and preserves an unknown existing table',async t=>{
  const {migrateAgentPostgres}=await import('handrail-agent-sdk/server/postgres');
  const harness=await createPostgresHarness();t.after(()=>harness.cleanup());
  await harness.pool.query(`CREATE SCHEMA "${harness.schema}"`);
  await harness.pool.query(`CREATE TABLE ${harness.table('jobs')}(host_marker text)`);
  await harness.pool.query(`INSERT INTO ${harness.table('jobs')} VALUES ('preserve')`);
  await assert.rejects(migrateAgentPostgres(harness.pool,harness.schema));
  assert.deepEqual((await harness.pool.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[harness.schema])).rows,[{tablename:'jobs'}]);
  assert.deepEqual((await harness.pool.query(`SELECT * FROM ${harness.table('jobs')}`)).rows,[{host_marker:'preserve'}]);
});

if(process.env.HANDRAIL_INSTALLED_BOUNDARY==='1') test('installed fixture actively rejects reference-build module fallback and repository reads',async()=>{
  const {readFile}=await import('node:fs/promises');
  await assert.rejects(import('./.reference-build/probe.mjs'),/INSTALLED_BOUNDARY_VIOLATION/);
  await assert.rejects(readFile(process.env.HANDRAIL_FORBIDDEN_REPO_FILE),{code:'ERR_ACCESS_DENIED'});
});
