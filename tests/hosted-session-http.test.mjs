import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createHostedSessionClient } from '../dist/server/hosted-session.js';
test('official OpenAI client uses Agents sessions/events HTTP, with hosted desktop and no local Responses inference',async()=>{
 let session,turn,creation;const calls=[];
 const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const client=new OpenAI({apiKey:'fixture-only',baseURL:'https://fixture.invalid/v1',maxRetries:0,fetch:async(url,options)=>{
   const path=new URL(url).pathname,method=options.method??'GET';calls.push([method,path]);
   assert.ok(!path.includes('/responses'));assert.equal(new Headers(options.headers).get('openai-beta'),'agents=v1');
   const body=options.body?JSON.parse(options.body):null;
   if(method==='POST' && path==='/v1/agents/sessions'){
     creation=body;session={id:'session-http',metadata:body.metadata,status:'idle',required_actions:[]};return json(session);
   }
   if(path.endsWith('/events') && method==='GET')return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
   if(path.endsWith('/events') && method==='POST'){
     assert.ok(new Headers(options.headers).get('idempotency-key'));turn={id:'turn-http',session_id:session.id,subagent_id:null,status:'completed'};return json({});
   }
   if(path.endsWith('/turns'))return json({data:turn?[turn]:[],has_more:false});
   if(path.endsWith('/items'))return json({data:[{type:'message',id:'result',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Hosted HTTP result'}]}],has_more:false});
   if(path.endsWith('/turns/turn-http'))return json(turn);
   if(path.endsWith('/session-http'))return json(session);
   throw Error(`Unexpected fixture route ${method} ${path}`);
 }});
 const driver=createHostedSessionClient({client,model:'host-configured-model',instructions:'Fixture instructions'});
 let binding=driver.binding({tenant:'fixture'},'fixture-create');const signal=new AbortController().signal;
 await driver.connect({binding,signal,authorize:async()=>{},save:async next=>{binding=next;}});
 let submitted={submissionKey:'fixture-input'};
 const result=await driver.run({session:binding,turn:submitted,input:[{role:'user',content:[{type:'input_text',text:'Hello'}]}],signal,
   authorize:async()=>{},save:async next=>{submitted=next;},action:async()=>{throw Error('unexpected action');}});
 assert.equal(result.outputText,'Hosted HTTP result');assert.equal(submitted.turnId,'turn-http');
 assert.deepEqual(creation.environment.desktop,{enabled:true});assert.ok(creation.agent.tools.some(t=>t.type==='computer_use'));
 assert.equal(creation.agent.model,'host-configured-model');assert.equal('max_output_tokens' in creation.agent,false);
 assert.equal('temperature' in creation.agent,false);assert.equal('top_p' in creation.agent,false);
 assert.ok(calls.findIndex(([method,path])=>method==='GET'&&path.endsWith('/events'))<calls.findIndex(([method,path])=>method==='POST'&&path.endsWith('/events')));
});
