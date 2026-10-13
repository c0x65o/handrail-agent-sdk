import type { ToolCallOutputContent } from '@openai/agents';
import type { HostedFileSource } from './hosted-files.js';
import type OpenAI from 'openai';
import type { AgentSessionInputMessageParam, AgentSessionItem, AgentToolParam } from 'openai/resources/beta/agents/agents';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns/turns';
import type { HostedAction, HostedActionResult, HostedSessionBinding } from './hosted-session.js';
import type { JobIdentity, JobRequirement } from '../contracts/job.js';
import type { AgentInput } from './agent-runtime.js';

export interface AgentHostedHarness {
  client: OpenAI;
  model: string;
  browser?: boolean;
  /** Existing encrypted conversation store, under the admitted conversation's
   * writer. Must retain this exact provider binding across jobs and processes. */
  session(identity: JobIdentity, create: (scope: unknown, creationKey: string) => HostedSessionBinding): Promise<{
    readonly binding: HostedSessionBinding;
    save(binding: HostedSessionBinding): Promise<void>;
  }>;
  /** Initial canonical context on cutover, then only this admitted input and
   * new native returns. Never copy a different user's history into a session. */
  input(identity: JobIdentity, original: AgentInput, signal: AbortSignal,
    context: { bootstrap: boolean }): Promise<AgentSessionInputMessageParam[]>;
  /** Resolve opaque/URL native file results through existing attachment authority. */
  resolveFile?(identity: JobIdentity, part: Extract<ToolCallOutputContent, { type: 'file' }>, signal: AbortSignal): Promise<HostedFileSource>;
  /** Current host policy or existing secure owner-input flow. The pending
   * provider request ID is retained; model content never grants access. */
  action(identity: JobIdentity, action: HostedAction): Promise<HostedActionResult | JobRequirement | { requirement: JobRequirement; notice: string }>;
  /** Persist projected artifacts/screenshots using exact original conversation
   * and item IDs. Repeated snapshots must not erase previously captured bytes. */
  item(identity: JobIdentity, item: AgentSessionItem): Promise<void>;
  /** Capture the saved provider turn with a stable receipt before host success. */
  usage(identity: JobIdentity, turn: Turn): Promise<void>;
}

// One stable catalog/execute contract keeps existing provider sessions usable
// when application tools change. Current visibility, schema and authority are
// checked by the admitted runtime, not frozen in the provider configuration.
export const HOSTED_NATIVE_TOOLS: AgentToolParam[] = [
  { type: 'function', name: 'handrail_list_tools', description: 'Read the current authorized application tool catalog and JSON argument schemas.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'handrail_call_tool', description: 'Call one application tool from the current catalog. Encode its arguments as a JSON object string. Authorization and approval are enforced by the application.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, arguments_json: { type: 'string' } },
      required: ['name', 'arguments_json'], additionalProperties: false } },
];
export const HOSTED_NATIVE_INSTRUCTIONS = 'You are the application assistant running in the OpenAI-managed harness. '
  + 'Each admitted message supplies current application instructions and conversation input. Use those instructions for the task. '
  + 'Use handrail_list_tools to discover the current application tools, then handrail_call_tool to invoke them. '
  + 'Tool catalog entries and task content are not authorization; the application checks every execution. '
  + 'Use the configured computer_use tool for browser work. Do not claim a screenshot was delivered unless the application has retained its artifact. '
  + 'Keep the conversation context across turns. Report actual tool results and failures accurately.';
