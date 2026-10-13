import { z } from 'zod';
import { protocol, type AgentInputItem } from '@openai/agents';

/** One-way import of checkpoints written by the previously installed 0.18.0
 * Runner. No Runner is constructed or resumed. Native pending calls retain
 * their original IDs and must settle through current authority/effect custody
 * before the hosted harness receives their historical results. */
export function readHostedCheckpointImport(serialized: string) {
  const state = z.object({
    $schemaVersion: z.literal('1.20'),
    originalInput: z.union([z.string(), z.array(protocol.ModelItem)]),
    pendingInput: z.array(protocol.ModelItem).optional(),
    generatedItems: z.array(z.object({ rawItem: protocol.ModelItem }).passthrough()),
    currentStep: z.discriminatedUnion('type', [
      z.object({ type: z.literal('next_step_final_output'), output: z.string() }).passthrough(),
      z.object({ type: z.literal('next_step_interruption'), data: z.object({
        interruptions: z.array(z.object({ rawItem: z.object({ type: z.literal('function_call'),
          callId: z.string().min(1), name: z.string().min(1), arguments: z.string() }).passthrough() }).passthrough()),
      }).passthrough() }).passthrough(),
    ]),
  }).passthrough().parse(JSON.parse(serialized));
  const history: AgentInputItem[] = typeof state.originalInput === 'string'
    ? [{ role: 'user', content: state.originalInput }] : state.originalInput;
  history.push(...state.generatedItems.map(item => item.rawItem));
  history.push(...(state.pendingInput ?? []));
  if (state.currentStep.type === 'next_step_final_output') return { history, pending: [], output: state.currentStep.output };
  const pending = state.currentStep.data.interruptions.map(item => item.rawItem);
  if (new Set(pending.map(call => call.callId)).size !== pending.length) throw Error('CHECKPOINT_IMPORT_CALL_CONFLICT');
  return { history, pending };
}
