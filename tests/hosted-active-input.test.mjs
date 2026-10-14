import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostedSessionClient,prepareHostedInput} from '../dist/server/hosted-session.js';

for(const finishRace of [false,true])test(`running observer accepts canonical input with original custody (finish race: ${finishRace})`,async()=>{
  const session={id:'s',metadata:{handrail_scope:'scope',handrail_creation:'creation',handrail_configuration:'config'},status:'in_progress',required_actions:[]};
  const original={id:'old',status:'in_progress',subagent_id:null};
  const successor={id:'new',status:'in_progress',subagent_id:null};
  let current=original,submitted=0,received=0,closed=0;
  const messages=[{role:'user',content:[{type:'input_text',text:'Correction: use the new value and stop the earlier read.'}]}];
  let pending=prepareHostedInput({sessionId:'s',originalTurnId:'old',submissionKey:'native-input',messages});
  let binding={submissionKey:'original',baseline:null,submissionAttempted:true,turnId:'old'};
  const items=[{id:'outdated',type:'message',role:'assistant',phase:'final_answer',turn_id:'old',content:[{type:'output_text',text:'outdated answer'}]}];
  let sent;const sentPromise=new Promise(resolve=>sent=resolve);
  const page=data=>Object.assign(Promise.resolve({data,async *iterPages(){yield {data};}}),{async *[Symbol.asyncIterator](){yield* data;}});
  const sessions={retrieve:async()=>session,items:{list:()=>page([...items].reverse())},
    turns:{list:()=>page([current]),retrieve:async id=>id==='old'?original:successor,
      items:{list:(_id)=>page(items.filter(item=>item.turn_id===_id))}},
    events:{
      stream:async()=>({controller:{abort(){closed++;}},async *[Symbol.asyncIterator](){
        // No progress event wakes the host. Its native inbox polling must deliver.
        await sentPromise;
        if(finishRace)yield {type:'agent.session.turn.completed',turn:original};
        items.push({id:'final',type:'message',role:'assistant',phase:'final_answer',turn_id:current.id,
          content:[{type:'output_text',text:'corrected answer'}]});
        current.status='completed';session.status='idle';
        yield {type:'agent.session.turn.completed',turn:current};
      }}),
      create:async(_id,body)=>{
        submitted++;assert.equal(body['Idempotency-Key'],'native-input');
        assert.equal(pending.attempted,true);
        if(finishRace){original.status='completed';current=successor;}
        items.push({id:'correction',type:'message',role:'user',turn_id:current.id,content:body.events[0].input[0].content});
        sent();
      },
    }};
  const driver=createHostedSessionClient({client:{beta:{agents:{sessions}}},model:'fixture',instructions:'fixture'});
  const result=await driver.run({session:{sessionId:'s',scopeDigest:'scope',creationKey:'creation',configurationDigest:'config'},
    turn:binding,input:[],signal:AbortSignal.timeout(1000),authorize:async()=>{},save:async next=>binding=next,
    action:async()=>{throw Error('No domain action expected');},activeInput:{pollMs:1,
      next:async()=>received?null:{binding:pending,messages},save:async next=>pending=next,
      received:async next=>{assert.equal(next.receipt.messageId,'correction');received++;},defer:async()=>{throw Error('Unexpected deferral');}}});
  assert.equal(result.status,'terminal');assert.equal(result.outputText,'corrected answer');
  assert.equal(result.turn.id,finishRace?'new':'old');
  assert.deepEqual(result.priorTurns.map(turn=>turn.id),finishRace?['old']:[]);
  assert.equal(binding.submissionKey,'original');assert.equal(binding.lastInputMessageId,'correction');
  assert.equal(submitted,1);assert.equal(received,1);assert.equal(closed,1);
});
