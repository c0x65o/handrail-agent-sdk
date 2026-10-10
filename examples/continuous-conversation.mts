// Run with Node 22: node --experimental-strip-types examples/continuous-conversation.mts ./approved-host.mjs
// The host module exports createPorts() and an admitted JobIdentity as identity.
// No environment credential lookup, provider client, Codex process or timer is created here.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import type { JobIdentity } from 'handrail-agent-sdk';
import { createJobAdmission, createJobLease, createEffects, createJobAnswer, createJobCancellation,
  type JobAdmissionHost, type JobAnswerHost, type JobCancellationHost } from 'handrail-agent-sdk/server';
import { createPostgresAgentStores, createPostgresConversationStorage, type AgentStateKeys } from 'handrail-agent-sdk/server/postgres';
import { createConversation, createConversationAgentRuntime, createDelegatedWorkAdapter,
  type ConversationAuthority, type ConversationScope } from 'handrail-agent-sdk/server/conversation';

type RuntimeOptions = Parameters<typeof createConversationAgentRuntime>[0];
type ExecutorOptions = Parameters<typeof createDelegatedWorkAdapter>[0];
export interface ContinuousHostPorts {
  pool: Pool; schema: string; keys: AgentStateKeys;
  model: RuntimeOptions['model']; definitionRef: string; instructions: string;
  tools: RuntimeOptions['tools']; limits: RuntimeOptions['limits'];
  approvals?: RuntimeOptions['approvals'];
  readConcurrency?: RuntimeOptions['readConcurrency'];
  // Explicit quotas for encrypted custody; model request and tool output limits
  // remain separate. Choose from the approved model and host storage budget.
  checkpointQuotaBytes: number; maxEntryBytes: number; maxContextBytes: number; pageSize: number;
  authority: ConversationAuthority;
  host: RuntimeOptions['host'] & JobAdmissionHost & JobAnswerHost & JobCancellationHost;
  effectHost: Parameters<typeof createEffects>[0];
  turn: (identity: JobIdentity) => Promise<{scope: ConversationScope; head: number}>;
  executor: ExecutorOptions['executor']; resolveWork: ExecutorOptions['resolve'];
}
export function composeContinuousHost(ports: ContinuousHostPorts) {
  const stores=createPostgresAgentStores({client:ports.pool,schema:ports.schema,keys:ports.keys,checkpointQuotaBytes:ports.checkpointQuotaBytes});
  const conversation=createConversation({storage:createPostgresConversationStorage({client:ports.pool,schema:ports.schema,keys:ports.keys,
    maxRecordBytes:ports.checkpointQuotaBytes}),authority:ports.authority,now:ports.host.now,
    maxEntryBytes:ports.maxEntryBytes,maxContextBytes:ports.maxContextBytes,pageSize:ports.pageSize});
  const delegated=createDelegatedWorkAdapter({conversation,resolve:ports.resolveWork,executor:ports.executor});
  const effects=createEffects(ports.effectHost,stores.effects,delegated);
  const lease=createJobLease(ports.host,stores.lease);
  const runtime=createConversationAgentRuntime({definitionRef:ports.definitionRef,instructions:ports.instructions,model:ports.model,
    tools:ports.tools,approvals:ports.approvals,readConcurrency:ports.readConcurrency,host:ports.host,turn:ports.turn,conversation,admission:stores.admission,journal:stores.journal,
    lease,effects,states:stores.states,limits:ports.limits});
  return {conversation,runtime,admission:createJobAdmission(ports.host,stores.admission),
    answer:createJobAnswer(ports.host,stores.answer),cancel:createJobCancellation(ports.host,stores.cancellation)};
}

// Apply migrateAgentPostgres in the existing approved migration command first.
// On ingress: authenticate; conversation.append(scope,{id:turnId,items,sourceRefs});
// persist that head in the host's existing turn binding; admission.submit(originalSubmission).
// Stream host.textDelta into the existing authenticated writer. Recover final
// output with the existing application transport/checkpoint reader. Wire executor
// callbacks to conversation.work.observe using their ORIGINAL binding and native
// monotonic revision. Route schedules and notification work through the existing
// assistance APIs, as shown in postgres-application.mts.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) console.log('Supply an approved host module exporting createPorts() and identity. No provider was called.');
  else {
    const host = await import(pathToFileURL(resolve(process.argv[2])).href) as {
      createPorts(): Promise<ContinuousHostPorts>; identity: JobIdentity;
    };
    const ports=await host.createPorts(), app=composeContinuousHost(ports);
    try { console.log(JSON.stringify(await app.runtime.wake(host.identity))); }
    finally { await app.runtime.stop(); await ports.pool.end(); }
  }
}
