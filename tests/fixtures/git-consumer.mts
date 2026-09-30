import { validateJobSnapshot } from 'handrail-agent-sdk';
import type { JobIdentity } from 'handrail-agent-sdk';
import { createJobAdmission } from 'handrail-agent-sdk/server';
import { createAgentRuntime } from 'handrail-agent-sdk/server/agents';
import type { AgentRuntimeHost, AgentStateStore, AgentRuntimeTool } from 'handrail-agent-sdk/server/agents';
import { createAssistance, createAssistanceWorker, resolveScheduleTime } from 'handrail-agent-sdk/server/assistance';
import { createPostgresAssistanceStore, assistancePostgresSchema } from 'handrail-agent-sdk/server/assistance/postgres';
import { createNotificationDelivery } from 'handrail-agent-sdk/server/assistance/notifications';
import { createHandrailFeedbackObserver, createHandrailFeedbackEffectAdapter } from 'handrail-agent-sdk/server/handrail-feedback';
import { createAgentConversationTransport, createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { createApplicationAgentTools } from 'handrail-agent-sdk/server/application-tools';
import type { ConversationTransport, StreamEvent, ChatRequest } from '@handrail/ai-assistant';

type Options = Parameters<typeof createAgentRuntime>[0];
declare const options: Options;
declare const host: AgentRuntimeHost;
declare const states: AgentStateStore;
declare const identity: JobIdentity;
const tool: AgentRuntimeTool = {
  kind: 'read', name: 'lookup', description: 'Read authorized facts.',
  parameters: options.tools[0].parameters,
  execute: async (call, signal) => signal.aborted ? 'cancelled' : String(call.input.topic),
};
const runtime = createAgentRuntime({ ...options, host, states, tools: [tool] });
await runtime.wake(identity);
await runtime.stop();
validateJobSnapshot({});
const admission: typeof createJobAdmission = createJobAdmission;
declare const gatewayOptions: Parameters<typeof createAgentConversationTransport<StreamEvent, ChatRequest>>[0];
const transport: ConversationTransport<StreamEvent, ChatRequest> = createAgentConversationTransport(gatewayOptions);
const factories = { createAssistance, createAssistanceWorker, resolveScheduleTime, createPostgresAssistanceStore, assistancePostgresSchema,
  createNotificationDelivery, createHandrailFeedbackObserver, createHandrailFeedbackEffectAdapter,
  createAgentCheckpointReader, createApplicationAgentTools };
// @ts-expect-error Durable identity cannot be replaced by a string.
await runtime.wake('job-id');
// @ts-expect-error A Model is not an authorized host.
createAgentRuntime({ ...options, host: options.model });
