import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAgentRuntime } from '../dist/server/agent-runtime.js';
const identity={jobId:'job',originTaskRef:'task',requestKey:'key',instructionRevision:1,
 host:{tenantRef:'tenant',userRef:'user',projectRef:'project',accountRef:'account',environmentRef:'dev',purposeRef:'test'},
 native:{requestRef:'request',rootTaskRef:'root'},origin:{channelRef:'test',routeRef:'route',correlationRef:'trace'}};
const success=value=>({ok:true,value});
function fixture(){
 let snapshot={identity,revision:1,state:'queued',effects:[]},checkpoint=null,sessionBinding,session,turn,denied=false,approved=true;
 let executions=0,messages=0,outputs=0,outputFailure=false,toolResultFailure=false;
 const authority={host:identity.host,grantRevision:1,cancellationRevision:0};
 const host={now:Date.now,newOwnerToken:()=> 'owner',authorize:async()=>denied?null:{host:identity.host,namespaceRef:'test',grantRevision:1},
 withAuthority:async(_id,_op,run)=>denied?{ok:false,code:'not_authorized'}:run(authority),recover:async()=>[identity],input:async()=> 'Do the work',
 withToolAuthority:async(_call,run)=>{if(denied)throw Error('denied');return run();},decide:async()=>approved?'approve':{kind:'approval',requirementRef:'approval',revision:1,actor:{kind:'user',actorRef:'user'}},
 requirement:()=>{throw Error('not expected');},resolveWait:async()=>approved?{receiptRef:'approved'}:null,
 output:async(_id,text)=>{outputs++;if(outputFailure)throw Error('lost local output');return {text,receiptRef:'done'};}};
 const states={checkpointQuotaBytes:1000000,load:async()=>success(structuredClone(checkpoint)),
 commit:async(_id,expected,next,change)=>{assert.equal(expected,checkpoint?.version??0);checkpoint=structuredClone(next);
 if(change.kind!=='checkpoint')snapshot={...snapshot,state:change.kind==='waiting'?'waiting':change.kind,revision:snapshot.revision+1,...(change.kind==='waiting'?{requirement:change.requirement}:{})};return success();},
 resume:async(_id,_revision,resolution)=>{checkpoint={...checkpoint,resolution};snapshot={...snapshot,state:'queued'};return success();}};
 const page=data=>Object.assign(Promise.resolve({data}),{async *[Symbol.asyncIterator](){yield* data;}});
 const sessions={async create(body){session={id:'remote-session',metadata:body.metadata,status:'idle',required_actions:[]};return session;},async retrieve(){return session;},list:()=>page(session?[session]:[]),
 turns:{list:()=>page(turn?[turn]:[]),retrieve:async()=>turn,items:{list:()=>page([{id:'output',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Verified'}]}])}},
 events:{stream:async()=>({controller:{abort(){}},async *[Symbol.asyncIterator](){yield {type:'agent.session.requires_action',session};}}),
 create:async(_id,body)=>{const event=body.events[0];if(event.type==='agent.session.input.message'){
 messages++;turn={id:'provider-turn',session_id:session.id,subagent_id:null,status:'waiting',usage:null};session.status='requires_action';session.required_actions=[{type:'function_call',turn_id:turn.id,call_id:'saved-call',name:'handrail_call_tool',arguments:{name:'reserve',arguments_json:'{"item":"one"}'}}];
 }else if(event.type==='agent.session.input.cancel'){turn.status='cancelled';session.status='idle';session.required_actions=[];
 }else if(event.type==='agent.session.input.tool_result'){
 if(toolResultFailure)throw Error('result send lost');session.required_actions=[];session.status='idle';turn.status='completed';
 }}}};
 const harness={client:{beta:{agents:{sessions}}},model:'test',browser:false,
 session:async(_id,create)=>{sessionBinding??=create(identity.host,'creation');return {get binding(){return sessionBinding;},save:async b=>{sessionBinding=structuredClone(b);}};},
 input:async()=>[{role:'user',content:[{type:'input_text',text:'Do the work'}]}],action:async()=>{throw Error('unexpected browser');},item:async()=>{},usage:async()=>{}};
 const options={definitionRef:'test',instructions:'test',harness,host,states,
 admission:{inspectAdmission:async()=>success({identity})},journal:{load:async()=>success(snapshot)},
 lease:{claim:async()=>success({}),check:async()=>success(),renew:async()=>success({}),release:async()=>success(),append:async change=>{snapshot=change.snapshot;return success();}},
 effects:{execute:async request=>{executions++;assert.equal(request.idempotencyRef,request.effectRef);return success({outcome:'verified',receiptRef:'external'});}},
 tools:[{kind:'effect',name:'reserve',description:'Reserve',parameters:z.object({item:z.string()}).strict(),bind:async call=>({identity,effectRef:call.effectRef,idempotencyRef:call.effectRef})}],
 limits:{maxDispatches:null,maxToolCalls:null,maxElapsedMs:null,maxContextBytes:100000,maxStateBytes:65536,maxOutputBytes:100000,leaseTtlMs:30000,pollMs:1000}};
 return {runtime:()=>createAgentRuntime(options),get checkpoint(){return checkpoint;},get providerTurn(){return turn;},get executions(){return executions;},get messages(){return messages;},get outputs(){return outputs;},
 set denied(v){denied=v;},set approved(v){approved=v;},set outputFailure(v){outputFailure=v;},set toolResultFailure(v){toolResultFailure=v;}};
}
test('hosted harness completes native effect through admitted runtime',async()=>{
 const f=fixture(),r=f.runtime();assert.deepEqual(await r.wake(identity),success('succeeded'));assert.equal(f.executions,1);assert.equal(f.messages,1);
 assert.equal(f.checkpoint.hosted.session.sessionId,'remote-session');assert.equal(f.checkpoint.hosted.turn.turnId,'provider-turn');await r.stop();
});
test('host approval preserves pending provider call and original job across runtime reconstruction',async()=>{
 const f=fixture();f.approved=false;let r=f.runtime();assert.deepEqual(await r.wake(identity),success('waiting'));assert.equal(f.executions,0);await r.stop();
 f.approved=true;r=f.runtime();assert.deepEqual(await r.resume(identity),success());assert.deepEqual(await r.wake(identity),success('succeeded'));
 assert.equal(f.executions,1);assert.equal(f.messages,1);await r.stop();
});
test('lost function result delivery retries saved result without repeating its native effect',async()=>{
 const f=fixture();f.toolResultFailure=true;let r=f.runtime();assert.deepEqual(await r.wake(identity),success('retryable'));assert.equal(f.executions,1);await r.stop();
 f.toolResultFailure=false;r=f.runtime();assert.deepEqual(await r.wake(identity),success('succeeded'));assert.equal(f.executions,1);assert.equal(f.messages,1);await r.stop();
});
test('lost host output commit reuses saved final answer without calling provider or tool again',async()=>{
 const f=fixture();f.outputFailure=true;let r=f.runtime();assert.deepEqual(await r.wake(identity),success('retryable'));await r.stop();
 f.outputFailure=false;r=f.runtime();assert.deepEqual(await r.wake(identity),success('succeeded'));assert.equal(f.executions,1);assert.equal(f.messages,1);assert.equal(f.outputs,2);await r.stop();
});
test('revoked scope prevents provider creation and all tool work',async()=>{
 const f=fixture();f.denied=true;const r=f.runtime();assert.equal((await r.wake(identity)).ok,false);assert.equal(f.messages,0);assert.equal(f.executions,0);await r.stop();
});

test('native Stop waits for the original hosted turn to settle before native cancellation',async()=>{
 const f=fixture();f.approved=false;const r=f.runtime();assert.deepEqual(await r.wake(identity),success('waiting'));
 await r.cancelProvider(identity,new AbortController().signal);assert.equal(f.providerTurn.status,'cancelled');assert.equal(f.executions,0);await r.stop();
});
