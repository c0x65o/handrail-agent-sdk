import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretKey, randomBytes } from 'node:crypto';
import { createManagedAgentCapabilities, readManagedInputDiagnostics } from 'handrail-agent-sdk/server/capabilities';
import { createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { createPostgresHarness, migrations } from './fixtures/installed/database.mjs';
import { services, identity } from './fixtures/installed/host.mjs';
import { managedStore } from '../dist/server/managed/store.js';
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
const origin = 'https://app.example.com', baseUrl = `${origin}/agent-access`;
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
const privateLogin = {type:'browser_authentication',credential_origin:'https://project.example.com',reason:'Sign in',
  fields:[{id:'email',label:'Email',type:'email',required:true},{id:'pass',label:'Password',type:'password',required:true}],options:[]};
const externalSelection = {credentialRef:'project-vault-entry',revision:'revision-1',optionId:null,
  fields:[{fieldId:'email',source:'username'},{fieldId:'pass',source:'password'}]};
function authenticationModel(rejectLogin=false) {
  const requests=[];
  return {requests,async *getStreamedResponse(request) {
    requests.push(request);
    yield {type:'response_done',response:{output:!request.authCompleted||rejectLogin?
      [{type:'computer_use_approval_request',request_id:request.authCompleted?'login-rejected':'login-original',request:privateLogin}]:
      [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Dashboard loaded.'}]}],
    usage:{inputTokens:1,outputTokens:1,totalTokens:2}}};
  }};
}
function model(handoff) {
  const requests = [];
  return { requests, async getResponse() { throw Error('STREAM_EXPECTED'); }, async *getStreamedResponse(request) {
    requests.push(request);
    const input = typeof request.input === 'string' ? [] : request.input;
    const outputs = input.filter(i => i.type === 'function_call_result');
    const output = outputs.length === 0 ? { type: 'function_call', callId: 'connect', name: 'agent_connect_account',
      arguments: JSON.stringify({ label: 'Family member', url: 'https://airline.example.com/login' }) }
      : handoff && !request.authCompleted ? { type: 'computer_use_approval_request', request_id: 'hosted-auth', request: {
        type: 'browser_authentication', credential_origin: 'https://airline.example.com', reason: 'Complete verification',
        fields: [{ id: 'code', label: 'Verification code', type: 'password', required: true }], options: [] } }
      : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The login is saved.' }] };
    yield { type: 'response_started' };
    yield { type: 'response_done', response: { id: `response-${outputs.length}`, output: [output], usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
  } };
}
async function setup(t, flags = { vault: true, browser: false }, handoff = false, hooks = {}) {
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup()); await migrations(t, harness);
  const key = createSecretKey(randomBytes(32)), keys = { current: async () => ({ ref: 'test-key', key }), resolve: async () => key };
  let signedIn = true, scope = identity.host;
  const create = () => createManagedAgentCapabilities({ database: harness.pool, schema: harness.schema, keys, baseUrl, features: flags,
    authenticate: async () => signedIn ? scope : null,
    restoreRuntime: hooks.lazy ? async original => { assert.deepEqual(original,identity); capabilities.createRuntime(deps); } : undefined,
    onAnswered: hooks.onAnswered, onPrivateInput: hooks.onPrivateInput, credentialProvider: hooks.credentialProvider });
  let capabilities = create(), deps;
  t.after(() => capabilities.close());
  const provider = hooks.model || model(handoff);
  const s = await services(harness.schema, randomBytes(32).toString('hex'), { model: provider, host: hooks.host,
    runtimeFactory: options => { deps = options; return capabilities.createRuntime(options); } });
  t.after(() => s.close());
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1, operation: { operationRef: 'connect', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  const request = (url, options) => capabilities.handleRequest(new Request(url, options));
  return { ...s, harness, keys, provider, request, get capabilities() { return capabilities; },
    auth: (value, next = scope) => { signedIn = value; scope = next; },
    async restart() { await capabilities.close(); capabilities = create();
      if(hooks.lazy)return;
      capabilities.createRuntime({ ...deps, host: { ...deps.host, authorize: async () => { throw Error('OTHER_USER'); } } });
      s.runtime = capabilities.createRuntime(deps); return s.runtime; },
  };
}
async function start(s) {
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  const state = ok(await s.states.load(identity, s.authority()));
  const result = JSON.parse(Object.values(state.results)[0].output);
  const page = await s.request(result.secureUrl);
  assert.equal(page.status, 200);
  const html = await page.text(), csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(csrf); return { ...result, csrf, html, page };
}
function submit(s, entry, password, override = {}) {
  return s.request(entry.secureUrl, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...override.headers },
    body: new URLSearchParams({ csrf: entry.csrf, username: 'private-user', password, consent: 'yes', origins: '', ...override.form }) });
}
async function settled(s) {
  for (let n = 0; n < 100; n++) {
    const state = ok(await s.journal.load(identity)); if (state.state === 'succeeded') return state;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('original task did not resume');
}

async function currentPrivateForm(s) {
  const job=ok(await s.journal.load(identity));assert.equal(job.state,'waiting');
  const secureUrl=`${baseUrl}/${job.requirement.requirementRef.slice(8)}`;
  const response=await s.request(secureUrl);assert.equal(response.status,200);
  const html=await response.text(),csrf=/name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(csrf);
  return {secureUrl,csrf,html};
}
function privateSubmit(s,entry,form) {
  return s.request(entry.secureUrl,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf:entry.csrf,...form})});
}
const diagnostics=s=>readManagedInputDiagnostics({database:s.harness.pool,schema:s.harness.schema,keys:s.keys,identity});

test('wrong password, corrected password, 2FA, expired code and replacement code stay in one original task',async t=>{
  const observed=[],submitted=[],secrets=Array.from({length:5},()=>randomBytes(18).toString('hex'));
  const requests=[],challenges=[privateLogin,{...privateLogin,reason:'Incorrect password. Try again.'},
    {...privateLogin,reason:'Enter the verification code',fields:[{id:'otp',label:'Verification code',type:'text',required:true}]},
    {...privateLogin,reason:'The code expired. Enter a new code',fields:[{id:'fresh-code',label:'New verification code',type:'text',required:true}]}];
  const model={requests,async *getStreamedResponse(r){requests.push(r);yield {type:'response_done',response:{output:r.authStepCount<challenges.length?
    [{type:'computer_use_approval_request',request_id:`step-${r.authStepCount}`,request:challenges[r.authStepCount]}]:
    [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Dashboard loaded.'}]}],usage:{inputTokens:1,outputTokens:1,totalTokens:2}}};}};
  const s=await setup(t,{vault:true,browser:true},false,{model,onAnswered:async()=>{},onPrivateInput:e=>observed.push(e),
    host:{beforeBrowserAnswer:async event=>submitted.push(structuredClone(event))}});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  let first;
  for(let n=0;n<challenges.length;n++) {
    const entry=await currentPrivateForm(s);first??=entry;
    if(n) {
      assert.match(entry.html,/another sign-in step/);
      const old=await s.request(first.secureUrl);assert.equal(old.status,303);
      assert.equal(new URL(old.headers.get('location'),origin).href,entry.secureUrl);
      const notices=ok(await s.states.load(identity,s.authority())).interactionNotices;
      assert.match(notices.at(-1),/another private sign-in step/);
    }
    const result=await privateSubmit(s,entry,{action:'submit',field_0:secrets[n],...(n<2?{field_1:secrets[4]}:{})});
    assert.equal(result.status,200);assert.match(await result.text(),/not a confirmed login/);
    const runtime=await s.restart();ok(await runtime.resume(identity));
    assert.equal(ok(await runtime.wake(identity)),n===3?'succeeded':'waiting');
  }
  assert.deepEqual(submitted.map(e=>e.request_id),['step-0','step-1','step-2','step-3']);
  assert.deepEqual(submitted[3].response.fields,[{field_id:'fresh-code',value:secrets[3]}]);
  const retained=await diagnostics(s);
  assert.equal(retained.events.filter(e=>e.kind==='response_saved').length,4);
  assert.equal(retained.events.filter(e=>e.kind==='provider_accepted').length,4);
  assert.equal(retained.events.filter(e=>e.kind==='follow_up_requested').length,3);
  assert.ok(retained.events.every(e=>e.jobId===identity.jobId));
  const checkpoint=ok(await s.states.load(identity,s.authority()));
  const rows=(await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  for(const secret of secrets)assert.equal(JSON.stringify([retained,observed,checkpoint,requests,rows]).includes(secret),false);
  assert.equal(JSON.stringify(retained).includes(new URL(first.secureUrl).pathname.split('/').at(-1)),false);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});

test('invalid fields stay pending; explicit cancellation has a distinct receipt and diagnostic decision',async t=>{
  const s=await setup(t,{vault:true,browser:true},false,{model:authenticationModel(),onAnswered:async()=>{},
    onPrivateInput:()=>{throw Error('telemetry outage with private text');}});
  ok(await s.runtime.wake(identity));const entry=await currentPrivateForm(s);
  const invalid=await privateSubmit(s,entry,{action:'submit',field_0:'private-incomplete'});
  assert.equal(invalid.status,422);assert.match(await invalid.text(),/not submitted/);
  assert.equal(ok(await s.journal.load(identity)).answer,undefined);
  const cancelled=await privateSubmit(s,entry,{action:'cancel'});assert.equal(cancelled.status,200);
  const html=await cancelled.text();assert.match(html,/cancellation or denial was saved/);assert.doesNotMatch(html,/http-equiv="refresh"/);
  const replay=await privateSubmit(s,entry,{action:'submit',field_0:'changed',field_1:'changed'});
  assert.match(await replay.text(),/cancellation or denial was saved/);
  const events=(await diagnostics(s)).events;
  assert.equal(events.filter(e=>e.kind==='response_saved').length,1);
  assert.equal(events.find(e=>e.kind==='response_saved').decision,'cancel');
  assert.ok(events.some(e=>e.kind==='form_invalid'));
});

test('uncertain private delivery recovers the identical request and never reports cancellation',async t=>{
  let disconnected=true;const submissions=[];
  const s=await setup(t,{vault:true,browser:true},false,{model:authenticationModel(),onAnswered:async()=>{},
    host:{beforeBrowserAnswer:async event=>{submissions.push(event);if(disconnected)throw Error('transport outage');}}});
  ok(await s.runtime.wake(identity));const entry=await currentPrivateForm(s);
  assert.equal((await privateSubmit(s,entry,{action:'submit',field_0:'user',field_1:'private-value'})).status,200);
  ok(await s.runtime.resume(identity));assert.equal(ok(await s.runtime.wake(identity)),'retryable');
  assert.ok((await diagnostics(s)).events.some(e=>e.kind==='provider_delivery_uncertain'));
  disconnected=false;const runtime=await s.restart();assert.equal(ok(await runtime.wake(identity)),'succeeded');
  assert.deepEqual(submissions[0],submissions[1]);
  assert.ok((await diagnostics(s)).events.some(e=>e.kind==='provider_accepted'));
  assert.equal((await diagnostics(s)).events.some(e=>e.decision==='cancel'),false);
});

test('updating an expired SDK account requires fresh private consent and retains its account identity',async t=>{
  const accountRef='11111111-1111-4111-8111-111111111111',requests=[];
  const model={requests,async *getStreamedResponse(r){requests.push(r);
    yield {type:'response_done',response:{output:r.input.some(i=>i.type==='function_call_result')?
      [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Account updated.'}]}]:
      [{type:'function_call',callId:'update-login',name:'agent_connect_account',arguments:JSON.stringify({accountRef,label:'Existing account',url:'https://example.com/login'})}],
      usage:{inputTokens:1,outputTokens:1,totalTokens:2}}};}};
  const s=await setup(t,undefined,false,{model}),store=managedStore(s.harness.pool,s.harness.schema,s.keys);
  const previous={label:'Existing account',url:'https://example.com/login',origins:['https://example.com'],
    username:'old-user',password:'old-password',approved:true,revoked:false,expiresAt:Date.now()-1};
  await store.put(identity.host,`account:${accountRef}`,previous,0);
  const entry=await start(s);assert.equal(entry.accountRef,accountRef);
  assert.equal((await submit(s,entry,'replacement-private-password',{form:{consent:'no'}})).status,403);
  assert.deepEqual((await store.get(identity.host,`account:${accountRef}`)).value,previous);
  assert.equal((await submit(s,entry,'replacement-private-password')).status,200);await settled(s);
  const accounts=await store.list(identity.host,'account:');assert.equal(accounts.length,1);
  assert.equal(accounts[0].id,`account:${accountRef}`);assert.equal(accounts[0].value.password,'replacement-private-password');
  assert.ok(accounts[0].value.expiresAt>Date.now());
  assert.equal(JSON.stringify([requests,await diagnostics(s)]).includes('replacement-private-password'),false);
  const other=await readManagedInputDiagnostics({database:s.harness.pool,schema:s.harness.schema,keys:s.keys,
    identity:{...identity,host:{...identity.host,userRef:'another-owner'}}});
  assert.deepEqual(other,{total:0,events:[]});
});

test('optional project credentials satisfy the original private request without exposing values or creating a saved SDK account',async t=>{
  const password=randomBytes(24).toString('hex'),username=randomBytes(16).toString('hex');let resolutions=0;
  const s=await setup(t,{vault:true,browser:true},false,{model:authenticationModel(),credentialProvider:{
    async select(input){assert.deepEqual(input.identity,identity);assert.equal(input.requestId,'login-original');return externalSelection;},
    async resolve(input,selected){assert.deepEqual(selected,externalSelection);resolutions++;return {username,password};},
  }});
  assert.equal(ok(await s.runtime.wake(identity)),'succeeded');assert.equal(resolutions,1);
  const state=ok(await s.states.load(identity,s.authority()));
  const records=(await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  const events=(await s.harness.pool.query(`SELECT * FROM ${s.harness.table('job_events')}`)).rows;
  for(const value of [username,password])assert.equal(JSON.stringify([records,state,events,s.provider.requests]).includes(value),false);
  const store=managedStore(s.harness.pool,s.harness.schema,s.keys);
  assert.deepEqual(await store.list(identity.host,'account:'),[]);
  const interaction=(await store.list(identity.host,'interaction:'))[0].value;
  assert.equal(interaction.response.request_id,'login-original');
  assert.deepEqual(interaction.response.response.fields,[{field_id:'email',value:username},{field_id:'pass',value:password}]);
});

for(const reason of ['no_match','revoked','vault_disabled'])test(`project credential ${reason} retains the authenticated private form`,async t=>{
  let selected=0,resolved=0;
  const s=await setup(t,{vault:reason!=='vault_disabled',browser:true},false,{model:authenticationModel(),credentialProvider:{
    async select(){selected++;return reason==='no_match'?null:externalSelection;},
    async resolve(){resolved++;return null;},
  }});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const state=ok(await s.states.load(identity,s.authority()));
  assert.ok(state.interactionNotices.some(n=>n.includes('Complete sign-in privately')));
  assert.equal(selected,reason==='vault_disabled'?0:1);assert.equal(resolved,reason==='revoked'?1:0);
  const recovered=await s.restart();
  ok(await recovered.resume(identity));assert.equal(ok(await recovered.wake(identity)),'waiting');
  assert.equal(selected,reason==='vault_disabled'?0:1,'recovery does not repeat account selection');
});

test('a rejected project login asks for private input instead of trying saved credentials repeatedly',async t=>{
  let attempts=0;
  const s=await setup(t,{vault:true,browser:true},false,{model:authenticationModel(true),credentialProvider:{
    async select(){attempts++;return externalSelection;},async resolve(){return {username:'fixture-user',password:'fixture-password'};},
  }});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');assert.equal(attempts,1);
  assert.ok(ok(await s.states.load(identity,s.authority())).interactionNotices.some(n=>n.includes('Complete sign-in privately')));
});

for(const revoke of ['provider','vault'])test(`recovery rechecks ${revoke} before delivering a saved external credential response`,async t=>{
  const flags={vault:true,browser:true};let resolutions=0,revoked=false;
  const s=await setup(t,flags,false,{model:authenticationModel(),
    host:{beforeBrowserAnswer:async()=>{if(!revoked)throw Error('fixture-private-transport-disconnected');}},credentialProvider:{
    async select(){return externalSelection;},async resolve(){resolutions++;return revoked?null:{username:'old-user',password:'old-password'};},
  }});
  assert.equal(ok(await s.runtime.wake(identity)),'retryable');
  // The transport failed after encrypted custody but before provider delivery.
  const store=managedStore(s.harness.pool,s.harness.schema,s.keys);
  const row=(await store.list(identity.host,'interaction:'))[0];
  assert.equal(row.value.completed,true);
  revoked=true;
  if(revoke==='vault')flags.vault=false;
  const runtime=await s.restart();
  assert.equal(ok(await runtime.wake(identity)),'waiting');
  assert.equal(resolutions,revoke==='vault'?1:2);
  assert.equal(s.provider.requests.some(r=>r.authCompleted),false,'no stale credentials reach the browser');
  const pending=(await store.get(identity.host,row.id)).value;
  assert.equal(pending.completed,false);assert.equal(pending.response,undefined);assert.equal(pending.credentialSelection,undefined);
  const page=await s.request(`${baseUrl}/${pending.ref}`);assert.equal(page.status,200);
  const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(await page.text())?.[1];assert.ok(csrf);
  assert.equal((await s.request(`${baseUrl}/${pending.ref}`,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,action:'submit',field_0:'replacement-user',field_1:'replacement-password'})})).status,200);
  await settled(s);
});
test('one SDK setup supplies form, encrypted custody, visible link, native answer and automatic same-job resume', async t => {
  const s = await setup(t), password = randomBytes(32).toString('hex'), entry = await start(s);
  assert.match(entry.html, /Save securely and continue/); assert.match(entry.page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const reader = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => ({}), pendingToolCallIds: async () => [] });
  const before = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, empty);
  assert.ok(before.events.some(e => e.type === 'response.text.delta' && e.delta.includes(entry.secureUrl)));
  assert.equal(before.result.status, 'waiting_for_approval');
  assert.deepEqual(before.result.pendingToolCallIds, [`managed:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`]);
  const response = await submit(s, entry, password); assert.equal(response.status, 200);
  await settled(s);
  const after = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, before.checkpoint);
  assert.equal(after.result.status, 'completed'); assert.ok(after.events.some(e => e.type === 'response.text.delta' && e.delta === 'The login is saved.'));
  const records = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  const checkpoint = ok(await s.states.load(identity, s.authority()));
  const events = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('job_events')}`)).rows;
  assert.equal(JSON.stringify([records, checkpoint, events, s.provider.requests]).includes(password), false);
  assert.equal(JSON.stringify([checkpoint, events, s.provider.requests]).includes('private-user'), false);
  const accounts = await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:');
  assert.equal(accounts.length, 1); assert.equal(accounts[0].value.password === password, true);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
});

test('authenticated conversation website answers preserve the original wait and refuse changed decisions and actors',async t=>{
  const provider={async *getStreamedResponse({authCompleted}){
    yield {type:'response_done',response:{output:authCompleted?
      [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Continued original task.'}]}]:
      [{type:'computer_use_approval_request',request_id:'website-original',request:{type:'browser_origin_access',origin:'https://example.com',reason:'Read the page'}}],
      usage:{inputTokens:1,outputTokens:1,totalTokens:2}}};
  }};
  const s=await setup(t,{vault:true,browser:true},false,{model:provider});
  assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const requirementRef=ok(await s.journal.load(identity)).requirement.requirementRef;
  const input={requirementRef,decision:'approve',sourceRef:'original-owner-reply'};
  ok(await s.runtime.resume(identity));assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  assert.deepEqual(await s.capabilities.readBrowserOriginAccess(identity,identity.host,requirementRef),
    {requirementRef,origin:'https://example.com',answered:false});
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,{...identity.host,userRef:'another-owner'},input),/AUTHORITY/);
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,identity.host,{...input,requirementRef:'managed:another'}),/WAIT_CHANGED/);
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,identity.host,{...input,decision:'guess'}),/DECISION/);
  const runtime=await s.restart();
  assert.equal((await s.capabilities.answerBrowserOriginAccess(identity,identity.host,input)).status,'saved');
  assert.equal(ok(await s.journal.load(identity)).state,'waiting','the host scheduler owns continuation');
  await s.capabilities.answerBrowserOriginAccess(identity,identity.host,input);
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,identity.host,{...input,decision:'deny'}),/CONFLICT/);
  ok(await runtime.resume(identity));assert.equal(ok(await runtime.wake(identity)),'succeeded');
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,identity.host,input),/WAIT_CHANGED/);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});

test('conversation website answers cannot complete a private credential form',async t=>{
  const s=await setup(t,{vault:true,browser:true});await start(s);
  ok(await s.runtime.resume(identity));assert.equal(ok(await s.runtime.wake(identity)),'waiting');
  const requirementRef=ok(await s.journal.load(identity)).requirement.requirementRef;
  await assert.rejects(s.capabilities.readBrowserOriginAccess(identity,identity.host,requirementRef),/AUTHORITY|WAIT_CHANGED/);
  await assert.rejects(s.capabilities.answerBrowserOriginAccess(identity,identity.host,{requirementRef,decision:'approve',sourceRef:'owner-reply'}),/AUTHORITY|WAIT_CHANGED/);
  assert.equal(ok(await s.journal.load(identity)).state,'waiting');
});
test('secure entry survives a service restart before the user submits it', async t => {
  const s = await setup(t), entry = await start(s);
  const runtime = await s.restart();
  assert.equal((await submit(s, entry, randomBytes(32).toString('hex'))).status, 200);
  await settled(s); await runtime.stop();
});
test('expired private form reopens after recovery without reviving stale submissions or replacing the task', async t => {
  const s = await setup(t), entry = await start(s);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  await s.restart();
  assert.equal((await submit(s, entry, 'test-only-password')).status, 409);
  s.auth(false);
  const anonymous = await s.request(entry.secureUrl);
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.headers.get('x-handrail-agent-input-error'), 'authentication');
  s.auth(true, { ...identity.host, userRef: 'another' });
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  assert.equal((await store.get(identity.host, key)).version, saved.version + 1);
  s.auth(true, identity.host);
  const page = await s.request(entry.secureUrl); assert.equal(page.status, 200);
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf); assert.notEqual(csrf, entry.csrf);
  assert.equal((await submit(s, entry, 'test-only-password')).status, 409);
  assert.equal(ok(await s.journal.load(identity)).state, 'waiting');
  assert.equal(s.provider.requests.length, 1, 'reopening does not execute work or grant approval');
  assert.equal((await submit(s, { ...entry, csrf }, 'test-only-password')).status, 200);
  await settled(s);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
});

for (const phase of ['issue', 'complete']) test(`saved approval recovers after failed answer ${phase}, expiry and restart`, async t => {
  const s = await setup(t), entry = await start(s);
  const table = s.harness.table(phase === 'issue' ? 'job_challenges' : 'job_events');
  const fn = `"${s.harness.schema}"."fail_answer_once"`;
  await s.harness.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic answer delivery outage'; END $$`);
  await s.harness.pool.query(`CREATE TRIGGER fail_answer BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  const failed = await submit(s, entry, 'test-only-password');
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get('x-handrail-agent-input-error'), /^answer_(issue|complete)_unavailable$/);
  await s.harness.pool.query(`DROP TRIGGER fail_answer ON ${table}`);
  await s.harness.pool.query(`DROP FUNCTION ${fn}()`);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  assert.equal(saved.value.completed, true, 'the original response was saved before the outage');
  assert.equal(ok(await s.journal.load(identity)).answer, undefined);
  const expired = Date.now() - 1;
  await store.put(identity.host, key, { ...saved.value, expiresAt: expired }, saved.version);
  await s.harness.pool.query(`UPDATE ${s.harness.table('job_challenges')} SET expires_at=$1`, [expired]);
  const runtime = await s.restart();
  s.state.denied = true;
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.state.denied = false;
  if (phase === 'issue') {
    // Original scheduler recovers the saved response without a second user click.
    ok(await runtime.resume(identity)); ok(await runtime.wake(identity));
  } else assert.equal((await s.request(entry.secureUrl)).status, 200);
  await settled(s);
  const deliveries = (await s.harness.pool.query(`SELECT * FROM ${s.harness.table('job_answer_deliveries')}`)).rows;
  assert.equal(deliveries.length, 1);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount, 1);
  assert.equal(s.provider.requests.length, 2);
});

test('expired form cannot renew after Stop or revoked native authority', async t => {
  const s = await setup(t), entry = await start(s);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(entry.secureUrl).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  s.state.denied = true;
  const revoked = await s.request(entry.secureUrl);
  assert.equal(revoked.status, 403);
  assert.equal(revoked.headers.get('x-handrail-agent-input-error'), 'job_authority');
  s.state.denied = false;
  const job = ok(await s.journal.load(identity));
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: job.revision, reason: 'explicit_stop' }, identity.host.userRef));
  assert.equal((await s.request(entry.secureUrl)).status, 403);
  assert.equal((await store.get(identity.host, key)).version, saved.version + 1);
});
test('portal rejects wrong user, unauthenticated links, cross-site posts, invalid CSRF and unapproved destinations', async t => {
  const s = await setup(t), entry = await start(s);
  s.auth(false); assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.auth(true, { ...identity.host, userRef: 'another' }); assert.equal((await s.request(entry.secureUrl)).status, 403);
  s.auth(true, identity.host);
  for (const change of [{ headers: { origin: 'https://attacker.example.com' } }, { form: { csrf: 'x'.repeat(64) } },
    { form: { consent: 'no' } }, { form: { origins: 'https://127.0.0.1' } }, { form: { origins: 'http://airline.example.com' } }])
    assert.equal((await submit(s, entry, 'test-only-password', change)).status, change.form?.csrf ? 409 : 403);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});
test('Stop prevents credential capture and a secure link cannot resume a cancelled task', async t => {
  const s = await setup(t), entry = await start(s), job = ok(await s.journal.load(identity));
  const reader = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => ({}), pendingToolCallIds: async () => [] });
  const before = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, empty);
  ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: job.revision, reason: 'explicit_stop' }, identity.host.userRef));
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  assert.equal(ok(await s.journal.load(identity)).state, 'cancelled');
  const after = await reader({ identity, turnId: 'turn', mutationId: 'mutation' }, before.checkpoint);
  assert.equal(after.result.status, 'cancelled');
  assert.ok(after.checkpoint.lastAppliedRevision >= before.checkpoint.lastAppliedRevision);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});
test('feature flags remove tools and disable the HTTP surface; construction has no database effects', async t => {
  const s = await setup(t, { vault: false, browser: false });
  assert.deepEqual(await s.capabilities.status(), { vault: 'disabled', browser: 'disabled' });
  assert.equal((await s.request(`${baseUrl}/${'a'.repeat(64)}`)).status, 404);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rowCount, 0);
});


test('revoked application authority prevents saving a previously issued credential form', async t => {
  const s = await setup(t), entry = await start(s);
  s.state.denied = true;
  assert.equal((await submit(s, entry, 'test-only-password')).status, 403);
  assert.equal((await managedStore(s.harness.pool, s.harness.schema, s.keys).list(identity.host, 'account:')).length, 0);
});

test('hosted private sign-in survives restart and completes the same original provider request', async t => {
  const s = await setup(t, { vault: true, browser: true }, true), entry = await start(s);
  assert.equal((await submit(s, entry, 'test-only-password')).status, 200);
  let link;
  for (let n = 0; n < 100; n++) {
    const state = ok(await s.states.load(identity, s.authority()));
    const notice = state.interactionNotices.find(n => n.includes('Complete sign-in privately'));
    link = notice && /\]\((https:[^)]+)\)/.exec(notice)?.[1];
    if (link && ok(await s.journal.load(identity)).state === 'waiting') break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(link);
  const store = managedStore(s.harness.pool, s.harness.schema, s.keys);
  const key = `interaction:${new URL(link).pathname.split('/').at(-1)}`;
  const saved = await store.get(identity.host, key);
  await store.put(identity.host, key, { ...saved.value, expiresAt: Date.now() - 1 }, saved.version);
  await s.restart();
  const page = await s.request(link); assert.equal(page.status, 200);
  const html=await page.text(), csrf=/name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(csrf);
  const code=randomBytes(16).toString('hex');
  assert.equal((await s.request(link, {method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,action:'submit',field_0:code})})).status,200);
  await settled(s);
  const checkpoint=ok(await s.states.load(identity,s.authority()));
  assert.equal(JSON.stringify([checkpoint,s.provider.requests]).includes(code),false);
  const stored=(await s.harness.pool.query(`SELECT * FROM ${s.harness.table('managed_capability_records')}`)).rows;
  assert.equal(JSON.stringify(stored).includes(code),false);
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});


test('private entry restores the original job lazily and hands its saved answer to the native scheduler', async t => {
  let notified = 0;
  const s = await setup(t, undefined, false, {lazy:true,onAnswered:async original=>{assert.deepEqual(original,identity);notified++;}});
  const entry = await start(s);
  await s.restart();
  s.auth(false);
  assert.equal((await s.request(entry.secureUrl)).status,403);
  s.auth(true);
  assert.equal((await s.request(entry.secureUrl)).status,200);
  assert.equal((await submit(s,entry,'synthetic-password')).status,200);
  assert.equal(notified,1);
  const waiting=ok(await s.journal.load(identity));
  assert.equal(waiting.state,'waiting');assert.ok(waiting.answer?.responseRef);
  assert.equal(s.provider.requests.length,1,'private form does not bypass the host scheduler');
  assert.equal((await s.harness.pool.query(`SELECT * FROM ${s.harness.table('jobs')}`)).rowCount,1);
});
