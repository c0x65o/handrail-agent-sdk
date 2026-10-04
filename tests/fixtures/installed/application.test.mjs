import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { createAgentConversationTransport } from 'handrail-agent-sdk/server/application';
import { createPostgresHarness } from './database.mjs';
import { migrations } from './database.mjs';
import { services, identity } from './host.mjs';
import './catalog.test.mjs';

const empty={lastAppliedCursor:null,lastAppliedEventId:null,lastAppliedRevision:null};
async function setup(t,options={}) {
  const harness=await createPostgresHarness();let s;const closers=[];
  t.after(async()=>{for(const close of closers)await close();await s?.close();await harness.cleanup();});
  const db=await harness.client();await migrations(t,harness,db);
  await db.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY,receipt text NOT NULL,attempts integer NOT NULL DEFAULT 1)`);
  s=await services(harness.schema,randomBytes(32).toString('hex'),options);
  const binding={identity,turnId:'turn-one',mutationId:'mutation-one'};
  const authorize=()=>{if(s.state.denied)throw Error('denied');};
  const host={
    async admit(input){
      authorize(); assert.equal(input.conversationId,'conversation-one');
      const result=await s.admission.admit({namespaceRef:'fixture',grantRevision:1,
        operation:{operationRef:'agent-task',inputRefs:{inputRef:input.request.inputRef}},
        event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}});
      if(!result.ok)throw Error(result.code);return binding;
    },
    async lookup(input){authorize();assert.equal(input.conversationId,'conversation-one');assert.equal(input.turnId,binding.turnId);return binding;},
    async read(_binding,after){
      const result=await s.runtime.inspect(identity);assert.equal(result.ok,true);
      const {snapshot,checkpoint}=result.value;
      const cursor={lastAppliedCursor:String(snapshot.revision),lastAppliedRevision:snapshot.revision,lastAppliedEventId:`job:${snapshot.revision}`};
      const events=checkpoint?.output && after.lastAppliedRevision!==snapshot.revision?[{text:checkpoint.output}]:[];
      return {events,checkpoint:cursor,
        ...snapshot.state==='succeeded'?{result:{status:'completed',checkpoint:cursor}}:{} ,
        ...snapshot.state==='cancelled'?{result:{status:'cancelled',checkpoint:cursor}}:{},
        ...snapshot.state==='waiting'?{result:{status:'waiting_for_approval',checkpoint:cursor,pendingToolCallIds:['call-1']}}:{}};
    },
    async cancel(){
      authorize();const snap=(await s.journal.load(identity)).value;
      if(['cancelled','succeeded','failed'].includes(snap.state))return 'already_terminal';
      const r=await s.cancel.stop({command:'cancel',identity,expectedRevision:snap.revision,reason:'explicit_stop'},'actor');
      if(!r.ok)throw Error(r.code);return 'cancellation_requested';
    },
  };
  const capabilities={attachmentUpload:{supported:false},documentInput:{supported:false},presence:{supported:false},synchronization:{supported:false}};
  return {...s,host,closers,transport:createAgentConversationTransport({runtime:s.runtime,host,capabilities,pollMs:5}),capabilities};
}
const start={conversationId:'conversation-one',conversationTurnId:'turn-one',mutationId:'mutation-one',idempotencyKey:'request-one',request:{inputRef:'input-one'}};
test('gateway transport uses actual Runner, durable output and reconnect cursor; disconnect does not Stop',async t=>{
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const s=await setup(t,{read:async()=>{entered();await hold;return 'fixture fact';}});
  const opened=await s.transport.startTurn(start);assert.equal(opened.ok,true);
  await started;opened.value.observation.disconnect();assert.equal((await opened.value.observation.result).status,'disconnected');
  release();
  const resumed=await s.transport.resumeTurn({conversationId:'conversation-one',turnId:'turn-one',resumeFrom:empty});
  assert.equal(resumed.ok,true);const events=[];for await(const event of resumed.value.events)events.push(event);
  let result=await resumed.value.result;
  if(result.status==='disconnected') {
    // The duplicate dispatch was busy. Its observation ends; the original
    // executor still owns progress. Reconnect with the retained cursor.
    const deadline=Date.now()+5000;
    while((await s.journal.load(identity)).value.state!=='succeeded') {
      assert.ok(Date.now()<deadline,'original execution did not finish');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    const recovered=await s.transport.resumeTurn({conversationId:'conversation-one',turnId:'turn-one',resumeFrom:result.checkpoint});
    assert.equal(recovered.ok,true);
    for await(const event of recovered.value.events)events.push(event);
    result=await recovered.value.result;
  }
  assert.equal(result.status,'completed');assert.equal(events[0].text,'Reserved synthetic item.');
  const duplicate=await s.transport.startTurn(start);assert.equal(duplicate.ok,true);duplicate.value.observation.disconnect();
  const replay=await s.transport.resumeTurn({conversationId:'conversation-one',turnId:'turn-one',resumeFrom:result.checkpoint});
  const replayed=[];for await(const event of replay.value.events)replayed.push(event);assert.deepEqual(replayed,[]);
  assert.equal(s.calls.filter(c=>c.input.topic==='inventory').length,1);
});
test('transport explicit Stop is durable; changed identity cannot reconnect or cancel',async t=>{
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const s=await setup(t,{read:async()=>{entered();await hold;return 'late';}});
  const opened=await s.transport.startTurn(start);await started;
  const cancelled=await s.transport.capabilities.authoritativeCancellation.capability.cancelTurn({conversationId:'conversation-one',turnId:'turn-one',mutationId:'stop',idempotencyKey:'stop',reason:'user'});
  assert.equal(cancelled.ok,true);release();opened.value.observation.disconnect();
  assert.equal((await s.runtime.wake(identity)).value,'cancelled');
  const stopped=await s.runtime.inspect(identity);assert.equal(stopped.ok,true);assert.equal(stopped.value.checkpoint,null);assert.equal(stopped.value.snapshot.state,'cancelled');
  s.state.denied=true;const reconnect=await s.transport.resumeTurn({conversationId:'conversation-one',turnId:'turn-one',resumeFrom:empty});assert.equal(reconnect.ok,false);
  assert.ok(!JSON.stringify(reconnect).includes('denied'));
});
test('approval wait remains durable on reconnect; only verified answer can resume execution',async t=>{
  const s=await setup(t,{wait:true});const opened=await s.transport.startTurn(start);
  for await(const _ of opened.value.observation.events){}
  assert.equal((await opened.value.observation.result).status,'waiting_for_approval');
  const resumed=await s.transport.resumeTurn({conversationId:'conversation-one',turnId:'turn-one',resumeFrom:empty});
  for await(const _ of resumed.value.events){}
  assert.equal((await resumed.value.result).status,'waiting_for_approval');
  assert.equal((await s.journal.load(identity)).value.state,'waiting');
});

test('standard reader emits validated native protocol frames and stable replay identities',async t=>{
  const {createAgentCheckpointReader}=await import('handrail-agent-sdk/server/application');
  const {parseStreamEvent}=await import('@handrail/ai-assistant');
  const s=await setup(t);
  const member={id:'fixture',source:'server_derived',trust:'authoritative'};
  const reader=createAgentCheckpointReader({runtime:s.runtime,attribution:async()=>({organization:member,project:member,service_environment:member,known_user:member,session:member,automation:{...member,id:null}}),pendingToolCallIds:async()=>[]});
  const binding=await s.host.admit(start);await s.runtime.wake(identity);
  const first=await reader(binding,empty);assert.equal(first.result.status,'completed');
  assert.deepEqual(first.events.map(e=>parseStreamEvent(e).type),['response.started','response.text.delta','response.usage','response.completed']);
  assert.equal((await reader(binding,first.checkpoint)).events.length,0);
  await assert.rejects(reader(binding,{...empty,lastAppliedCursor:'other-job:1'}),/invalid_agent_cursor/);
});

test('application catalog adapter preserves validation, read/mutation classification and stable native tool identity',async()=>{
  const {createApplicationAgentTools,observeApplicationAgentTool}=await import('handrail-agent-sdk/server/application-tools');
  const definitions=['lookup','reserve'].map(name=>({name,description:'Fixture',input_schema:{type:'object',properties:{item:{type:'string'}},required:['item'],additionalProperties:false}}));
  const tools=createApplicationAgentTools({definitions,isReadOnly:name=>name==='lookup',read:async()=> 'read',bind:async()=>{throw Error('not called');},result:async()=> 'receipt'});
  assert.deepEqual(tools.map(t=>t.kind),['read','effect']);assert.throws(()=>tools[0].parameters.parse({item:42}));
  let observed;
  const value=await observeApplicationAgentTool({observe:async(input,run)=>{observed=input;return (await run(()=>{})).value;}},
    {conversationId:'conversation-one',turnId:'turn-one'},{identity,toolName:'lookup',callId:'model-call',effectRef:'stable-effect',input:{item:'one'}},new AbortController().signal,async()=> 'presented');
  assert.equal(value,'presented');assert.equal(observed.call.tool_call_id,'stable-effect');
});

test('existing assistant durable wrapper consumes the Agent transport with native protocol checkpoints',async t=>{
  const {createAgentCheckpointReader}=await import('handrail-agent-sdk/server/application');
  const {createDurableApplicationTransport,InMemoryDurableApplicationTurnStore}=await import('@handrail/ai-assistant/server/application');
  const s=await setup(t);
  const member={id:'fixture',source:'server_derived',trust:'authoritative'};
  const read=createAgentCheckpointReader({runtime:s.runtime,attribution:async()=>({organization:member,project:member,service_environment:member,known_user:member,session:member,automation:{...member,id:null}}),pendingToolCallIds:async()=>[]});
  const delegate=createAgentConversationTransport({runtime:s.runtime,host:{...s.host,read},capabilities:s.capabilities,pollMs:5});
  // Only the pre-existing outer transport's store is simulated in this contract
  // test. Agent execution, effects, encrypted state and journal use PostgreSQL.
  const store=new InMemoryDurableApplicationTurnStore();
  const transport=createDurableApplicationTransport({delegate,store,workerId:'wrapper-fixture',pollMilliseconds:25,leaseMilliseconds:1000,
    requestCodec:{encode:r=>r,decode:r=>r,fingerprint:r=>createHash('sha256').update(JSON.stringify(r)).digest('hex')},
    checkpointForEvent:e=>({lastAppliedCursor:`${e.request_id}:${e.sequence}`,lastAppliedEventId:`${e.request_id}:${e.sequence}`,lastAppliedRevision:e.sequence})});
  s.closers.push(()=>transport.stopWorkers());
  const opened=await transport.startTurn(start);assert.equal(opened.ok,true,JSON.stringify(opened));const events=[];
  for await(const event of opened.value.observation.events)events.push(event);
  const completed=await opened.value.observation.result;assert.equal(completed.status,'completed');
  assert.deepEqual(events.map(e=>e.sequence),[0,1,2,3]);
  const replay=await transport.resumeTurn({conversationId:'conversation-one',turnId:opened.value.turnId,resumeFrom:completed.checkpoint});
  assert.equal(replay.ok,true);const repeated=[];for await(const event of replay.value.events)repeated.push(event);assert.equal(repeated.length,0);
  assert.equal((await store.load('conversation-one',opened.value.turnId)).record.status,'completed');
});

test('application JSON-schema catalog executes read/effect/read through Runner and checkpoint reader',async t=>{
  const {z}=await import('zod');
  const {createApplicationAgentTools}=await import('handrail-agent-sdk/server/application-tools');
  const {createAgentCheckpointReader}=await import('handrail-agent-sdk/server/application');
  const s=await setup(t,{transformTools:tools=>createApplicationAgentTools({
    definitions:tools.map(tool=>({name:tool.name,description:tool.description,input_schema:z.toJSONSchema(tool.parameters)})),
    isReadOnly:name=>name!=='reserve',
    read:(call,signal)=>tools.find(t=>t.name===call.toolName).execute(call,signal),
    bind:call=>tools.find(t=>t.name===call.toolName).bind(call),
    result:async()=>JSON.stringify({recordRef:'host-domain-record'}),
  })});
  const member={id:'fixture',source:'server_derived',trust:'authoritative'};
  const read=createAgentCheckpointReader({runtime:s.runtime,attribution:async()=>({organization:member,project:member,service_environment:member,known_user:member,session:member,automation:{...member,id:null}}),pendingToolCallIds:async()=>[]});
  const transport=createAgentConversationTransport({runtime:s.runtime,host:{...s.host,read},capabilities:s.capabilities,pollMs:5});
  const opened=await transport.startTurn(start);assert.equal(opened.ok,true);
  const events=[];for await(const event of opened.value.observation.events)events.push(event);
  assert.equal((await opened.value.observation.result).status,'completed');
  assert.deepEqual(events.map(e=>e.type),['response.started','response.text.delta','response.usage','response.completed']);
  const inspected=await s.runtime.inspect(identity);
  assert.ok(Object.values(inspected.value.checkpoint.results).some(r=>r.output.includes('host-domain-record')));
  assert.equal(events.find(e=>e.type==='response.usage').usage.total_tokens,60);
});

test('installed assistance and notification delivery share public durable effects with no duplicate send',async t=>{
  const {createAssistance}=await import('handrail-agent-sdk/server/assistance');
  const {createPostgresAssistanceStore,assistancePostgresSchema}=await import('handrail-agent-sdk/server/assistance/postgres');
  const {createNotificationDelivery}=await import('handrail-agent-sdk/server/assistance/notifications');
  const harness=await createPostgresHarness();t.after(()=>harness.cleanup());
  const db=await harness.client();await migrations(t,harness,db);
  await db.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY,receipt text NOT NULL,attempts integer NOT NULL DEFAULT 1)`);
  await db.query(assistancePostgresSchema(harness.schema));
  const now=Date.parse('2027-01-01T00:00Z');
  let revoked=false;
  const {createPostgresAssistanceDatabase}=await import('handrail-agent-sdk/server/postgres');
  const options={store:createPostgresAssistanceStore(createPostgresAssistanceDatabase(harness.pool),harness.schema),host:{now:()=>now,withAuthority:async(_key,_op,run)=>{if(revoked)throw Error('denied');return run();}},batchSize:10,readTimeoutMs:1000,adapters:{sensor:{read:async(_key,spec)=>({subjectRef:spec.subjectRef,status:'matched',observedAt:now,evidenceRef:'observed'})}}};
  const assistance=createAssistance(options),key={scope:identity.host,id:'fixture-observation'};
  await assistance.create(key,'create',{kind:'watch',adapterRef:'sensor',subjectRef:'fixture-sensor',contentRef:'host-content',pollMs:1000,maxAgeMs:5000,expiresAt:now+60000});
  await Promise.all([assistance.tick(),createAssistance(options).tick()]);
  const facts=await assistance.facts(identity.host);assert.equal(facts.length,1);
  const deliveryId={...identity,jobId:'notification-job',requestKey:'notification-request'};
  const s=await services(harness.schema,randomBytes(32).toString('hex'),{identity:deliveryId,state:{uncertain:true}});t.after(()=>s.close());
  const delivery=createNotificationDelivery({effects:s.effects,lease:s.lease,journal:s.journal,leaseTtlMs:1200,
    admit:async(fact,channel,effectRef)=>{
      if(revoked)throw Error('denied');assert.deepEqual(fact.scope,identity.host);
      const result=await s.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'notify',inputRefs:{effectRef}},event:{kind:'submitted',previousRevision:0,snapshot:{identity:deliveryId,revision:1,state:'queued',effects:[]}}});
      assert.equal(result.ok,true,result.code);return {identity:deliveryId,providerRef:'fixture-push',actionRef:channel};
    }});
  assert.equal((await delivery.deliver(facts[0],'push')).value.outcome,'unknown');
  assert.equal((await db.query(`SELECT * FROM ${harness.table('synthetic_provider')}`)).rowCount,0);
  s.state.uncertain=false;
  assert.equal((await delivery.deliver(facts[0],'push')).value.outcome,'verified');
  assert.equal((await delivery.deliver(facts[0],'push')).value.outcome,'verified');
  assert.equal((await db.query(`SELECT sum(attempts)::int AS n FROM ${harness.table('synthetic_provider')}`)).rows[0].n,1);
  revoked=true;await assert.rejects(delivery.deliver(facts[0],'push'),/denied/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${harness.table('assistance_facts')}`)).rows[0].n,1);
});

// Real Agent admission, Runner, cancellation and journal; only provider/read
// boundaries are controlled. Validate the public wire decoder and replay cursor.
for (const waiting of [false, true]) test(`explicit Stop projects its durable reason (approval wait=${waiting})`, async t => {
  const { createAgentCheckpointReader } = await import('handrail-agent-sdk/server/application');
  const { parseStreamEvent } = await import('@handrail/ai-assistant');
  let entered, release;
  const started = new Promise(r => entered = r), held = new Promise(r => release = r);
  t.after(() => release());
  const s = await setup(t, waiting ? { wait: true } : { read: async () => { entered(); await held; return 'late result'; } });
  const binding = await s.host.admit(start);
  const running = s.runtime.wake(identity);
  if (waiting) await running; else await started;
  assert.equal((await s.runtime.inspect(identity)).value.snapshot.state, waiting ? 'waiting' : 'running');
  await s.host.cancel();
  release(); await running;
  const member = { id: 'fixture', source: 'server_derived', trust: 'authoritative' };
  const read = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => ({
    organization: member, project: member, service_environment: member, known_user: member, session: member, automation: { ...member, id: null },
  }), pendingToolCallIds: async () => [] });
  const page = await read(binding, empty);
  assert.equal(page.events.at(-1).reason, 'explicit_stop');
  assert.equal(parseStreamEvent(page.events.at(-1)).reason, 'explicit_stop');
  assert.equal(page.result.status, 'cancelled');
  assert.deepEqual((await read(binding, page.checkpoint)).events, []);
  assert.deepEqual((await read(binding, empty)).events, page.events);
  const stopped = (await s.runtime.inspect(identity)).value;
  assert.equal(stopped.snapshot.cancellation.reason, 'explicit_stop');
  assert.equal(stopped.checkpoint, null);
  assert.equal(await s.host.cancel(), 'already_terminal');
  assert.equal((await s.runtime.wake(identity)).value, 'cancelled');
  s.state.denied = true;
  assert.equal((await s.transport.capabilities.authoritativeCancellation.capability.cancelTurn({
    conversationId: 'conversation-one', turnId: 'turn-one', mutationId: 'denied', idempotencyKey: 'denied', reason: 'user',
  })).ok, false);
});
