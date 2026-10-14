import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveHistoryReader} from '../dist/server/live-session.js';

test('undelegated user and assistant speech remains read-only context with paging',async()=>{
  const events=[];
  const reader=createLiveHistoryReader({authorize:async scope=>events.push(['authorize',scope]),
    read:async(scope,cursor)=>{events.push(['read',scope,cursor]);return {items:[{id:'speech-1',callId:'call',sequence:1,role:'user',text:'ocean velvet'}],nextCursor:'older'};},
    retrieval:{tool:'history',arguments:{channel:'voice'},cursorArgument:'cursor'}});
  const text=await reader.context('saved-conversation');
  assert.match(text,/ocean velvet/);assert.match(text,/historical data/);assert.match(text,/older/);
  assert.deepEqual(events.map(e=>e[0]),['authorize','read','authorize']);
  await reader.read('saved-conversation','older');
  assert.deepEqual(events.at(-2),['read','saved-conversation','older']);
});
test('revocation during history read exposes no transcript',async()=>{
  let allowed=true;
  const reader=createLiveHistoryReader({authorize:async()=>{if(!allowed)throw Error('revoked');},
    read:async()=>{allowed=false;return {items:[{id:'x',callId:'c',sequence:1,role:'assistant',text:'private'}],nextCursor:null};},
    retrieval:{tool:'history',cursorArgument:'cursor'}});
  await assert.rejects(reader.context(null),/revoked/);
});
test('empty retained speech adds no synthetic message',async()=>{
  const reader=createLiveHistoryReader({authorize:async()=>{},read:async()=>({items:[],nextCursor:null}),retrieval:{tool:'history',cursorArgument:'cursor'}});
  assert.equal(await reader.context(null),null);
});
