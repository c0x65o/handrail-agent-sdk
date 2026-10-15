import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { migrations } from './helpers/migrations.mjs';
import { services, identity, modelBoundary, requirement } from './helpers/agent-fixture.mjs';
const ok = r => { assert.equal(r.ok,true,r.code); return r.value; };

import './fixtures/installed/runtime.test.mjs';
async function setup(t,options = {}) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const client = await harness.client(); await migrations(t,harness,client);
  await client.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY, receipt text NOT NULL, attempts integer NOT NULL DEFAULT 1)`);
  const key = randomBytes(32).toString('hex');
  const s = await services(harness.schema,key,options); t.after(() => s.close());
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'agent-task', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  return { ...s, harness, client, key };
}
test('Hosted runtime Vault tool composes real custody/grants/effects and never exposes the private token', async t => {
  const { createSecretKey }=await import('node:crypto');
  const { z }=await import('zod');
  const { createVaultUse }=await import('../.reference-build/src/server/vault-use.js');
  const { createVaultGrants,vaultEffectRequest }=await import('../.reference-build/reference/node/vault-grants.js');
  const { createVaultStore }=await import('../.reference-build/reference/node/vault-store.js');
  const { referenceDatabase }=await import('../.reference-build/reference/node/db/database.js');
  const { vaultTables }=await import('../.reference-build/reference/node/db/schema.js');
  let use,request,grants,s;
  const privateToken=randomBytes(24).toString('hex');let reads=0;
  const reserve={name:'reserve',description:'Use a synthetic private token in a private executor.',kind:'vault',
    parameters:z.object({itemRef:z.literal('synthetic-item')}).strict(),
    bind:async call=>{
      if(!request) {
        const current=ok(await s.journal.load(identity));
        request={identity,jobRevision:current.revision,grantRef:'private-use',grantRevision:1,
          effect:{effectRef:call.effectRef,actionRef:'use',operationRef:'private-request'},operation:'server_request',
          item:{metadata:{kind:'token',tokenType:'api'},reference:{kind:'secret',itemRef:'private-item',revision:1}},
          destination:{endpoint:'https://fixture.invalid/setup',method:'POST',resourceRef:'approved-resource',redirects:'deny'}};
        const now=Date.now();
        ok(await grants.administration.put({request,issuedAt:now,expiresAt:now+30000,state:'active',
          permissions:{use:true,reveal:false,export:false},itemExpiresAt:now+60000,taskExpiresAt:now+60000},0));
      }
      return request;
    },vault:{execute:(...args)=>use.execute(...args)}};
  s=await setup(t,{reserve});
  const db=referenceDatabase(s.pool),key=createSecretKey(randomBytes(32));
  const keys={active:async()=>({keyHandle:'vault-fixture',keyVersion:1}),resolve:async()=>key};
  const storage={authorize:async()=>identity.host};
  const custody=createVaultStore(db,storage,keys,vaultTables(s.harness.schema));
  ok(await custody.create({metadata:{kind:'token',tokenType:'api'},reference:{kind:'secret',itemRef:'private-item',revision:1}},{token:privateToken}));
  grants=createVaultGrants(db,{now:Date.now,withOwner:async(_i,_op,run)=>run(identity.host)},keys,s.harness.schema);
  let verified=false;
  use=createVaultUse({now:Date.now,withAuthority:async(_r,_phase,run)=>run({...s.authority(),actorRef:'actor'})},grants.use,[{
    operationRef:'private-request',bind:r=>vaultEffectRequest(r,'fixture-vault-provider'),
    reconcile:async()=>verified?'verified':'not_applied',
    dispatch:async(_r,value,_signal,isCurrent)=>{assert.equal(isCurrent(),true);assert.equal(value.token,privateToken);reads++;verified=true;return 'verified';},
  }]);
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');
  assert.equal(reads,1);
  const state=ok(await s.states.load(identity,s.authority()));
  const events=(await s.client.query(`SELECT event FROM ${s.harness.table('job_events')}`)).rows;
  assert.ok(!JSON.stringify([state,events,s.events]).includes(privateToken));
});


test('provider diagnostics classify hosted failures without logging private provider bodies', async t => {
  const {APIError}=await import('openai');
  const privateBody='private-account-and-browser-data';
  const model={async *getStreamedResponse(){throw new APIError(429,{message:privateBody},privateBody,new Headers());}};
  const f=await setup(t,{model});
  assert.equal(ok(await f.runtime.wake(identity)),'retryable');
  assert.ok(f.events.some(event=>event.kind==='error'&&event.code==='provider_request_failed'&&event.providerStatus===429));
  assert.ok(!JSON.stringify(f.events).includes(privateBody));
  assert.equal(ok(await f.journal.load(identity)).state,'running');
});


test('a completed provider turn reconciles its declined native effect without dispatching or restarting', async t=>{
 let settled=false,dispatches=0;
 const s=await setup(t,{adapter:{dispatch:async()=>{dispatches++;throw Error('must not dispatch');},
  reconcile:async()=>settled?{outcome:'verified',receiptRef:'native-declined'}:{outcome:'unknown'}}});
 assert.equal(ok(await s.runtime.wake(identity)),'waiting');
 const table=s.harness.table('hosted_provider_fixture');
 const rows=await s.pool.query(`SELECT id,value FROM ${table}`);
 const provider=rows.rows.find(row=>row.value.session);
 const pending=provider.value.session.required_actions[0];
 assert.equal(pending.arguments.name,'reserve');
 provider.value.session.required_actions=[];provider.value.session.status='idle';provider.value.turn.status='completed';
 provider.value.turn.completed_at=Math.floor(Date.now()/1000);
 provider.value.items=[{...pending,id:pending.call_id,status:'failed'},
  {id:'final',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'The native action was not completed.'}]}];
 await s.pool.query(`UPDATE ${table} SET value=$2 WHERE id=$1`,[provider.id,JSON.stringify(provider.value)]);
 settled=true;s.state.resolution={receiptRef:'native-declined'};ok(await s.runtime.resume(identity));
 assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(dispatches,0);
 assert.equal(ok(await s.journal.load(identity)).effects[0].outcome,'verified');
 assert.equal((await s.pool.query(`SELECT value FROM ${table} WHERE id=$1`,[provider.id])).rows[0].value.messages.length,1);
});


test('failed hosted turn persists safe diagnostics and projects them after restart without replaying effects', async t => {
  const {createAgentRuntime}=await import('handrail-agent-sdk/server/agents');
  const {createAgentCheckpointReader}=await import('handrail-agent-sdk/server/application');
  const {parseStreamEvent}=await import('handrail-agent-sdk/assistant');
  const f=await setup(t,{runtimeFactory:options=>{
    const retrieve=options.harness.client.beta.agents.sessions.turns.retrieve;
    options.harness.client.beta.agents.sessions.turns.retrieve=async(...args)=>{
      const turn=await retrieve(...args);
      return turn.status==='completed'?{...turn,status:'failed',error:{code:'sandbox_error',message:'SECRET provider environment diagnostic'}}:turn;
    };
    return createAgentRuntime(options);
  }});
  assert.equal(ok(await f.runtime.wake(identity)),'failed');
  const saved=ok(await f.journal.load(identity));
  assert.deepEqual(saved.error,{code:'provider_turn_failed',correlationRef:identity.origin.correlationRef,providerFailureCode:'sandbox_error'});
  assert.equal(ok(await f.states.load(identity,f.authority())).providerFailure.message,'SECRET provider environment diagnostic');
  const journal=(await f.client.query(`SELECT event FROM ${f.harness.table('job_events')}`)).rows;
  assert.ok(!JSON.stringify([journal,f.events]).includes('SECRET'));
  assert.ok(f.events.some(e=>e.code==='provider_turn_failed'&&e.providerFailureCode==='sandbox_error'));
  const before=f.model.requests;
  await f.runtime.stop();
  const fresh=await services(f.harness.schema,f.key);t.after(()=>fresh.close());
  const member={id:'fixture',source:'server_derived',trust:'authoritative'};
  const reader=createAgentCheckpointReader({runtime:fresh.runtime,attribution:async()=>({organization:member,project:member,service_environment:member,known_user:member,session:member,automation:{...member,id:null}}),pendingToolCallIds:async()=>[]});
  const binding={identity,turnId:'turn-one',mutationId:'mutation-one'};
  const empty={lastAppliedCursor:null,lastAppliedEventId:null,lastAppliedRevision:null};
  const first=await reader(binding,empty);
  const error=first.events.map(parseStreamEvent).find(e=>e.type==='response.error').error;
  assert.match(error.message,/hosted execution environment failed/);assert.equal(error.retryable,false);
  assert.equal(first.result.error.message,error.message);
  const replay=await reader(binding,first.checkpoint);assert.deepEqual(replay.events,[]);assert.equal(replay.result.error.message,error.message);
  assert.equal(ok(await fresh.runtime.wake(identity)),'failed');
  assert.equal(f.model.requests,before);assert.equal(fresh.model.requests,0);
  assert.equal((await f.client.query(`SELECT attempts FROM ${f.harness.table('synthetic_provider')}`)).rows[0].attempts,1);
});
