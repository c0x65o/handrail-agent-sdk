import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {retainHostedArtifacts} from '../dist/server/hosted-session.js';
const session={sessionId:'s',creationKey:'key',scopeDigest:'scope',configurationDigest:'config'};
const turn={id:'t',session_id:'s',subagent_id:null,status:'completed'};
const bytes=Buffer.from('actual retained file');
const item={id:'a',session_id:'s',turn_id:'t',environment_id:'e',size_bytes:bytes.length,path:'/workspace/outputs/file.txt'};
function fixture(){
 const saved=[],calls=[];
 const api={list:async function*(){yield {...item,turn_id:'older'};yield item;},content:async(id,args)=>{calls.push([id,args]);return new Response(bytes,{headers:{'content-type':'text/plain'}});}};
 const client={beta:{agents:{sessions:{retrieve:async()=>({metadata:{handrail_scope:'scope',handrail_creation:'key',handrail_configuration:'config'},environment:{id:'e',type:'openai_hosted'}}),artifacts:api}}}};
 const ports={session,turn,signal:new AbortController().signal,maxBytes:1024,authorize:async()=>{},retain:async artifact=>{saved.push(artifact);return artifact.metadata.id;}};
 return {saved,calls,api,client,ports};
}
test('retains bytes and digest from only the exact original hosted turn',async()=>{
 const f=fixture();assert.deepEqual(await retainHostedArtifacts(f.client,f.ports),['a']);
 assert.equal(f.saved.length,1);assert.deepEqual(f.saved[0].data,bytes);
 assert.equal(f.saved[0].sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.deepEqual(f.calls,[['a',{session_id:'s'}]]);
});
for(const mode of ['session','environment','scope','size','capacity','owner','cancel'])test(`artifact custody rejects changed ${mode}`,async()=>{
 const f=fixture();
 if(mode==='session')f.ports.turn={...turn,session_id:'other'};
 if(mode==='environment')f.api.list=async function*(){yield {...item,environment_id:'other'};};
 if(mode==='scope')f.ports.session={...session,scopeDigest:'other'};
 if(mode==='size')f.api.content=async()=>new Response(Buffer.from('short'));
 if(mode==='capacity')f.ports.maxBytes=1;
 if(mode==='owner'){let checks=0;f.ports.authorize=async()=>{if(++checks===3)throw Error('revoked');};}
 if(mode==='cancel')f.ports.signal=AbortSignal.abort();
 await assert.rejects(retainHostedArtifacts(f.client,f.ports));assert.equal(f.saved.length,0);
});
