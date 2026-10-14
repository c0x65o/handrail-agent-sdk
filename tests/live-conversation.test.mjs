import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresLiveConversationQueue} from '../dist/server/live-conversation.js';
import {PostgresAiPersistence,PostgresConversationEventStore} from '../dist/assistant/postgres/index.js';
import {prepareApplicationConversationSubmission} from '../dist/assistant/client/session-submission.js';
import {parseConversationEvent} from '../dist/assistant/conversation/events.js';

async function fixture(t) {
 if(process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE!=='1')throw Error('DISPOSABLE_REQUIRED');
 const schema=`live_${randomUUID().replaceAll('-','')}`;
 const pool=new pg.Pool({connectionString:process.env.HANDRAIL_TEST_POSTGRES_URL,max:4,options:`-c search_path=${schema},public`});
 await pool.query(`CREATE SCHEMA "${schema}"`);
 t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();});
 const wrap=c=>({query:(sql,values)=>c.query(sql,values),transaction:async fn=>fn(wrap(c))});
 const client={query:(sql,values)=>pool.query(sql,values),transaction:async fn=>{
  const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(wrap(c));await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }};
 const persistence=new PostgresAiPersistence(client);await persistence.migrate();
 const tenantId=randomUUID(),conversationId=randomUUID(),principalId=randomUUID();
 let generation='0',allowed=true,failStart=false;const starts=[];
 const options={persistence,tenantId,conversationId,principalId,authorize:async()=>{if(!allowed)throw Error('denied');return generation;},
  start:async submission=>{starts.push(submission);if(failStart)throw Error('uncertain start');}};
 const queue=()=>new PostgresLiveConversationQueue(options);
 const events=new PostgresConversationEventStore(persistence,tenantId);
 const input=(key,content=key)=>({key,content,request:{content},origin:{channel:'voice',callId:'original',speakerContext:'shared_or_uncertain'},validateCurrent(){}});
 const complete=async submission=>{
  const revision=(await events.getLatestRevision(conversationId)??0)+1;
  await events.append({conversationId,expectedRevision:revision===1?null:revision-1,events:[parseConversationEvent({
   version:1,event_id:randomUUID(),conversation_id:conversationId,revision,occurred_at:new Date().toISOString(),actor:{type:'assistant'},source:{type:'runtime'},
   payload:{type:'turn.completed',turn_id:submission.start.conversationTurnId,outcome:'stop',output_message_ids:[]}})]});
 };
 return {queue,events,starts,input,complete,conversationId,options,deny:()=>{allowed=false;},clear:()=>{generation='1';},failStart:value=>{failStart=value;}};
}

test('durable voice queue preserves original identity through uncertain admission/start and process recovery',async t=>{
 const f=await fixture(t),a=f.queue();const id=await a.enqueue(f.input('first'));
 assert.equal(await f.queue().enqueue(f.input('first')),id);
 await assert.rejects(a.enqueue(f.input('first','changed')),/identity changed/);
 f.failStart(true);await assert.rejects(a.drain(),/uncertain start/);
 const original=f.starts[0];f.failStart(false);await f.queue().drain();
 assert.deepEqual(f.starts[1],original);
 await a.drain();assert.equal(f.starts.length,2,'acknowledged start is not repeated while work runs');
 assert.equal((await f.events.read({conversationId:f.conversationId,limit:20})).entries.length,2);
 assert.deepEqual((await a.turnOrigin(original.start.conversationTurnId)).origin,f.input('first').origin);
 await f.complete(original);assert.equal((await a.read(id)).status,'succeeded');
 assert.deepEqual(await a.drain(),{pending:false});
});

test('voice waits for active text work and serializes concurrent spoken corrections',async t=>{
 const f=await fixture(t),q=f.queue();
 const text=prepareApplicationConversationSubmission({conversationId:f.conversationId,clientId:'text',revision:0,operationId:'text',now:new Date().toISOString(),input:{content:'Text work',request:{content:'Text work'}}});
 await f.events.append({conversationId:f.conversationId,expectedRevision:null,events:text.admission.mutations.flatMap(m=>m.events)});
 const first=await q.enqueue(f.input('first'));const second=await q.enqueue(f.input('correction'));
 await Promise.all([q.drain(),f.queue().drain()]);assert.equal(f.starts.length,0);
 assert.equal((await q.read(first)).status,'queued');
 await f.complete(text);await q.drain();const spoken=f.starts.at(-1);
 assert.equal(spoken.start.request.content,'first');assert.equal((await q.read(second)).status,'queued');
 await f.complete(spoken);await q.drain();await q.drain();
 assert.equal(f.starts.at(-1).start.request.content,'correction');
 assert.notEqual(spoken.start.conversationTurnId,f.starts.at(-1).start.conversationTurnId);
});

test('native revocation, precommit correction and clear generation fence saved speech',async t=>{
 const f=await fixture(t),q=f.queue();
 await assert.rejects(q.enqueue({...f.input('stale'),validateCurrent(){throw Error('corrected');}}),/corrected/);
 const id=await q.enqueue(f.input('valid'));f.clear();await q.drain();
 assert.equal((await q.read(id)).status,'cancelled');assert.equal(f.starts.length,0);
 f.deny();await assert.rejects(q.read(id),/denied/);await assert.rejects(q.enqueue(f.input('denied')),/denied/);
});

test('queue recovery discovery is scoped to the retained tenant and principal',async t=>{
 const f=await fixture(t),q=f.queue();await q.enqueue(f.input('retained'));
 assert.deepEqual(await PostgresLiveConversationQueue.pendingConversations(f.options.persistence,f.options.tenantId,f.options.principalId),[f.conversationId]);
 assert.deepEqual(await PostgresLiveConversationQueue.pendingConversations(f.options.persistence,f.options.tenantId,randomUUID()),[]);
 assert.deepEqual(await PostgresLiveConversationQueue.pendingConversations(f.options.persistence,randomUUID(),f.options.principalId),[]);
});


test('approval releases voice ingress without settling the original request',async t=>{
 const f=await fixture(t),q=f.queue();const first=await q.enqueue(f.input('needs approval'));
 await q.drain();const original=f.starts[0];
 const revision=(await f.events.getLatestRevision(f.conversationId))+1;
 await f.events.append({conversationId:f.conversationId,expectedRevision:revision-1,events:[parseConversationEvent({
  version:1,event_id:randomUUID(),conversation_id:f.conversationId,revision,occurred_at:new Date().toISOString(),
  actor:{type:'assistant'},source:{type:'runtime'},payload:{type:'turn.status_changed',turn_id:original.start.conversationTurnId,status:'waiting_for_approval'}})]});
 const next=await q.enqueue(f.input('followup'));
 await q.drain();await q.drain();
 assert.equal(f.starts.length,2);
 assert.equal(f.starts[1].start.request.content,'followup');
 assert.equal((await q.read(first)).status,'waiting_for_approval');
 assert.equal((await q.read(next)).status,'queued');
 assert.deepEqual((await q.turnOrigin(original.start.conversationTurnId)).submission,original);
});

test('active speech attaches once to the original canonical work and survives worker reconstruction',async t=>{
 const f=await fixture(t),q=f.queue();await q.enqueue(f.input('original'));await q.drain();
 const original=f.starts[0],turnId=original.start.conversationTurnId;
 const id=await q.enqueue({...f.input('correction'),origin:{channel:'voice',callId:'second',speakerContext:'authenticated_user'}});
 const active=q.activeInputs(turnId,'native-job',origin=>origin.speakerContext==='authenticated_user');
 const pending=await active.next();assert.equal(pending.key,id);assert.equal(pending.messages[0].content[0].text,'correction');
 assert.deepEqual(await f.queue().activeInputs(turnId,'native-job',()=>true).next(),pending);
 await q.drain();assert.equal(f.starts.length,1,'active input must not start a second canonical worker');
 const receipt={turnId:'provider-turn',messageId:'provider-message'};
 await active.received(id,receipt);await active.received(id,receipt);
 assert.equal(await active.next(),null);
 const messages=(await f.events.read({conversationId:f.conversationId,limit:100})).entries
  .filter(row=>row.event.payload.type==='message.created');
 assert.equal(messages.length,2);assert.equal(messages[1].event.payload.content[0].text,'correction');
 assert.deepEqual((await q.inputOrigins(turnId)).map(origin=>origin.callId).sort(),['original','second']);
 await assert.rejects(active.received(id,{...receipt,messageId:'wrong'}),/receipt changed/);
 await f.complete(original);await q.drain();await q.drain();
 assert.equal((await q.read(id)).status,'succeeded');assert.equal(f.starts.length,1);
 assert.deepEqual(await q.drain(),{pending:false});
});

test('deferring active input keeps a single ordinary queued message and never reclaims for that job',async t=>{
 const f=await fixture(t),q=f.queue();await q.enqueue(f.input('original'));await q.drain();const original=f.starts[0];
 const id=await q.enqueue(f.input('late'));
 const active=q.activeInputs(original.start.conversationTurnId,'native-job',()=>true);
 await active.next();await active.defer(id);await active.defer(id);assert.equal(await active.next(),null);
 await f.complete(original);await q.drain();await q.drain();
 assert.equal(f.starts.length,2);assert.equal(f.starts[1].start.request.content,'late');
 const messages=(await f.events.read({conversationId:f.conversationId,limit:100})).entries.filter(row=>row.event.payload.type==='message.created');
 assert.equal(messages.length,2);
});

test('active input respects native privacy selection, revocation and clear generation',async t=>{
 const f=await fixture(t),q=f.queue();await q.enqueue(f.input('original'));await q.drain();const turnId=f.starts[0].start.conversationTurnId;
 const id=await q.enqueue(f.input('shared-room'));
 assert.equal(await q.activeInputs(turnId,'native-job',origin=>origin.speakerContext==='authenticated_user').next(),null);
 const active=q.activeInputs(turnId,'native-job',()=>true);await active.next();f.clear();
 await assert.rejects(active.received(id,{turnId:'provider',messageId:'message'}),/no longer current/);
 f.deny();await assert.rejects(active.next(),/denied/);
});

test('Stop settles an unsent claimed input with its original work and never starts it afterward',async t=>{
 const f=await fixture(t),q=f.queue();await q.enqueue(f.input('original'));await q.drain();
 const original=f.starts[0],turnId=original.start.conversationTurnId,id=await q.enqueue(f.input('correction'));
 await q.activeInputs(turnId,'native-job',()=>true).next();
 const revision=(await f.events.getLatestRevision(f.conversationId))+1;
 await f.events.append({conversationId:f.conversationId,expectedRevision:revision-1,events:[parseConversationEvent({
   version:1,event_id:randomUUID(),conversation_id:f.conversationId,revision,occurred_at:new Date().toISOString(),
   actor:{type:'user'},source:{type:'runtime'},payload:{type:'turn.cancelled',turn_id:turnId,reason:'user'}})]});
 await q.drain();await q.drain();
 assert.equal((await q.read(id)).status,'cancelled');assert.equal(f.starts.length,1);
 assert.deepEqual(await q.drain(),{pending:false});
});
