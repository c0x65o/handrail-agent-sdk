import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostedSessionClient } from '../dist/server/hosted-session.js';

function fixture({ browser, failCreation = false } = {}) {
  let savedSession, created, current, turns = [], messages = 0, streamClosed = 0;
  const submissions = [];
  const page = data => Object.assign(Promise.resolve({ data }), { async *[Symbol.asyncIterator]() { yield* data; } });
  const sessions = {
    async create(body) { created = body; if (failCreation) throw Error('connection_lost'); return savedSession = {
      id:'session_1', metadata:body.metadata, status:'idle',required_actions:[] }; },
    async retrieve() { return savedSession; },
    list() { return page(savedSession ? [savedSession] : []); },
    turns: { list() { return page(turns); }, async retrieve(id) { return turns.find(t=>t.id===id); } },
    items: { list() { return page([{id:'answer',type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]); } },
    events: {
      async stream() { return {controller:{abort(){streamClosed++;}},async *[Symbol.asyncIterator](){
        if (current) yield {type:'agent.session.turn.completed',turn:current};
      }}; },
      async create(_id,body) {
        submissions.push(body);
        if(body.events[0].type==='agent.session.input.message'){
          messages++;
          current={id:'turn_1',status:'completed',subagent_id:null}; turns=[current];
        }
      },
    },
    async delete(){ savedSession=undefined; },
  };
  sessions.turns.items=sessions.items;
  const adapter=createHostedSessionClient({client:{beta:{agents:{sessions}}},model:'test',instructions:'test',...(browser===undefined?{}:{browser})});
  let binding=adapter.binding({project:'one',conversation:'original'},'creation_1');
  const signal=new AbortController().signal;
  const authorize=async()=>{};
  const connect=()=>adapter.connect({binding,signal,authorize,save:async b=>{binding=structuredClone(b);}});
  let turn={submissionKey:'input_1'};
  const run=()=>adapter.run({session:binding,turn,input:[{role:'user',content:[{type:'input_text',text:'hi'}]}],signal,authorize,
    save:async b=>{turn=structuredClone(b);},action:async()=>null});
  return {adapter,sessions,connect,run,signal,authorize,get binding(){return binding;},get turn(){return turn;},
    get created(){return created;},get messages(){return messages;},get closed(){return streamClosed;},
    set turns(value){turns=value;},set turn(value){turn=value;},get savedSession(){return savedSession;}};
}

test('browser is hosted and enabled by default; explicit disable removes computer tool',async()=>{
  for(const browser of [undefined,false]){
    const f=fixture({browser}); await f.connect();
    assert.equal(f.created.environment.type,'openai_hosted');
    assert.equal(f.created.environment.desktop.enabled,browser!==false);
    assert.equal(f.created.agent.tools.some(t=>t.type==='computer_use'),browser!==false);
    assert.equal(f.binding.sessionId,'session_1');
  }
});
test('creation intent survives uncertain response; no replacement session is created',async()=>{
  const f=fixture({failCreation:true}); await assert.rejects(f.connect(),/connection_lost/);
  assert.equal(f.binding.creationAttempted,true);
  await assert.rejects(f.connect(),{code:'creation_uncertain'});
});
test('lost local creation receipt recovers exact original provider session',async()=>{
  const f=fixture();await f.connect(); const b={...f.binding};delete b.sessionId;
  let saved;
  assert.equal(await f.adapter.connect({binding:b,signal:f.signal,authorize:f.authorize,save:async b=>{saved=b;}}),'session_1');
  assert.equal(saved.sessionId,'session_1');
});
test('provider metadata cannot bind a session to another conversation',async()=>{
  const f=fixture(); await f.connect();f.savedSession.metadata.handrail_scope='wrong';
  await assert.rejects(f.connect(),{code:'binding_conflict'});
});
test('completed remote turn is recovered without submitting work again',async()=>{
  const f=fixture();await f.connect();let result=await f.run();
  assert.equal(result.status,'terminal');assert.equal(result.turn.id,'turn_1');assert.equal(f.messages,1);
  result=await f.run();assert.equal(result.turn.id,'turn_1');assert.equal(f.messages,1);assert.equal(f.closed,2);
});
test('observer EOF is not reported as success and does not cancel remote work',async()=>{
  const f=fixture();await f.connect();f.turn={submissionKey:'input_1',baseline:null,submissionAttempted:true,turnId:'turn_1'};
  f.turns=[{id:'turn_1',status:'in_progress',subagent_id:null}];
  await assert.rejects(f.run(),{code:'stream_disconnected'});assert.equal(f.messages,0);assert.equal(f.closed,1);
});
test('a second conversation writer cannot steer unrelated running work',async()=>{
  const f=fixture();await f.connect();f.savedSession.status='in_progress';
  await assert.rejects(f.run(),{code:'concurrent_turn'});assert.equal(f.messages,0);
});
test('pending function action stays pending when host needs owner input',async()=>{
  const f=fixture();await f.connect();f.turn={submissionKey:'input_1',baseline:null,submissionAttempted:true,turnId:'turn_1'};
  f.turns=[{id:'turn_1',status:'waiting',subagent_id:null}];
  f.savedSession.required_actions=[{type:'function_call',turn_id:'turn_1',call_id:'call_1',name:'native',arguments:{}}];
  assert.deepEqual(await f.run(),{status:'waiting'});assert.equal(f.messages,0);
});
test('Stop for a completed original turn cannot cancel later work',async()=>{
 const f=fixture();await f.connect();
 f.turns=[{id:'turn_2',status:'in_progress',subagent_id:null},{id:'turn_1',status:'completed',subagent_id:null}];
 let cancelled=0;f.sessions.events.create=async()=>{cancelled++;};
 await f.adapter.cancel(f.binding,{submissionKey:'input_1',turnId:'turn_1'},f.authorize,f.signal);
 assert.equal(cancelled,0);
});
test('cleanup refuses a still-open provider turn, including idle public sessions',async()=>{
 const f=fixture();await f.connect();f.turns=[{id:'turn_1',status:'in_progress',subagent_id:null}];
 await assert.rejects(f.adapter.remove(f.binding,f.authorize,f.signal),{code:'concurrent_turn'});
 assert.ok(f.savedSession);
});
test('failed session can be cleaned up after backend turn settles',async()=>{
 const f=fixture();await f.connect();f.savedSession.status='failed';f.turns=[{id:'turn_1',status:'failed',subagent_id:null}];
 await f.adapter.remove(f.binding,f.authorize,f.signal);assert.equal(f.savedSession,undefined);
});

test('Stop does not claim success when the original input acceptance is still uncertain',async()=>{
 const f=fixture();await f.connect();
 await assert.rejects(f.adapter.cancel(f.binding,{submissionKey:'uncertain',baseline:null,submissionAttempted:true},f.authorize,f.signal),{code:'submission_uncertain'});
});

test('model selection updates idle original session; browser policy cannot silently change its environment',async()=>{
 const f=fixture();await f.connect();f.savedSession.agent={model:'test'};let updates=0;
 f.sessions.update=async(id,body)=>{assert.equal(id,f.binding.sessionId);assert.equal(body.agent.model,'updated-model');updates++;f.savedSession.agent.model=body.agent.model;};
 const next=createHostedSessionClient({client:{beta:{agents:{sessions:f.sessions}}},model:'updated-model',instructions:'test'});
 assert.equal(next.binding({project:'one',conversation:'original'},'creation_1').configurationDigest,f.binding.configurationDigest);
 await next.connect({binding:f.binding,signal:f.signal,authorize:f.authorize,save:async()=>{throw Error('identity must not change');}});
 assert.equal(updates,1);
 const disabled=createHostedSessionClient({client:{beta:{agents:{sessions:f.sessions}}},model:'updated-model',instructions:'test',browser:false});
 await assert.rejects(disabled.connect({binding:f.binding,signal:f.signal,authorize:f.authorize,save:async()=>{}}),{code:'binding_conflict'});
});

test('fast terminal polling cannot discard a queued live screenshot',async()=>{
 const f=fixture();await f.connect();const retained=[];
 f.sessions.events.stream=async()=>({controller:{abort(){}},async *[Symbol.asyncIterator](){
   yield {type:'agent.session.requires_action',session:f.savedSession};
   yield {type:'agent.session.turn.item.done',item:{id:'screen',type:'computer_use_call',turn_id:'turn_1',status:'completed',output:{image_url:'data:image/png;base64,c2NyZWVu'}}};
   yield {type:'agent.session.turn.completed',turn:{id:'turn_1',subagent_id:null,status:'completed'}};
 }});
 const result=await f.adapter.run({session:f.binding,turn:{submissionKey:'fast'},input:[],signal:f.signal,authorize:f.authorize,
   save:async()=>{},action:async()=>null,item:async item=>retained.push(item.id)});
 assert.equal(result.status,'terminal');assert.deepEqual(retained,['screen','answer']);assert.equal(f.messages,1);
});
