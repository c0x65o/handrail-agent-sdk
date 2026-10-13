import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTrackedAgentModel, projectAgentProviderUsage, createHostedTurnUsageReceipt,
  createAIRuntimeUsageClient, createAIRuntimeUsageReceiptSink } from 'handrail-agent-sdk/server/usage';

const attribution = Object.fromEntries(['organization', 'project', 'service_environment', 'known_user', 'session', 'automation']
  .map(name => [name, { id: name, source: 'server_derived', trust: 'authoritative' }]));
const scope = { conversationId: 'conversation', turnId: 'turn', logicalRequestId: 'logical', traceId: 'trace',
  providerId: 'openai', modelId: 'configured-model', attribution };
const rawUsage = { input_tokens: 15, output_tokens: 5, total_tokens: 20,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } };
const response = { responseId: 'provider-response', usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
  rawUsage, output: [] };
const request = () => ({ input: 'private input', modelSettings: {}, signal: new AbortController().signal });
function fixture(overrides = {}) {
  const receipts = [], calls = [];
  const model = {
    async getResponse(input) { calls.push(input); return structuredClone(response); },
    async *getStreamedResponse(input) {
      calls.push(input);
      yield { type: 'output_text_delta', delta: 'private output' };
      yield { type: 'response_done', response: { ...structuredClone(response), id: response.responseId } };
    }, ...overrides,
  };
  const options = { model, scope, settlementOwner: 'application', sink: { async capture(value) { receipts.push(value); } } };
  return { model, options, receipts, calls, tracked: createUsageTrackedAgentModel(options) };
}

test('captures raw per-invocation usage before exposing ordinary and streamed completion', async () => {
  const f = fixture();
  await f.tracked.getResponse(request());
  assert.equal(f.receipts.length, 1);
  assert.equal(f.calls[0].modelSettings.preserveRawUsage, true);
  assert.deepEqual(f.receipts[0].tokens.cached_input_tokens, { status: 'reported', value: 0 });
  assert.deepEqual(f.receipts[0].tokens.reasoning_tokens, { status: 'reported', value: 2 });
  for await (const event of f.tracked.getStreamedResponse(request())) {
    if (event.type === 'response_done') assert.equal(f.receipts.length, 2);
  }
  // A replay of the same provider response in the same scope has one receipt ID.
  assert.equal(f.receipts[0].usage_receipt_id, f.receipts[1].usage_receipt_id);
  assert.notEqual(f.receipts[0].attempt.id, f.receipts[1].attempt.id);
  assert.doesNotMatch(JSON.stringify(f.receipts), /private input|private output|rawUsage|providerData/);
});

test('missing provider usage stays unavailable even if Runner exposes synthesized zeros', async () => {
  const f = fixture({ async getResponse() { return { output: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }; } });
  await f.tracked.getResponse(request());
  for (const value of Object.values(f.receipts[0].tokens)) assert.deepEqual(value, { status: 'unavailable' });
  assert.deepEqual(projectAgentProviderUsage({ input_tokens: -1, total_tokens: NaN }).input_tokens, { status: 'unavailable' });
});

test('provider failure, cancellation and truncated streams emit unmeasured terminal receipts', async () => {
  const f = fixture({ async getResponse() { throw Error('private failure'); },
    async *getStreamedResponse() { yield { type: 'output_text_delta', delta: 'partial' }; } });
  await assert.rejects(f.tracked.getResponse(request()), /private failure/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tracked.getResponse({ ...request(), signal: controller.signal }));
  for await (const _event of f.tracked.getStreamedResponse(request())) { /* consume */ }
  assert.deepEqual(f.receipts.map(r => r.terminal_status), ['failed', 'cancelled', 'failed']);
  assert.equal(new Set(f.receipts.map(r => r.usage_receipt_id)).size, 3);
});

test('persistence failure does not expose completion, replay provider IO or substitute another receipt', async () => {
  const f = fixture(); let attempts = 0;
  const tracked = createUsageTrackedAgentModel({ ...f.options, sink: { async capture() { attempts++; throw Error('storage unavailable'); } } });
  await assert.rejects(tracked.getResponse(request()), /storage unavailable/);
  assert.equal(attempts, 1); assert.equal(f.calls.length, 1);
});

test('Handrail-owned settlement returns the model unchanged and captures nothing', async () => {
  const f = fixture();
  const tracked = createUsageTrackedAgentModel({ ...f.options, settlementOwner: 'handrail' });
  assert.equal(tracked, f.model); await tracked.getResponse(request());
  assert.equal(f.receipts.length, 0);
});

test('scope is fixed at construction and distinct turns cannot collide', async () => {
  const f = fixture(); const supplied = structuredClone(scope);
  const tracked = createUsageTrackedAgentModel({ ...f.options, scope: supplied });
  supplied.turnId = 'later-turn'; supplied.attribution.known_user.id = 'later-user';
  await tracked.getResponse(request());
  await createUsageTrackedAgentModel({ ...f.options, scope: supplied }).getResponse(request());
  assert.equal(f.receipts[0].turn_id, 'turn');
  assert.equal(f.receipts[0].attribution.known_user.id, 'known_user');
  assert.notEqual(f.receipts[0].usage_receipt_id, f.receipts[1].usage_receipt_id);
});

test('delivery can restart after an uncertain gateway response and retries the same receipt', async () => {
  const entries = new Map(), accepted = new Set(), sent = [];
  const outbox = {
    async enqueue(entry) { if (!entries.has(entry.receipt.usage_receipt_id)) entries.set(entry.receipt.usage_receipt_id, entry); },
    async pending() { return [...entries.values()]; },
    async acknowledge(id) { entries.delete(id); }, async failed() {},
  };
  let loseResponse = true;
  const client = createAIRuntimeUsageClient({ apiUrl: 'https://telemetry.example', token: 'private-token',
    serviceEnvId: 'service_environment', retryLimit: 0, async fetch(url, init) {
      assert.equal(url, 'https://telemetry.example/api/ai-usage/v1/receipts');
      const body = JSON.parse(init.body); sent.push(body);
      const id = body.receipts[0].usage_receipt_id; accepted.add(id);
      if (loseResponse) throw Error('lost acknowledgement');
      return Response.json({ duplicate_count: 1, accepted_count: 0 });
    } });
  const f = fixture();
  const first = createAIRuntimeUsageReceiptSink(client, outbox);
  await createUsageTrackedAgentModel({ ...f.options, sink: first }).getResponse(request());
  await first.flush(); assert.equal(entries.size, 1);
  loseResponse = false;
  const restarted = createAIRuntimeUsageReceiptSink(client, outbox);
  await restarted.flush(); assert.equal(entries.size, 0); assert.equal(accepted.size, 1);
  assert.deepEqual(sent[0], sent.at(-1)); assert.equal(f.calls.length, 1);
});

test('hosted turn usage has stable recovery identity and preserves provider quantities',()=>{
 const turn={id:'remote-turn',session_id:'remote-session',subagent_id:null,status:'completed',completed_at:1800000000,usage:rawUsage};
 const receipt=createHostedTurnUsageReceipt({turn,sessionId:'remote-session',scope});
 assert.deepEqual(createHostedTurnUsageReceipt({turn:structuredClone(turn),sessionId:'remote-session',scope}),receipt);
 assert.deepEqual(receipt.tokens.total_tokens,{status:'reported',value:20});
 assert.deepEqual(receipt.tokens.cached_input_tokens,{status:'reported',value:0});
 assert.deepEqual(createHostedTurnUsageReceipt({turn:{...turn,usage:null},sessionId:'remote-session',scope}).tokens.total_tokens,{status:'unavailable'});
 assert.throws(()=>createHostedTurnUsageReceipt({turn,sessionId:'other-session',scope}),/TURN_INVALID/);
 assert.throws(()=>createHostedTurnUsageReceipt({turn:{...turn,status:'waiting'},sessionId:'remote-session',scope}),/TURN_INVALID/);
});
