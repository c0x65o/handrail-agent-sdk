import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandrailDelegatedFeedbackObserver} from '../dist/server/handrail-feedback.js';
const key={id:'grant',scope:{tenantRef:'tenant',userRef:'user',accountRef:'user',projectRef:'app',environmentRef:'runtime',purposeRef:'feedback'}};
const grant={id:'grant',kind:'enhancement',report_id:'report',binding:{project_id:'project',service_env_id:'runtime',environment:'staging',tenant_ref:'tenant',user_ref:'user',conversation_id:'original'},expires_at:'2099-01-01T00:00:00.000Z',cancelled:false};
const spec={kind:'watch',adapterRef:'feedback',subjectRef:'enhancement:report',contentRef:'grant',pollMs:30000,maxAgeMs:60000,expiresAt:Date.parse(grant.expires_at)};
const record={id:'report',status:'received',status_group:'needs_attention'};
const signal=new AbortController().signal;
test('delegated observer preserves pending questions and accepts only matching canonical evidence',async()=>{
  let result={contract_version:'v1',observation:grant,record};
  const observer=createHandrailDelegatedFeedbackObserver({now:()=>1000,load:async()=>grant,read:async()=>result});
  assert.equal((await observer.read(key,spec,signal)).status,'needs_input');
  result={...result,record:{...record,delivery_journey:{contract_version:2,verification_status:'passed',verification_environment:'staging',verified_environment:'staging',released_environment:'staging'},release_tracking:{environments:[{environment:'staging',deployment_state:'fully_deployed',targets:[{contains_change:true}]}]}}};
  assert.equal((await observer.read(key,spec,signal)).status,'matched');
  result={...result,observation:{...grant,binding:{...grant.binding,conversation_id:'redirected'}}};
  await assert.rejects(observer.read(key,spec,signal),/identity_mismatch/);
});
test('wrong scope, expired/cancelled authority and mismatched report fail before external IO',async()=>{
  let reads=0;
  for(const invalid of [{...grant,cancelled:true},{...grant,expires_at:'invalid'},{...grant,expires_at:'1970-01-01T00:00:00Z'},
    {...grant,report_id:'another'},...['tenant_ref','user_ref','service_env_id'].map(field=>({...grant,binding:{...grant.binding,[field]:'wrong'}}))]) {
    const observer=createHandrailDelegatedFeedbackObserver({now:()=>1000,load:async()=>invalid,read:async()=>{reads++;throw Error('unexpected read');}});
    await assert.rejects(observer.read(key,spec,signal),/scope_denied/);
  }
  assert.equal(reads,0);
});
