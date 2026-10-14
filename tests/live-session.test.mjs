import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveSessionService,liveResultChunks,LiveTransportError} from '../dist/server/live-session.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(await check())return;await pause(5);}assert.fail('Live state did not settle');}
function fixture(t,overrides={}) {
  const fragments=[],sent=[],queued=[],usage=[],finished=[],results=new Map();
  let events,access=true,createCount=0;
  const service=createLiveSessionService({
    authorize:async()=>{if(!access)throw Error('Access revoked');return {};},
    prepareContext:async()=>({input:[],reference:'Saved context',fingerprint:'initial',projectId:'project'}),
    recordProviderSession:async(_scope,id)=>assert.equal(id,'live_original'),
    transcripts:{append:async(_scope,fragment)=>{fragments.push(fragment);},
      read:async(_scope,after,through)=>fragments.filter(f=>f.sequence>after&&f.sequence<=through)},
    enqueue:async input=>{input.validateCurrent();queued.push(input);return {queued_message_id:`work-${queued.length}`};},
    readResult:async(_thread,id)=>results.get(id),
    recordUsage:async receipt=>{usage.push(receipt);},onFinish:async receipt=>{finished.push(receipt);},
    connect:async input=>{createCount++;events=input.onEvent;await input.onCreated('live_original');return {
      providerId:'live_original',sdp:'v=0\r\nanswer',send:event=>sent.push(event),hangup:async()=>{},dispose(){},
    };},
    instructions:'Delegate work to the saved agent.',pollMs:5,contextPollMs:60_000,closeMs:10,transcriptSettleMs:1,
    ...overrides,
  });
  t.after(()=>service.dispose());
  let n=0;
  return {service,fragments,sent,queued,usage,finished,results,revoke:()=>{access=false;},creates:()=>createCount,
    event:e=>events(e),
    speech:(text='Check the website.',id=`speech-${++n}`)=>events({type:'session.input_transcript.delta',event_id:id,delta:text,start_ms:n,end_ms:n+1}),
    delegate:(id='delegation-1')=>events({type:'session.delegation.created',event_id:`event-${id}`,offset_ms:1_000_000,delegation:{target:'client',id,type:'delegation'}}),
    start:(extra={})=>service.create({id:'original-session-request',threadId:'thread',principalId:'owner',context:{owner:'owner'},sdp:'v=0\r\noffer',...extra}),
    state:()=>service.heartbeat('original-session-request','owner'),
  };
}

test('speech is admitted once to the saved conversation and results retain the original delegation',async t=>{
  const f=fixture(t);await f.start();
  f.speech('Check the website.','input-1');f.speech('Check the website.','input-1');f.delegate();f.delegate();
  await until(()=>f.queued.length===1);
  assert.equal(f.queued[0].body,'Check the website.');assert.equal(f.fragments.length,1);
  assert.equal(f.queued[0].threadId,'thread');assert.equal(f.queued[0].context.owner,'owner');
  f.delegate('new-id-same-speech');await pause(20);assert.equal(f.queued.length,1);
  f.results.set('work-1',{status:'succeeded',text:'The hosted browser verified the page.'});
  await until(()=>f.sent.some(e=>e.type==='session.commentary.append'));
  assert.equal(f.sent.find(e=>e.type==='session.commentary.append').delegation_id,'delegation-1');
});

test('full durable speech survives the caption window and is not silently truncated',async t=>{
  const f=fixture(t);await f.start();
  const speech=Array.from({length:210},(_,index)=>`${index}: ${'Long observed instruction. '.repeat(110)}`);
  for(const text of speech)f.speech(text);
  f.delegate();await until(()=>f.queued.length===1);
  assert.equal(f.queued[0].body,speech.join(''));
  assert.equal(f.queued[0].speech.owner_fragment_ids.length,210);
});

test('corrections supersede stale spoken results and hangup leaves admitted work intact',async t=>{
  const f=fixture(t);await f.start();f.speech();f.delegate();await until(()=>f.queued.length===1);
  f.speech('Actually inspect the other page.');f.delegate('correction');await until(()=>f.queued.length===2);
  f.results.set('work-1',{status:'succeeded',text:'Stale result'});
  f.results.set('work-2',{status:'succeeded',text:'Corrected result'});
  await until(()=>f.sent.some(e=>e.type==='session.commentary.append'));
  assert.deepEqual(f.sent.filter(e=>e.type==='session.commentary.append').map(e=>e.content),['Corrected result']);
  f.service.close('original-session-request','owner');
  f.event({type:'session.closed',reason:'close_requested',usage:{seconds:8},session:{id:'live_original'}});
  await until(()=>f.finished.length===1);
  assert.equal(f.queued.length,2);assert.equal(f.usage.length,1);assert.equal(f.usage[0].seconds,8);
  assert.equal(f.usage[0].finalized,true);assert.equal(f.usage[0].projectId,'project');
});

test('native UI requests never impersonate OpenAI-issued delegation IDs',async t=>{
  const f=fixture(t);await f.start();
  await f.service.submit('original-session-request','owner',{requestId:'open-brief',body:'Read the saved brief.'});
  await f.service.submit('original-session-request','owner',{requestId:'open-brief',body:'Read the saved brief.'});
  assert.equal(f.queued.length,1);
  f.results.set('work-1',{status:'succeeded',text:'Here is the saved brief.'});
  await until(()=>f.sent.some(e=>e.type==='session.commentary.append'));
  assert.equal(f.sent.find(e=>e.type==='session.commentary.append').delegation_id,null);
});

test('an uncertain admission is retained and never retried under a fresh delegation',async t=>{
  let attempts=0;
  const f=fixture(t,{enqueue:async()=>{attempts++;throw Error('Receipt lost');}});await f.start();
  f.speech();f.delegate();await until(()=>attempts===1);f.delegate();f.delegate('new-id');await pause(20);
  assert.equal(attempts,1);assert.equal((await f.state()).delegations[0].status,'unconfirmed');
});

test('failed transcript persistence prevents partial admission',async t=>{
  const f=fixture(t,{transcripts:{append:async()=>{throw Error('Storage unavailable');},read:async()=>{throw Error('Must not read');}}});
  await f.start();f.speech();f.delegate();
  await until(()=>f.sent.some(e=>e.type==='session.commentary.append'));
  assert.equal(f.queued.length,0);assert.equal((await f.state()).delegations[0].status,'rejected');
});

test('creation replay is scoped and authorization revocation closes without admitting speech',async t=>{
  const f=fixture(t);const first=await f.start();assert.deepEqual(await f.start(),first);assert.equal(f.creates(),1);
  await assert.rejects(f.start({principalId:'other'}),{statusCode:404});
  await assert.rejects(f.start({threadId:'other'}),{statusCode:409});
  f.revoke();f.speech();f.delegate();await until(()=>f.finished.length===1);
  assert.equal(f.queued.length,0);assert.equal(f.usage[0].finalized,false);
});

test('voice usage is cumulative and persisted once, and storage failures remain visible',async t=>{
  let attempts=0;
  const f=fixture(t,{recordUsage:async()=>{attempts++;throw Error('Usage storage unavailable');}});await f.start();
  f.event({type:'session.usage.updated',usage:{seconds:9}});
  f.event({type:'session.usage.updated',usage:{seconds:5}});
  const closed={type:'session.closed',reason:'close_requested',usage:{seconds:10},session:{id:'live_original'}};
  f.event(closed);f.event(closed);await until(()=>f.finished.length===1);
  const state=await f.state();assert.equal(attempts,1);assert.equal(state.usage_seconds,10);
  assert.equal(state.status,'error');assert.match(state.error,/usage could not be saved/);
});

test('result chunking preserves Unicode without exceeding OpenAI append capacity',()=>{
  const original='Hello 世界 🌎 '.repeat(150);
  const chunks=liveResultChunks(original);assert.equal(chunks.join(''),original);
  assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk)<=480));
  assert.throws(()=>liveResultChunks('text',1));
});

test('ending waits for usage custody and captures final speech emitted during close',async t=>{
  let saveUsage,saveStarted=false;
  const saved=new Promise(resolve=>{saveUsage=resolve;});
  const f=fixture(t,{recordUsage:async()=>{saveStarted=true;await saved;},closeMs:1000});await f.start();
  let ended=false;const ending=f.service.end('original-session-request','owner').then(value=>{ended=true;return value;});
  f.speech('Final words during close.');
  f.event({type:'session.closed',reason:'close_requested',usage:{seconds:7},session:{id:'live_original'}});
  await until(()=>saveStarted);assert.equal(ended,false);assert.equal(f.fragments[0].text,'Final words during close.');
  saveUsage();const result=await ending;assert.equal(result.usage_finalized,true);assert.equal(result.status,'closed');
});

test('lost control attempts original remote hangup and exposes uncertain termination',async t=>{
  let disconnect,hangups=0;
  const f=fixture(t,{connect:async input=>{disconnect=input.onDisconnect;await input.onCreated('live_original');return {
    providerId:'live_original',sdp:'v=0\r\nanswer',send(){},dispose(){},hangup:async()=>{hangups++;throw Error('Offline');},
  };}});await f.start();disconnect('Voice connection lost.');await until(()=>f.finished.length===1);
  assert.equal(hangups,1);assert.equal(f.usage[0].finalized,false);assert.match((await f.state()).error,/end is unconfirmed/);
});

test('replaying a creation receipt still requires current access',async t=>{
  const f=fixture(t);await f.start();f.revoke();await assert.rejects(f.start(),/Access revoked/);
  assert.equal(f.creates(),1);
});

test('proven pre-admission rejection preserves earlier speech for a correction',async t=>{
  let f,release,attempts=0;const waiting=new Promise(resolve=>{release=resolve;});const admitted=[];
  f=fixture(t,{enqueue:async input=>{attempts++;if(attempts===1)await waiting;input.validateCurrent();admitted.push(input);return {queued_message_id:'original-work'};}});
  await f.start();f.speech('Change the first page. ');f.delegate();await until(()=>attempts===1);
  f.speech('Actually the second page.');release();
  await until(async()=>(await f.state()).delegations[0].status==='rejected');
  f.delegate('correction');await until(()=>admitted.length===1);
  assert.equal(admitted[0].body,'Change the first page. Actually the second page.');
});

test('successful remote hangup confirms audio termination without inventing final usage',async t=>{
 const f=fixture(t);await f.start();
 const ending=f.service.end('original-session-request','owner');
 // Keep the standalone test alive while the server's unref'ed close timer runs.
 await pause(20);const result=await ending;
 assert.equal(result.end_confirmed,true);assert.equal(result.usage_finalized,false);
 assert.equal(f.usage[0].finalized,false);
});


test('native policy can answer or remain silent without a fabricated work receipt',async t=>{
 let mode='answer',calls=0;
 const f=fixture(t,{enqueue:async input=>{input.validateCurrent();calls++;return {handled:mode,reply:mode==='answer'?'Your saved task is running.':''};}});
 await f.start();f.speech('Give me an update.');f.delegate();
 await until(()=>f.sent.some(e=>e.type==='session.commentary.append'));
 assert.equal((await f.state()).delegations[0].status,'answer');
 assert.equal((await f.state()).delegations[0].queued_message_id,null);
 mode='silence';f.speech('Stop speaking.');f.delegate('quiet');await until(()=>calls===2);await pause(20);
 assert.equal((await f.state()).delegations[1].status,'silence');
 assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,1);
 assert.equal((await f.state()).error,null);
});


test('ending during native creation admission confirms no provider IO and settles End',async t=>{
 let unblock,entered=false;
 const gate=new Promise(resolve=>{unblock=resolve;});
 const f=fixture(t,{beforeConnect:async()=>{entered=true;await gate;}});
 const start=f.start();const rejection=assert.rejects(start,{statusCode:409});await until(()=>entered);
 const end=f.service.end('original-session-request','owner');unblock();await rejection;
 assert.equal((await end).end_confirmed,true);assert.equal(f.creates(),0);assert.equal(f.usage.length,0);
});


test('proven creation rejection or confirmed startup cleanup releases the original call',async t=>{
 for(const evidence of ['not_created','requested']) {
  const failure=new LiveTransportError('creation_failed');
  if(evidence==='not_created')failure.creationOutcome=evidence;else failure.cleanup=evidence;
  const f=fixture(t,{connect:async()=>{throw failure;}});await assert.rejects(f.start());
  const state=await f.service.end('original-session-request','owner');
  assert.equal(state.end_confirmed,true);assert.equal(state.usage_finalized,false);
 }
 const uncertain=fixture(t,{connect:async()=>{throw new LiveTransportError('creation_failed');}});
 await assert.rejects(uncertain.start());assert.equal((await uncertain.service.end('original-session-request','owner')).end_confirmed,false);
});
