// Complete installed server composition. All remaining ports are application
// identity, authorization, domain execution, canonical history and secret custody.
// No keys, models, pools, migrations, services or network calls start on import.
import type { Pool } from 'pg';
import type { ChatRequest, StreamEvent, AuthoritativeAttribution,
  ConversationTransportCapabilities, StartTurnInput } from '@handrail/ai-assistant';
import type { JobIdentity } from 'handrail-agent-sdk';
import { createPostgresAgentStores, createPostgresAssistanceDatabase, migrateAgentPostgres,
  type AgentStateKeys } from 'handrail-agent-sdk/server/postgres';
import { createJobAdmission, createJobLease, createEffects, createJobCancellation, createJobAnswer,
  type JobAdmissionHost, type JobLeaseHost, type JobCancellationHost, type JobAnswerHost } from 'handrail-agent-sdk/server';
import { createAgentRuntime, type AgentRuntimeHost } from 'handrail-agent-sdk/server/agents';
import { createApplicationAgentTools, type ApplicationAgentTools } from 'handrail-agent-sdk/server/application-tools';
import { createAgentCheckpointReader, createAgentConversationTransport,
  type AgentConversationBinding } from 'handrail-agent-sdk/server/application';
import { createAssistance } from 'handrail-agent-sdk/server/assistance';
import { assistancePostgresSchema, createPostgresAssistanceStore } from 'handrail-agent-sdk/server/assistance/postgres';
import { createNotificationDelivery } from 'handrail-agent-sdk/server/assistance/notifications';

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type AssistanceOptions = Parameters<typeof createAssistance>[0];
type NotificationOptions = Parameters<typeof createNotificationDelivery>[0];
type Admission = ReturnType<typeof createJobAdmission>;

// Only invoke from the application's approved migration command, before workers.
export async function migrate(pool: Pool, schema: string) {
  await migrateAgentPostgres(pool, schema);
  await pool.query(assistancePostgresSchema(schema));
}

export function composeApplication(ports: {
  pool: Pool; schema: string; keys: AgentStateKeys;
  // E.g. await new OpenAIProvider({openAIClient: approvedClient,useResponses:true})
  // .getModel(configuredModel). Host retains client lifecycle, metering and model.
  model: RuntimeOptions['model']; sampling?: RuntimeOptions['sampling'];
  definitionRef: string; instructions: string; limits: RuntimeOptions['limits'];
  host: AgentRuntimeHost & JobAdmissionHost & JobLeaseHost & JobCancellationHost & JobAnswerHost;
  effectHost: Parameters<typeof createEffects>[0];
  effects: Parameters<typeof createEffects>[2]; tools: ApplicationAgentTools;
  turns: {
    // Existing canonical turn/input table: derive JobSubmission from this saved
    // turn and use admission.submit. Persist returned jobId with the immutable
    // turn; a retry of that submission returns the same job. Never trust IDs/ACLs
    // from ChatRequest. Recover any interrupted binding write by re-submitting.
    admit(input: StartTurnInput<ChatRequest>, admission: Admission): Promise<AgentConversationBinding>;
    lookup(input: {conversationId: string; turnId: string}): Promise<AgentConversationBinding>;
    attribution(binding: AgentConversationBinding): Promise<AuthoritativeAttribution>;
    pendingToolCallIds(binding: AgentConversationBinding, requirementRef: string): Promise<readonly string[]>;
    // Fresh authenticated actor, including on every Stop request.
    actor(binding: AgentConversationBinding): Promise<string>;
  };
  capabilities: Omit<ConversationTransportCapabilities, 'authoritativeCancellation'>;
  assistance: Omit<AssistanceOptions, 'store'>;
  notifications: {
    // Resolve currently authorized recipient/channel/mandate in domain storage;
    // use admission.submit for a dedicated immutable notification job.
    admit: (admission: Admission, ...args: Parameters<NotificationOptions['admit']>) => ReturnType<NotificationOptions['admit']>;
    pending?: NotificationOptions['pending'];
  };
  observe?: RuntimeOptions['observe'];
}) {
  const stores = createPostgresAgentStores({client: ports.pool, schema: ports.schema, keys: ports.keys});
  const admission = createJobAdmission(ports.host, stores.admission);
  const lease = createJobLease(ports.host, stores.lease);
  const effects = createEffects(ports.effectHost, stores.effects, ports.effects, 10_000);
  const cancel = createJobCancellation(ports.host, stores.cancellation);
  const answer = createJobAnswer(ports.host, stores.answer);
  const runtime = createAgentRuntime({definitionRef: ports.definitionRef, instructions: ports.instructions,
    model: ports.model, sampling: ports.sampling, tools: createApplicationAgentTools(ports.tools),
    host: ports.host, admission: stores.admission, journal: stores.journal, lease, effects,
    states: stores.states, limits: ports.limits, observe: ports.observe});
  const read = createAgentCheckpointReader({runtime, attribution: ports.turns.attribution,
    pendingToolCallIds: ports.turns.pendingToolCallIds});
  const transport = createAgentConversationTransport<StreamEvent, ChatRequest>({runtime,
    capabilities: ports.capabilities, pollMs: ports.limits.pollMs,
    host: {admit: input => ports.turns.admit(input, admission), lookup: ports.turns.lookup, read,
      async cancel(binding) {
        const actor = await ports.turns.actor(binding);
        const inspected = await runtime.inspect(binding.identity);
        if (!inspected.ok) throw Error('turn_unavailable');
        if (['succeeded','failed','cancelled'].includes(inspected.value.snapshot.state)) return 'already_terminal';
        const result = await cancel.stop({command:'cancel',identity:binding.identity,
          expectedRevision:inspected.value.snapshot.revision,reason:'explicit_stop'},actor);
        if (!result.ok) throw Error('stop_unavailable');
        return 'cancellation_requested';
      }}});
  const assistance = createAssistance({...ports.assistance,
    store:createPostgresAssistanceStore(createPostgresAssistanceDatabase(ports.pool), ports.schema)});
  const notifications = createNotificationDelivery({effects, lease, journal:stores.journal,
    leaseTtlMs:ports.limits.leaseTtlMs, pending:ports.notifications.pending,
    admit:(...args)=>ports.notifications.admit(admission,...args)});
  return {admission, runtime, transport, answer, cancel, assistance, notifications,
    // Call only after answer.issue/complete through the existing native approval
    // endpoint. host.resolveWait verifies snapshot.answer against current domain
    // approval; a receipt string supplied by a client never authorizes a resume.
    async resumeAnswered(identity: JobIdentity) {
      const result=await runtime.resume(identity);
      if (!result.ok) return result;
      return runtime.wake(identity);
    },
    // Process shutdown is not user Stop. Pool/provider are still host-owned.
    close:()=>runtime.stop()};
}

// Mount transport as provider.createTransport behind the existing gateway's
// auth/CSRF/size/rate-limit controls and durable turn writer. Start runtime.start()
// in the existing server/worker role; scheduler invokes assistance.tick() then
// notifications.drain(). Closing a UI observation never sends durable Stop.
