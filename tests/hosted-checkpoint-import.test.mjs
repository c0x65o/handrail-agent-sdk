import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import { readHostedCheckpointImport } from '../dist/server/hosted-checkpoint-import.js';

test('one-way cutover reads a real 0.18.0 checkpoint without executing its pending tool',async()=>{
 let invoked=0;
 const agent=new Agent({name:'prior-sdk',instructions:'test',model:{
  async getResponse(){return {responseId:'old-response',usage:{requests:1,inputTokens:2,outputTokens:1,totalTokens:3},
   output:[{type:'function_call',callId:'original-call',name:'reserve',arguments:'{"item":"one"}'}]};},
  async *getStreamedResponse(){throw Error('not used');}
 },tools:[tool({name:'reserve',description:'test',parameters:z.object({item:z.string()}),needsApproval:true,execute:async()=>{invoked++;return 'done';}})]});
 const result=await new Runner({tracingDisabled:true}).run(agent,'Keep the original task');
 const imported=readHostedCheckpointImport(result.state.toString());
 assert.equal(invoked,0);assert.equal(imported.pending[0].callId,'original-call');assert.equal(imported.pending[0].name,'reserve');
 assert.equal(imported.history[0].content,'Keep the original task');
 const state=JSON.parse(result.state.toString());state.pendingInput=[{role:'user',content:'Saved correction'}];
 assert.equal(readHostedCheckpointImport(JSON.stringify(state)).history.at(-1).content,'Saved correction');
 state.currentStep={type:'next_step_final_output',output:'Saved final answer'};
 assert.equal(readHostedCheckpointImport(JSON.stringify(state)).output,'Saved final answer');
 state.$schemaVersion='unknown';assert.throws(()=>readHostedCheckpointImport(JSON.stringify(state)));
});
