import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { z } from 'zod';
import { Agent, Runner } from '@openai/agents';
import { createConversationSession, createConversationAgentRuntime, createDelegatedWorkAdapter, compactConversation } from 'handrail-agent-sdk/server/conversation';
import { createPostgresHarness, migrations } from './database.mjs';
import { conversationHost, scope, entry, replyModel } from './conversation-host.mjs';
import { services, identity } from './host.mjs';
const ok=r=>{assert.equal(r.ok,true,r.code);return r.value;};
async function setup(t,options={}){
  const h=await createPostgresHarness();t.after(()=>h.cleanup());await migrations(t,h);
  const key=randomBytes(32).toString('hex'),c=conversationHost(h.pool,h.schema,key,options);
  return {h,key,c};
}
const effect={identity,effectRef:'delegation-original',idempotencyRef:'delegation-original',actionRef:'delegate',operationRef:'native-work',providerRef:'executor',requestDigest:`sha256:${'1'.repeat(64)}`};
const binding={effect,originEntryId:'obligation',instructionRevision:1};
const completed={revision:4,instructionRevision:1,status:'completed',reference:'native-receipt-original',result:entry('callback','Verified delegated result.','assistant')};
const child=(payload)=>new Promise((resolve,reject)=>{
  const p=fork(new URL('./conversation-process.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});
  let result;p.on('message',m=>{result=m;});p.on('error',reject);p.on('exit',code=>code===0?resolve(result):reject(Error(`child:${code}`)));p.send(payload);
});

test('canonical long conversation survives bounded context, upstream Runner session and compaction with exact pinned roles',async t=>{
  const {c}=await setup(t);
  await c.append(scope,entry('obligation','Report original request abc-123 only after approval xyz-9.'));
  await c.pin(scope,'pending-approval',0,'obligation');
  await c.append(scope,entry('correction','Correction: use the blue project, never the red one.'));
  await c.pin(scope,'correction',0,'correction');
  const agent=new Agent({name:'continuous',model:replyModel(r=>{
    assert.ok(Buffer.byteLength(JSON.stringify(r.input))<5000);
    assert.ok(JSON.stringify(r.input).includes('abc-123'));
    assert.ok(JSON.stringify(r.input).includes('blue project'));
  })});
  const runner=new Runner({tracingDisabled:true});
  for(let i=0;i<45;i++){
    const session=createConversationSession(c,scope,`turn-${i}`);
    const r=await runner.run(agent,`Question ${i}: ${'detail '.repeat(30)}`,{session,stream:true});
    for await(const _ of r){}await r.completed;assert.equal(r.finalOutput,'Quick answer');
    if(i===20) await compactConversation({conversation:c,scope,model:'gpt-4.1',client:{responses:{compact:async request=>{
      assert.ok(Array.isArray(request.input));assert.equal(request.previous_response_id,undefined);
      return {output:[{type:'compaction',id:'compact-one',encrypted_content:'simulated-compaction-boundary'}],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
    }}}});
  }
  const view=await c.context(scope);assert.ok(view.omitted>30);assert.ok(view.compactedThrough>0);
  let after=0,all=[];do{const p=await c.read(scope,after);all.push(...p.entries);after=p.next;}while(after!==null);
  assert.ok(all.length>=47);assert.equal(all[0].entry.items[0].role,'user');assert.match(JSON.stringify(all),/Question 0/);
  await assert.rejects(c.compact(scope,1,[]),/REVISION_CONFLICT/);
  await assert.rejects(c.append(scope,entry('obligation','changed')),/ID_CONFLICT/);
});

test('memory retains scoped revisions and lasting metadata, while forget erases historical payloads',async t=>{
  const {h,key,c}=await setup(t);
  const lasting={text:'Prefer concise updates',validUntil:null,metadata:{title:'Communication',project_id:'blue'},
    provenance:[{sourceRef:'owner-source',role:'user',observedAt:90}]};
  await c.memory.revise(scope,'preference',0,lasting);
  await c.memory.revise(scope,'preference',1,{...lasting,text:'Use one short paragraph'});
  await c.memory.revise(scope,'preference',2,{...lasting,text:'Include verification evidence'});
  const reopened=conversationHost(h.pool,h.schema,key,{now:9000000000});
  assert.equal((await reopened.memory.read(scope,'preference')).stale,false);
  assert.equal((await reopened.memory.readRevision(scope,'preference',1)).value.text,lasting.text);
  assert.deepEqual((await reopened.memory.readRevision(scope,'preference',1)).value.metadata,lasting.metadata);
  const page=await reopened.memory.history(scope,'preference',undefined,2);
  assert.deepEqual(page.entries.map(row=>row.revision),[3,2]);assert.equal(page.next,2);
  assert.deepEqual(page.unavailableRevisions,[]);
  assert.deepEqual((await reopened.memory.history(scope,'preference',page.next,2)).entries.map(row=>row.revision),[1]);
  assert.equal(await reopened.memory.readRevision({...scope,userRef:'other'},'preference',1),null);
  assert.deepEqual((await reopened.memory.history({...scope,tenantRef:'other'},'preference')).entries,[]);
  await assert.rejects(reopened.memory.revise(scope,'preference',2,lasting),/REVISION_CONFLICT/);
  assert.equal((await reopened.memory.history(scope,'preference')).entries.length,3,'conflicting edits do not append history');
  await reopened.memory.revise(scope,'preference',3,null);
  const forgotten=await reopened.memory.history(scope,'preference');
  assert.deepEqual(forgotten.entries.map(row=>row.revision),[4,3,2,1]);
  assert.ok(forgotten.entries.every(row=>row.status==='forgotten'&&row.value===undefined));
  assert.equal((await reopened.memory.readRevision(scope,'preference',1)).value,undefined);
  const denied=conversationHost(h.pool,h.schema,key,{denied:()=>true});
  await assert.rejects(denied.memory.history(scope,'preference'),/DENIED/);
  await assert.rejects(denied.memory.readRevision(scope,'preference',1),/DENIED/);
});

test('memory current value and revision history commit together and report older missing history explicitly',async t=>{
  let fail=false;
  const {h,key,c}=await setup(t,{wrapStorage:storage=>({transaction:(scope,run)=>storage.transaction(scope,tx=>run({...tx,
    put:async(collection,record)=>{if(fail&&collection==='memory'){fail=false;throw Error('MEMORY_WRITE_FAILED');}return tx.put(collection,record);}
  }))})});
  const value={text:'Original guidance',validUntil:null,provenance:[{sourceRef:'original',role:'user',observedAt:90}]};
  await c.memory.revise(scope,'preference',0,value);fail=true;
  await assert.rejects(c.memory.revise(scope,'preference',1,{...value,text:'Uncommitted correction'}),/MEMORY_WRITE_FAILED/);
  const reopened=conversationHost(h.pool,h.schema,key);
  assert.equal((await reopened.memory.read(scope,'preference')).value.text,value.text);
  assert.equal(await reopened.memory.readRevision(scope,'preference',2),null);
  assert.deepEqual((await reopened.memory.history(scope,'preference')).entries.map(row=>row.revision),[1]);
  await reopened.memory.revise(scope,'preference',1,{...value,text:'Existing SDK current value'});
  // A pre-history SDK database has only the current row, not invented snapshots.
  await h.pool.query(`DELETE FROM ${h.table('conversation_records')} WHERE collection='memory_history'`);
  await reopened.memory.revise(scope,'preference',2,{...value,text:'Next correction'});
  const history=await reopened.memory.history(scope,'preference');
  assert.deepEqual(history.entries.map(row=>row.revision),[3,2]);assert.deepEqual(history.unavailableRevisions,[1]);
  assert.equal((await reopened.memory.readRevision(scope,'preference',2)).value.text,'Existing SDK current value');
});

test('memory revise/forget, stale reads, scope isolation and authorization are durable',async t=>{
  let denied=false;const {h,key,c}=await setup(t,{denied:()=>denied});
  const value={text:'Prefer blue',validUntil:200,provenance:[{sourceRef:'owner-correction-1',role:'user',observedAt:90}]};
  assert.equal(await c.memory.revise(scope,'preference',0,value),1);
  await c.memory.revise({tenantRef:scope.tenantRef,userRef:scope.userRef},'global',0,value);
  assert.equal((await c.memory.read({...scope,conversationRef:undefined},'global')).value.text,value.text);
  assert.equal(await c.memory.read({...scope,userRef:'other'},'preference'),null);
  assert.equal(await c.memory.read({...scope,tenantRef:'other'},'preference'),null);
  assert.equal(await c.memory.read({...scope,conversationRef:'other'},'preference'),null);
  assert.equal((await conversationHost(h.pool,h.schema,key,{now:201}).memory.read(scope,'preference')).stale,true);
  const results=await Promise.allSettled([c.memory.revise(scope,'preference',1,{...value,text:'Prefer green'}),c.memory.revise(scope,'preference',1,{...value,text:'Prefer red'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await c.memory.revise(scope,'preference',2,null);
  const forgotten=await c.memory.read(scope,'preference');assert.equal(forgotten.status,'forgotten');assert.equal(forgotten.value,undefined);
  denied=true;await assert.rejects(c.memory.read(scope,'preference'),/DENIED/);await assert.rejects(c.memory.revise(scope,'preference',3,value),/DENIED/);
  const raw=(await h.pool.query(`SELECT payload FROM ${h.table('conversation_records')}`)).rows;assert.ok(!JSON.stringify(raw).includes('Prefer'));
});

for(const consumer of ['personal-assistant','industrial-inspection']) test(`${consumer}: same durable composition replies while delegated native work survives fresh-process callback/replay`,async t=>{
  const {h,key,c}=await setup(t);await c.append(scope,entry('obligation',consumer==='personal-assistant'?'Prepare travel options; wait for my approval to book.':'Inspect turbine evidence; never authorize a shutdown.'));
  const head=await c.append(scope,entry('question','Give me a quick update.'));
  await c.work.bind(scope,binding);
  await c.work.observe(scope,effect.effectRef,{revision:1,instructionRevision:1,status:'active',reference:'native-job-original'});
  await c.memory.revise(scope,'preference',0,{text:'Original exact reference xyz',validUntil:200,provenance:[{sourceRef:'obligation',role:'user',observedAt:90}]});
  const deltas=[],reads=[];
  const industrial=consumer==='industrial-inspection';
  const readTool={name:industrial?'vibration':'travel_options',description:'Read authorized domain facts.',kind:'read',
    parameters:industrial?z.object({sensor:z.string(),windowSeconds:z.number()}):z.object({destination:z.string()}),
    execute:async call=>{reads.push(call.input);return industrial?'RMS 2.7 mm/s; inspection only.':'Two refundable travel options.';}};
  const quick=replyModel();
  const model={...quick,async *getStreamedResponse(request){
    if(request.input.some(i=>i.type==='function_call_result')){yield* quick.getStreamedResponse(request);return;}
    yield {type:'response_done',response:{id:'domain-read',output:[{type:'function_call',name:readTool.name,callId:'domain-call',arguments:JSON.stringify(industrial?{sensor:'turbine-7',windowSeconds:300}:{destination:'Boston'})}],usage:{requests:1,inputTokens:5,outputTokens:4,totalTokens:9}}};
  }};
  const s=await services(h.schema,key,{tools:[readTool],model,host:{textDelta:(_id,delta)=>{deltas.push(delta);throw Error('observer closed');}},
    runtimeFactory:deps=>createConversationAgentRuntime({...deps,conversation:c,turn:async()=>({scope,head})})});t.after(()=>s.close());
  ok(await s.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'agent-task',inputRefs:{}},event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}}));
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.deepEqual(deltas,['Quick answer']);assert.equal(reads.length,1);assert.deepEqual(reads[0],industrial?{sensor:'turbine-7',windowSeconds:300}:{destination:'Boston'});
  assert.equal((await c.work.read(scope,effect.effectRef)).observation.status,'active');
  const result=await child({schema:h.schema,key,effectRef:effect.effectRef,observation:completed});assert.equal(result.applied,'applied');assert.equal(result.memory.value.text,'Original exact reference xyz');
  assert.equal((await child({schema:h.schema,key,effectRef:effect.effectRef,observation:completed})).applied,'duplicate');
  const transcript=await c.read(scope);assert.equal(transcript.entries.filter(e=>JSON.stringify(e).includes('Verified delegated result.')).length,1);
  assert.equal(await c.work.observe(scope,effect.effectRef,{revision:2,instructionRevision:1,status:'paused',reference:'pause'}),'stale');
  await assert.rejects(c.work.observe(scope,effect.effectRef,{...completed,result:entry('callback','conflict')}),/CALLBACK_CONFLICT/);
  await assert.rejects(c.work.observe(scope,effect.effectRef,{revision:5,instructionRevision:1,status:'active',reference:'late'}),/TERMINAL_CONFLICT/);
});

test('delegated executor preserves native receipt and uncertainty; correction and revoked callback cannot deliver',async t=>{
  let denied=false;const {c}=await setup(t,{denied:(_s,op)=>denied&&op==='callback'});await c.append(scope,entry('obligation','Do native work'));await c.work.bind(scope,binding);
  let dispatched=0;
  const adapter=createDelegatedWorkAdapter({conversation:c,resolve:async()=>({scope,originEntryId:'obligation'}),executor:{dispatch:async b=>{assert.deepEqual(b,binding);dispatched++;return {outcome:'verified',receiptRef:'original-native-job'};},reconcile:async()=>({outcome:'unknown'})}});
  assert.deepEqual(await adapter.reconcile(effect,new AbortController().signal),{outcome:'unknown'});assert.equal(dispatched,0);
  assert.equal((await adapter.dispatch(effect,new AbortController().signal)).receiptRef,'original-native-job');
  await c.work.correct(scope,effect.effectRef,1,2);
  await assert.rejects(c.work.observe(scope,effect.effectRef,completed),/INSTRUCTION_CONFLICT/);
  denied=true;await assert.rejects(c.work.observe(scope,effect.effectRef,{...completed,instructionRevision:2}),/DENIED/);
  assert.equal((await c.read(scope)).entries.length,1);
});

test('large RunState is paged under explicit quota; actual Runner and encrypted reload exceed 64KiB without raising envelope bound',async t=>{
  const {h,key}=await setup(t);const text='Large valid context '.repeat(3000);
  const s=await services(h.schema,key,{tools:[],model:replyModel(),checkpointQuotaBytes:600_000,limits:{maxContextBytes:150_000},host:{input:async()=>text}});t.after(()=>s.close());
  ok(await s.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'agent-task',inputRefs:{}},event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}}));
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  const checkpoint=ok(await s.states.load(identity,s.authority()));assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))>65_536);
  assert.deepEqual(await child({schema:h.schema,key,mode:'checkpoint'}),{digest:createHash('sha256').update(text).digest('hex'),output:'Quick answer'});
  const row=(await h.pool.query(`SELECT envelope FROM ${h.table('agent_run_states')}`)).rows[0].envelope;
  assert.equal(row.format,'pages-v1');assert.ok(row.pages.length>1);assert.ok(row.pages.every(p=>Buffer.from(p.ciphertext,'base64').length<65_536));
  // Tampering/reordering cannot be accepted as a checkpoint.
  [row.pages[0],row.pages[1]]=[row.pages[1],row.pages[0]];
  await h.pool.query(`UPDATE ${h.table('agent_run_states')} SET envelope=$1`,[row]);assert.equal((await s.states.load(identity,s.authority())).ok,false);
});

test('real Runner delegates through existing durable effect ledger and returns without awaiting native work',async t=>{
  const {h,key,c}=await setup(t);const head=await c.append(scope,entry('obligation','Delegate the long inspection and reply immediately.'));
  const receipts=new Map();let dispatches=0,delegated;
  const adapter=createDelegatedWorkAdapter({conversation:c,resolve:async()=>({scope,originEntryId:'obligation'}),executor:{
    reconcile:async b=>receipts.has(b.effect.idempotencyRef)?{outcome:'verified',receiptRef:receipts.get(b.effect.idempotencyRef)}:{outcome:'not_applied',evidenceRef:'serial-native-proof'},
    dispatch:async b=>{delegated=b;dispatches++;receipts.set(b.effect.idempotencyRef,'native-job-77');return {outcome:'verified',receiptRef:'native-job-77'};},
  }});
  const quick=replyModel(),model={...quick,async *getStreamedResponse(r){
    if(r.input.some(i=>i.type==='function_call_result')){yield* quick.getStreamedResponse(r);return;}
    yield {type:'response_done',response:{id:'delegate-response',output:[{type:'function_call',callId:'delegate-1',name:'delegate',arguments:'{}'}],usage:{requests:1,inputTokens:10,outputTokens:2,totalTokens:12}}};
  }};
  const s=await services(h.schema,key,{model,adapter,tools:[{name:'delegate',description:'Admit approved long work.',kind:'effect',parameters:z.object({}),bind:async call=>({...effect,identity:call.identity,effectRef:call.effectRef,idempotencyRef:call.effectRef})}],
    runtimeFactory:deps=>createConversationAgentRuntime({...deps,conversation:c,turn:async()=>({scope,head})})});t.after(()=>s.close());
  ok(await s.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'agent-task',inputRefs:{}},event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}}));
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(dispatches,1);
  assert.equal((await c.work.read(scope,delegated.effect.effectRef)).observation,undefined);
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(dispatches,1);
  const returned=await child({schema:h.schema,key,effectRef:delegated.effect.effectRef,observation:completed});assert.equal(returned.applied,'applied');
});

test('compaction racing a correction cannot replace newer context; overfull pins fail explicitly',async t=>{
  const {h,key,c}=await setup(t);await c.append(scope,entry('one','original'));await c.pin(scope,'direction',0,'one');
  await assert.rejects(compactConversation({conversation:c,scope,model:'gpt-4.1',client:{responses:{compact:async()=>{
    await c.pin(scope,'direction',1,null);
    return {output:[{type:'compaction',id:'old',encrypted_content:'old-context'}]};
  }}}}),/REVISION_CONFLICT/);
  assert.equal((await c.context(scope)).compactedThrough,0);
  await c.append(scope,entry('large','must preserve '.repeat(30)));await c.pin(scope,'required',0,'large');
  const small=conversationHost(h.pool,h.schema,key,{maxContextBytes:200});await assert.rejects(small.context(scope),/CONTEXT_CAPACITY/);
});

test('reply committed before job checkpoint failure recovers its original receipt without a second canonical reply',async t=>{
  const {h,key,c}=await setup(t);const head=await c.append(scope,entry('turn','Quick question'));
  let fail=true,verified=0;
  const s=await services(h.schema,key,{tools:[],model:replyModel(),host:{output:async(_id,text)=>{verified++;return {text,receiptRef:'original-output-receipt'};}},runtimeFactory:deps=>createConversationAgentRuntime({...deps,
    states:{...deps.states,commit:async(...args)=>{if(args[3].kind==='succeeded'&&fail){fail=false;return {ok:false,code:'unavailable'};}return deps.states.commit(...args);}},
    conversation:c,turn:async()=>({scope,head})})});t.after(()=>s.close());
  ok(await s.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'agent-task',inputRefs:{}},event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}}));
  assert.equal((await s.runtime.wake(identity)).ok,false);
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(verified,1);
  const replies=(await c.read(scope)).entries.filter(e=>e.entry.receiptRef);assert.equal(replies.length,1);assert.equal(replies[0].entry.receiptRef,'original-output-receipt');
});

test('pause/wait observations keep work; concurrent terminal callbacks deliver at most once and cancelled work cannot reopen',async t=>{
  const {c}=await setup(t);await c.append(scope,entry('obligation','Do work'));await c.work.bind(scope,binding);
  await c.work.observe(scope,effect.effectRef,{revision:1,instructionRevision:1,status:'paused',reference:'native-pause'});
  assert.match(JSON.stringify((await c.context(scope)).items),/paused/);
  await c.work.observe(scope,effect.effectRef,{revision:2,instructionRevision:1,status:'waiting',reference:'approval-original'});
  assert.match(JSON.stringify((await c.context(scope)).items),/approval-original/);
  const r=await Promise.allSettled([c.work.observe(scope,effect.effectRef,{revision:4,instructionRevision:1,status:'cancelled',reference:'native-cancel'}),c.work.observe(scope,effect.effectRef,completed)]);
  assert.ok(r.some(x=>x.status==='fulfilled'));
  const work=await c.work.read(scope,effect.effectRef);const results=(await c.read(scope)).entries.filter(e=>e.entry.id.startsWith('work:'));
  assert.equal(results.length,work.observation.status==='completed'?1:0);
  await assert.rejects(c.work.observe(scope,effect.effectRef,{revision:5,instructionRevision:1,status:'active',reference:'reopen'}),/TERMINAL_CONFLICT/);
});
