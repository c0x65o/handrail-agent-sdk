import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareHostedInput,submitHostedInput} from '../dist/server/hosted-session.js';

function fixture() {
  const messages=[{role:'user',content:[{type:'input_text',text:'Cancel the current read. Do not start another operation.'}]}];
  const session={sessionId:'session_1',scopeDigest:'scope_1',creationKey:'creation_1',configurationDigest:'config_1'};
  let saved=prepareHostedInput({sessionId:'session_1',originalTurnId:'turn_1',submissionKey:'native_input_1',messages});
  let turn={id:'turn_1',status:'in_progress'},receivedTurn='turn_1',lost=false,saveFails=false,authorized=true,persist=true;
  const items=[],writes=[],history=[];
  const page=data=>Object.assign(Promise.resolve({data}),{async *[Symbol.asyncIterator](){yield* data;}});
  const sessions={
    async retrieve(){return {metadata:{handrail_scope:session.scopeDigest,handrail_creation:session.creationKey,
      handrail_configuration:session.configurationDigest},required_actions:[]};},
    turns:{list(){return page([turn]);}},items:{list(){return page(items);}},
    events:{async create(id,body){
      assert.equal(saved.attempted,true,'intent must be retained before provider write');
      writes.push(structuredClone({id,body}));
      if(persist&&!items.length)items.push({id:'item_1',type:'message',role:'user',turn_id:receivedTurn,
        content:structuredClone(body.events[0].input.at(-1).content)});
      if(lost)throw Error('transport_lost');
    }},
  };
  const ports={client:{beta:{agents:{sessions}}},session,messages,signal:new AbortController().signal,
    async authorize(){if(!authorized)throw Error('not_authorized');},
    async save(binding){if(saveFails)throw Error('storage_unavailable');saved=structuredClone(binding);history.push(saved);}};
  return {ports,sessions,messages,session,items,writes,history,
    run:()=>submitHostedInput({...ports,binding:saved}),
    get saved(){return saved;},set saved(v){saved=v;},
    set turn(v){turn=v;},set receivedTurn(v){receivedTurn=v;},set lost(v){lost=v;},
    set persist(v){persist=v;},set saveFails(v){saveFails=v;},set authorized(v){authorized=v;}};
}

test('active input retains exact provider receipt and does not resend after recovery',async()=>{
  const f=fixture();const result=await f.run();
  assert.deepEqual(result,{status:'received',turnId:'turn_1',messageId:'item_1'});
  assert.equal(f.writes[0].body['Idempotency-Key'],'native_input_1');
  assert.equal(f.messages[0].content.length,1,'transport marker must not mutate canonical input');
  assert.deepEqual(await f.run(),result);assert.equal(f.writes.length,1);
});
test('lost accepted reply recovers exact saved message before considering a replay',async()=>{
  const f=fixture();f.lost=true;await assert.rejects(f.run(),/transport_lost/);
  assert.equal(f.saved.attempted,true);assert.equal(f.saved.receipt,undefined);
  const result=await f.run();assert.equal(result.status,'received');assert.equal(f.writes.length,1);
});
test('acceptance without saved input remains pending without repeated submissions',async()=>{
  const f=fixture();f.persist=false;
  assert.deepEqual(await f.run(),{status:'pending'});
  assert.deepEqual(await f.run(),{status:'pending'});assert.equal(f.writes.length,1);
  f.items.push({id:'item_1',type:'message',role:'user',turn_id:'turn_1',content:f.writes[0].body.events[0].input[0].content});
  assert.equal((await f.run()).status,'received');assert.equal(f.writes.length,1);
});
test('uncertain submission without a saved receipt replays the identical bytes and key',async()=>{
  const f=fixture();f.persist=false;f.lost=true;
  await assert.rejects(f.run(),/transport_lost/);
  f.persist=true;f.lost=false;assert.equal((await f.run()).status,'received');
  assert.deepEqual(f.writes[0],f.writes[1]);
});
test('finish/submission race binds the provider-created successor instead of guessing the original turn',async()=>{
  const f=fixture();f.receivedTurn='turn_2';
  assert.equal((await f.run()).turnId,'turn_2');assert.equal(f.saved.originalTurnId,'turn_1');
});
test('a finished or replaced turn cannot be steered as a new unowned request',async()=>{
  const f=fixture();f.turn={id:'turn_1',status:'completed'};
  assert.deepEqual(await f.run(),{status:'not_submitted',reason:'turn_finished'});assert.equal(f.writes.length,0);
  f.turn={id:'unrelated_turn',status:'in_progress'};await assert.rejects(f.run(),/BINDING_CONFLICT/);
  assert.equal(f.writes.length,0);
});
test('storage failures, revoked authority and modified retry input prevent provider writes',async()=>{
  const f=fixture();f.saveFails=true;await assert.rejects(f.run(),/storage_unavailable/);assert.equal(f.writes.length,0);
  f.saveFails=false;f.authorized=false;await assert.rejects(f.run(),/not_authorized/);assert.equal(f.writes.length,0);
  f.authorized=true;f.messages[0].content[0].text='Different instruction';
  await assert.rejects(f.run(),/BINDING_CONFLICT/);assert.equal(f.writes.length,0);
});
test('pending native browser/tool approval remains pending',async()=>{
  const f=fixture();const retrieve=f.sessions.retrieve;
  f.sessions.retrieve=async()=>({...await retrieve(),required_actions:[{type:'computer_use_approval_request'}]});
  assert.deepEqual(await f.run(),{status:'not_submitted',reason:'requires_action'});
  assert.equal(f.writes.length,0);assert.equal(f.saved.attempted,undefined);
});
