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
test('Runner Vault tool composes real custody/grants/effects and never exposes the private token', async t => {
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
