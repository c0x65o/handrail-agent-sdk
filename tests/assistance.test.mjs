import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createPostgresHarness } from '../.postgres-build/postgres.js';
import { createAssistance, resolveScheduleTime, assistanceClock } from 'handrail-agent-sdk/server/assistance';
import { assistancePostgresSchema, createPostgresAssistanceStore } from 'handrail-agent-sdk/server/assistance/postgres';
import { createNotificationDelivery } from 'handrail-agent-sdk/server/assistance/notifications';
import { canonicalFeedbackReady, createHandrailFeedbackObserver, createHandrailFeedbackEffectAdapter,
  handrailFeedbackOperations as ops } from 'handrail-agent-sdk/server/handrail-feedback';
import { migrations } from './helpers/migrations.mjs';
import { services, identity } from './helpers/agent-fixture.mjs';

const scope = identity.host;
const at = { localDate: '2027-01-02', localTime: '09:00', timeZone: 'America/Chicago' };
const schedule = { kind: 'schedule', at, contentRef: 'private-content:one' };
const watch = { kind: 'watch', adapterRef: 'observations', subjectRef: 'flight:fixture-date-airports',
  contentRef: 'private-content:flight', pollMs: 1000, maxAgeMs: 5000, expiresAt: Date.parse('2027-01-03T00:00Z') };
const key = id => ({ scope, id });
async function setup(t) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const db = await harness.client();
  await db.query(assistancePostgresSchema(harness.schema));
  let now = Date.parse('2027-01-01T00:00Z'), denied = false, observation;
  const host = { now: () => now, withAuthority: async (k, _op, run) => {
    if (denied || !isDeepStrictEqual(k.scope, scope)) throw Error('not_authorized'); return run();
  } };
  const options = { host, batchSize: 2, readTimeoutMs: 100,
    adapters: { observations: { read: async (_key, spec) => observation ?? {
      subjectRef: spec.subjectRef, status: 'pending', observedAt: now, evidenceRef: 'provider:initial' } } } };
  const store = createPostgresAssistanceStore(db, harness.schema);
  const sdk = createAssistance({ ...options, store });
  return { db, harness, host, store, sdk, options, time: n => { now=n; }, deny: b => { denied=b; },
    observe: o => { observation=o; }, now: () => now,
    reconstruct: async () => createAssistance({ ...options, store: createPostgresAssistanceStore(await harness.client(), harness.schema) }) };
}
test('wall clock: gaps, folds, quarter-hour zones and no arbitrary one-year horizon', () => {
  const now = Date.parse('2026-01-01T00:00Z');
  assert.throws(() => resolveScheduleTime({ ...at, localDate: '2026-03-08', localTime: '02:30' }, now), /nonexistent/);
  assert.throws(() => resolveScheduleTime({ ...at, localDate: '2026-11-01', localTime: '01:30' }, now), /ambiguous/);
  const fold = { ...at, localDate: '2026-11-01', localTime: '01:30' };
  assert.equal(resolveScheduleTime({ ...fold, utcOffset: '-06:00' }, now) - resolveScheduleTime({ ...fold, utcOffset: '-05:00' }, now), 3600000);
  assert.equal(resolveScheduleTime({ ...at, localDate: '2036-01-01', timeZone: 'Asia/Kathmandu' }, now), Date.parse('2036-01-01T03:15Z'));
  assert.throws(() => resolveScheduleTime({ ...at, localDate: '2027-02-30' }, now), /invalid/);
  assert.equal(assistanceClock(Date.parse('2026-12-31T23:00Z'), 'Asia/Kathmandu').tomorrow, '2027-01-02');
});
test('durable schedule, duplicate creation, immutable binding, concurrent delivery and reconstruction', async t => {
  const s = await setup(t), k=key('reminder');
  const first = await s.sdk.create(k, 'create-one', schedule);
  const other = await s.reconstruct();
  assert.deepEqual(await other.create(k, 'create-one', schedule), first);
  await assert.rejects(other.create(k, 'create-one', { ...schedule, contentRef:'changed' }));
  s.time(first.nextAt + 10000);
  await Promise.all([s.sdk.tick(), other.tick()]);
  assert.equal((await other.get(k)).state, 'completed');
  assert.equal((await other.facts(scope)).length, 1);
  assert.equal((await other.facts(scope))[0].kind, 'due');
  assert.equal((await other.facts(scope, (await other.facts(scope))[0].factId)).length, 0);
});
test('reschedule retries keep receipt and cancel serializes with delivery; scope/current identity checks', async t => {
  const s = await setup(t), k=key('edited');
  const first = await s.sdk.create(k, 'create', schedule);
  const later = { ...at, localDate: '2027-01-04' };
  const edited = await s.sdk.reschedule(k, 'edit', 1, later);
  assert.deepEqual(await s.sdk.reschedule(k, 'edit', 1, later), edited);
  s.time(first.nextAt); await s.sdk.tick(); assert.equal((await s.sdk.facts(scope)).length, 0);
  await s.sdk.cancel(k, 'cancel', edited.revision); s.time(edited.nextAt); await s.sdk.tick();
  assert.equal((await s.sdk.get(k)).state, 'cancelled'); assert.equal((await s.sdk.facts(scope)).length, 0);
  await assert.rejects(s.sdk.get({ ...k, scope: { ...scope, userRef: 'intruder' } }), /not_authorized/);
  s.deny(true); await assert.rejects(s.sdk.create(k, 'create', schedule), /not_authorized/);
});
test('watch landing fixtures: delayed and stale never imply arrival; one durable match after restart', async t => {
  const s = await setup(t), k=key('flight-watch');
  await s.sdk.create(k, 'create', watch);
  s.observe({ subjectRef: watch.subjectRef, status: 'delayed', observedAt: s.now(), evidenceRef: 'flight:delayed' });
  await s.sdk.tick(); s.time(s.now()+1000); await s.sdk.tick();
  assert.equal((await s.sdk.facts(scope)).length, 1);
  s.time(s.now()+6000);
  s.observe({ subjectRef: watch.subjectRef, status: 'matched', observedAt: s.now()-6000, evidenceRef: 'flight:stale-landing' });
  await s.sdk.tick(); assert.equal((await s.sdk.get(k)).state, 'active');
  const next = await s.reconstruct(); s.time(s.now()+1000);
  s.observe({ subjectRef: watch.subjectRef, status: 'matched', observedAt: s.now(), evidenceRef: 'flight:actual-landing' });
  await Promise.all([s.sdk.tick(),next.tick()]);
  assert.equal((await next.get(k)).state, 'completed');
  assert.equal((await next.facts(scope, null, 20)).filter(f=>f.kind==='matched').length, 1);
});
test('cancelled flight, wrong occurrence, future and reordered observations cannot notify arrival', async t => {
  const s=await setup(t), k=key('cancelled-flight'); await s.sdk.create(k,'create',watch);
  s.observe({subjectRef:'wrong-flight',status:'matched',observedAt:s.now(),evidenceRef:'bad'});
  await s.sdk.tick(); assert.equal((await s.sdk.get(k)).state,'active');
  s.time(s.now()+1000); s.observe({subjectRef:watch.subjectRef,status:'matched',observedAt:s.now()+1,evidenceRef:'future'});
  await s.sdk.tick(); assert.equal((await s.sdk.get(k)).state,'active');
  s.time(s.now()+1000); s.observe({subjectRef:watch.subjectRef,status:'cancelled',observedAt:s.now(),evidenceRef:'flight:cancelled'});
  await s.sdk.tick(); assert.equal((await s.sdk.get(k)).state,'cancelled');
  assert.equal((await s.sdk.facts(scope,null,20)).filter(f=>f.kind==='matched').length,0);
});
test('materially different consumer: industrial pump inspection watch uses the same lifecycle and adapter', async t => {
  const s=await setup(t), k=key('pump-inspection');
  const sensor={...watch,subjectRef:'factory:pump-7-inspection-2027',contentRef:'maintenance:work-order'};
  const adapter={read:async (_key,spec)=>({subjectRef:spec.subjectRef,status:'matched',observedAt:s.now(),evidenceRef:'sensor:pressure-safe'})};
  const service=createAssistance({...s.options,store:s.store,adapters:{observations:adapter}});
  await service.create(k,'create',sensor); await service.tick();
  assert.equal((await service.get(k)).state,'completed');
  assert.equal((await service.facts(scope))[0].evidenceRef,'sensor:pressure-safe');
});
test('batch size bounds work, not user capability; fair catch-up and expiration', async t => {
  const s=await setup(t);
  for(let i=0;i<4;i++) await s.sdk.create(key(`watch-${i}`),'create',watch);
  s.time(watch.expiresAt+1); await s.sdk.tick(); await s.sdk.tick();
  assert.equal((await s.sdk.facts(scope,null,20)).length,4);
  assert.ok((await s.sdk.facts(scope,null,20)).every(f=>f.kind==='expired'));
});
test('notification delivery reuses effect ledger: concurrent retry, reconstruction and uncertain remote result', async t => {
  const s=await setup(t); await migrations(t,s.harness,s.db);
  await s.db.query(`CREATE TABLE ${s.harness.table('synthetic_provider')}(id text PRIMARY KEY, receipt text NOT NULL, attempts integer NOT NULL DEFAULT 1)`);
  const secret=randomBytes(32).toString('hex');
  const p=await services(s.harness.schema,secret); t.after(()=>p.close());
  const admitted=await p.admission.admit({namespaceRef:'fixture',grantRevision:1,operation:{operationRef:'notify',inputRefs:{}},
    event:{kind:'submitted',previousRevision:0,snapshot:{identity,revision:1,state:'queued',effects:[]}}}); assert.equal(admitted.ok,true);
  const binding={identity,actionRef:'notify',providerRef:'fixture-provider'};
  const options={effects:p.effects,lease:p.lease,journal:p.journal,leaseTtlMs:1200,admit:async()=>binding};
  const delivery=createNotificationDelivery(options), fact={...key('notice'),factId:'notice:fixture',kind:'due',contentRef:'content',evidenceRef:'schedule:1',createdAt:1};
  p.state.uncertain=true;
  { const r=await delivery.deliver(fact,'device-one');assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.outcome,'unknown'); }
  { const r=await delivery.deliver(fact,'device-one');assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.outcome,'unknown'); }
  assert.equal((await s.db.query(`SELECT * FROM ${s.harness.table('synthetic_provider')}`)).rows.length,0);
  p.state.uncertain=false;
  assert.equal((await delivery.deliver(fact,'device-one')).value.outcome,'verified');
  const rebuilt=await services(s.harness.schema,secret);t.after(()=>rebuilt.close());
  const next=createNotificationDelivery({...options,effects:rebuilt.effects,lease:rebuilt.lease});
  await Promise.all([delivery.deliver(fact,'device-one'),next.deliver(fact,'device-one')]);
  assert.equal((await s.db.query(`SELECT sum(attempts)::int AS n FROM ${s.harness.table('synthetic_provider')}`)).rows[0].n,1);
  rebuilt.state.denied=true; assert.equal((await next.deliver(fact,'device-one')).ok,false);
});
const canonical={kind:'enhancement',id:'canonical-enhancement'};
function readyRecord() { return { id:canonical.id, status:'succeeded', status_group:'succeeded',
  delivery_journey:{contract_version:2,verification_status:'passed',verification_environment:'staging',verified_environment:'staging',released_environment:'staging'},
  release_tracking:{environments:[{environment:'staging',deployment_state:'fully_deployed',targets:[{contains_change:true}]}]} }; }
test('canonical readiness requires verified matching environment and target containment, not worker success',()=>{
  const r=readyRecord(); assert.equal(canonicalFeedbackReady(canonical,r,null,'staging'),true);
  assert.equal(canonicalFeedbackReady(canonical,r,null,'production'),false);
  assert.equal(canonicalFeedbackReady(canonical,{id:canonical.id,status:'succeeded'},null,'staging'),false);
  assert.equal(canonicalFeedbackReady(canonical,{...r,delivery_journey:{...r.delivery_journey,verification_status:'not_requested'}},null,'staging'),false);
  assert.equal(canonicalFeedbackReady(canonical,{...r,release_tracking:{environments:[{environment:'staging',deployment_state:'fully_deployed',targets:[]}]}},null,'staging'),false);
});
test('canonical feedback fixture status/questions/approvals wait and verified-ready notification survive reconstruction',async t=>{
  const s=await setup(t); let record={id:canonical.id,status:'waiting',status_group:'needs_attention'}, calls=[];
  const observer=createHandrailFeedbackObserver({environment:'staging',now:s.now,withClient:async(_key,run)=>run({call:async(name,args)=>{
    calls.push(name);
    if(name===ops.discover)return {contract_version:'v2',principal:{authenticated:true,source:'verified_known_user_discovery'},reporters:{enhancement:{ready:true}}};
    assert.equal(args.request_id,canonical.id);
    return name===ops.enhancement.lookup?{contract_version:'v1',request:record}:{contract_version:'v1',request_id:canonical.id,release_tracking:record.release_tracking};
  }})});
  const options={...s.options,store:s.store,adapters:{handrail:observer}};
  const service=createAssistance(options), k=key('feedback');
  await service.create(k,'create',{...watch,adapterRef:'handrail',subjectRef:`enhancement:${canonical.id}`});
  await service.tick(); assert.equal((await service.facts(scope))[0].kind,'needs_input');
  record={id:canonical.id,status:'succeeded'};s.time(s.now()+1000);await service.tick();assert.equal((await service.get(k)).state,'active');
  record=readyRecord();s.time(s.now()+1000);
  const rebuilt=createAssistance({...options,store:createPostgresAssistanceStore(await s.harness.client(),s.harness.schema)});
  await rebuilt.tick(); assert.equal((await rebuilt.get(k)).state,'completed');
  assert.equal((await rebuilt.facts(scope,null,20)).filter(f=>f.kind==='matched').length,1);
  assert.ok(calls.every(name=>!name.includes('developer')));
});
test('canonical submission adapter retains stable dedupe key and canonical ID; uncertainty never means retry',async()=>{
  let saved, sent=0, maySend=true;
  const request={identity,effectRef:'feedback:stable',idempotencyRef:'feedback:stable',providerRef:'handrail:fixture',actionRef:'submit',operationRef:'feedback',requestDigest:`sha256:${'a'.repeat(64)}`};
  const adapter=createHandrailFeedbackEffectAdapter({load:async()=>({key:key('submission'),kind:'bug',input:{title:'Fixture',description:'Controlled test'}}),
    receipt:async()=>saved,save:async(_r,receipt)=>{saved=receipt;},notApplied:async()=>maySend,
    withClient:async(_key,run)=>run({call:async(name,input)=>{
      if(name===ops.discover)return {contract_version:'v2',principal:{authenticated:true,source:'verified_known_user_discovery'},reporters:{bug:{ready:true}}};
      sent++;assert.equal(name,ops.bug.submit);assert.equal(input.event_id,request.idempotencyRef);return {bugId:'canonical-bug'};
    }})});
  maySend=false;assert.equal((await adapter.reconcile(request)).outcome,'unknown');assert.equal(sent,0);
  assert.equal((await adapter.dispatch(request,new AbortController().signal)).outcome,'verified');
  assert.deepEqual(saved.canonical,{kind:'bug',id:'canonical-bug'});
  assert.equal((await adapter.reconcile(request)).outcome,'verified');assert.equal(sent,1);
});

test('durable mandate revocation is terminal even when account access returns',async t=>{
  const s=await setup(t);let revoked=true;
  const service=createAssistance({...s.options,store:s.store,host:{...s.host,withAuthority:async(k,op,run)=>s.host.withAuthority(k,op,()=>run(op==='observe'?!revoked:true))}});
  await service.create(key('revoked'),'create',watch);await service.tick();
  assert.equal((await service.get(key('revoked'))).state,'revoked');
  revoked=false;s.observe({subjectRef:watch.subjectRef,status:'matched',observedAt:s.now(),evidenceRef:'landed'});
  await service.tick();assert.equal((await service.facts(scope)).length,0);
  assert.equal((await service.list(scope))[0].state,'revoked');
});

test('a crash/failure before transaction commit rolls back both lifecycle and inbox fact',async t=>{
  const s=await setup(t),k=key('atomic');const record=await s.sdk.create(k,'create',schedule);s.time(record.nextAt);
  const broken={...s.store,transaction:(key,run)=>s.store.transaction(key,tx=>run({...tx,notify:async fact=>{await tx.notify(fact);throw Error('synthetic process boundary failure');}}))};
  const service=createAssistance({...s.options,store:broken});
  assert.equal((await service.tick())[0].outcome,'unavailable');
  assert.equal((await s.sdk.get(k)).state,'active');assert.equal((await s.sdk.facts(scope)).length,0);
  await (await s.reconstruct()).tick();assert.equal((await s.sdk.get(k)).state,'completed');assert.equal((await s.sdk.facts(scope)).length,1);
});

test('shared worker coalesces wakeups, drains on shutdown and leaves durable intent intact',async t=>{
  const {createAssistanceWorker}=await import('handrail-agent-sdk/server/assistance');
  const s=await setup(t);await s.sdk.create(key('shutdown'),'create',watch);
  let release,entered,drains=0;const hold=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const worker=createAssistanceWorker({intervalMs:10000,assistance:{tick:async()=>{entered();await hold;await s.sdk.tick();}},notifications:{drain:async()=>{drains++;}}});
  worker.start();await started;const one=worker.wake(),two=worker.wake();assert.equal(one,two);
  let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  release();await stop;assert.equal(drains,1);assert.equal((await s.sdk.get(key('shutdown'))).state,'active');
});
