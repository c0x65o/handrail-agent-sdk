import test from 'node:test';
import assert from 'node:assert/strict';
import { attachHostedFile } from '../dist/server/hosted-files.js';
function fixture() {
 const session={sessionId:'session',scopeDigest:'scope',creationKey:'creation',configurationDigest:'config'};
 let receipt,creates=0,fail=false,denied=false;const files=[];
 const client={beta:{agents:{sessions:{retrieve:async()=>({id:'session',metadata:{handrail_scope:'scope',handrail_creation:'creation',handrail_configuration:'config'},environment:{type:'openai_hosted',id:'environment'}})},environments:{retrieve:async()=>({id:'environment',type:'openai_hosted',status:'connected'}),files:{
   list:()=>({async *[Symbol.asyncIterator](){yield* files;}}),
   create:async(environment,body)=>{creates++;const file={environment_id:environment,path:body.path,size_bytes:Buffer.from(body.data,'base64').length};files.push(file);if(fail)throw Error('lost response');return file;}
 }}}}};
 const run=()=>attachHostedFile(client,{session,source:{data:new Uint8Array([1,2,3]),filename:'../../fixture.pdf'},...(receipt?{receipt}:{}),signal:new AbortController().signal,
 authorize:async()=>{if(denied)throw Error('revoked');},save:async next=>{receipt=structuredClone(next);}});
 return {run,files,session,get receipt(){return receipt;},get creates(){return creates;},set fail(v){fail=v;},set denied(v){denied=v;}};
}
test('hosted file upload retains receipt and safe workspace destination',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.copied,true);assert.equal(r.sizeBytes,3);assert.ok(r.path.startsWith('/workspace/handrail-inputs/'));assert.ok(!r.path.includes('../'));
 await f.run();assert.equal(f.creates,1);
});
test('lost environment-file response reconciles original destination without a second upload',async()=>{
 const f=fixture();f.fail=true;await assert.rejects(f.run(),/lost response/);assert.equal(f.receipt.attempted,true);assert.equal(f.receipt.copied,false);
 f.fail=false;assert.equal((await f.run()).copied,true);assert.equal(f.creates,1);
});
test('uncertain file copy, scope mismatch, missing file and authority loss never silently replace content',async()=>{
 const f=fixture();f.fail=true;await assert.rejects(f.run());f.files.length=0;
 await assert.rejects(f.run(),/COPY_UNCERTAIN/);assert.equal(f.creates,1);
 const g=fixture();await g.run();g.files.length=0;await assert.rejects(g.run(),/FILE_MISSING/);assert.equal(g.creates,1);
 const h=fixture();h.session.scopeDigest='other';await assert.rejects(h.run(),/SCOPE_CONFLICT/);assert.equal(h.creates,0);
 const i=fixture();i.denied=true;await assert.rejects(i.run(),/revoked/);assert.equal(i.creates,0);
});
