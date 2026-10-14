import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { AgentSessionInputMessageParam } from 'openai/resources/beta/agents/agents';
import { canonicalAgentJson } from './agent-state-binding.js';
import type { HostedSessionBinding } from './hosted-session.js';

/** Retain with the original canonical input before provider I/O. This receipt
 * never grants authority and never replaces the native job or conversation. */
export interface HostedInputBinding {
  readonly sessionId: string;
  readonly originalTurnId: string;
  readonly submissionKey: string;
  readonly payloadDigest: string;
  readonly attempted?: boolean;
  readonly accepted?: boolean;
  readonly receipt?: { readonly turnId: string; readonly messageId: string };
}
const digest = (value: unknown) => createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
const final = (status: string) => ['completed', 'cancelled', 'failed'].includes(status);
const conflict = () => new Error('HOSTED_INPUT_BINDING_CONFLICT');

export function prepareHostedInput(input: {
  sessionId: string; originalTurnId: string; submissionKey: string;
  messages: readonly AgentSessionInputMessageParam[];
}): HostedInputBinding {
  if (!input.sessionId || !input.originalTurnId || !input.submissionKey || !input.messages.length)
    throw conflict();
  return { sessionId: input.sessionId, originalTurnId: input.originalTurnId,
    submissionKey: input.submissionKey, payloadDigest: digest(input.messages) };
}

/** Send new canonical input to the SAME hosted writer. No intent classification
 * or tool execution occurs here. The owning worker must retain its native
 * conversation lease, observe the returned turn, and settle its usage/results.
 * If the old turn finishes during submission, OpenAI can start another turn;
 * its exact identity comes from the saved user item, never a guessed latest ID.
 * HTTP acceptance alone is not a receipt. Re-enter with identical durable input
 * after uncertainty; provider idempotency and saved history prevent duplicates. */
export async function submitHostedInput(ports: {
  client: OpenAI; session: HostedSessionBinding; binding: HostedInputBinding;
  messages: readonly AgentSessionInputMessageParam[]; signal: AbortSignal;
  /** Stop/recovery inspection must never submit previously unsent work. */
  observeOnly?: boolean;
  authorize(): Promise<void>;
  save(binding: HostedInputBinding): Promise<void>;
}): Promise<{ status: 'not_submitted'; reason: 'turn_finished' | 'requires_action' }
  | { status: 'pending' } | { status: 'received'; turnId: string; messageId: string }> {
  // Caller mutations across authorization/storage awaits cannot change a retry.
  const messages = structuredClone(ports.messages), session = structuredClone(ports.session);
  let binding = structuredClone(ports.binding);
  if (!session.sessionId || session.sessionId !== binding.sessionId || !binding.originalTurnId
    || !binding.submissionKey || binding.payloadDigest !== digest(messages) || !messages.length) throw conflict();
  const sessions = ports.client.beta.agents.sessions;
  const options = { signal: ports.signal, maxRetries: 0 };
  // This unique transport marker is data, not an instruction or permission. It
  // lets recovery identify the precise saved message after an accepted timeout.
  const marker = `Saved input reference: ${digest([binding.sessionId, binding.originalTurnId, binding.submissionKey, binding.payloadDigest])}`;
  const payload: AgentSessionInputMessageParam[] = messages.map((message, i) => ({ ...message,
    content: [...message.content, ...(i === messages.length - 1 ? [{ type: 'input_text' as const, text: marker }] : [])] }));
  await ports.authorize();
  const current = await sessions.retrieve(binding.sessionId, options);
  if (current.metadata.handrail_scope !== session.scopeDigest || current.metadata.handrail_creation !== session.creationKey
    || current.metadata.handrail_configuration !== session.configurationDigest) throw conflict();
  if (binding.receipt) return { status: 'received', ...binding.receipt };
  const readReceipt = async () => {
    let receipt: HostedInputBinding['receipt'];
    // History is already private to this verified session. Reauthorize each
    // provider page and the retained receipt, rather than replaying native
    // admission once per historical item while the live worker is waiting.
    const history = await sessions.items.list(binding.sessionId, { order: 'desc', limit: 100 }, options);
    for await (const page of history.iterPages()) {
      await ports.authorize();
      for (const item of page.data) {
        ports.signal.throwIfAborted();
        if (item.type !== 'message' || item.role !== 'user'
          || !item.content.some(part => part.type === 'input_text' && part.text === marker)) continue;
        if (!item.id || !item.turn_id || receipt) throw conflict();
        receipt = { messageId: item.id, turnId: item.turn_id };
      }
    }
    if (!receipt) return null;
    if (!binding.attempted) throw conflict();
    binding = { ...binding, receipt };
    await ports.authorize();
    await ports.save(binding);
    return { status: 'received' as const, ...receipt };
  };
  if (binding.attempted) {
    const receipt = await readReceipt();
    if (receipt) return receipt;
    if (binding.accepted || ports.observeOnly) return { status: 'pending' };
  } else {
    if (ports.observeOnly) return { status: 'pending' };
    const latest = (await sessions.turns.list(binding.sessionId, { order: 'desc', limit: 1 }, options)).data[0];
    if (!latest || latest.id !== binding.originalTurnId) throw conflict();
    if (final(latest.status)) return { status: 'not_submitted', reason: 'turn_finished' };
    if (current.required_actions.length) return { status: 'not_submitted', reason: 'requires_action' };
    binding = { ...binding, attempted: true };
    await ports.authorize();
    await ports.save(binding);
  }
  await ports.authorize();
  await sessions.events.create(binding.sessionId, {
    'Idempotency-Key': binding.submissionKey,
    events: [{ type: 'agent.session.input.message', input: payload }],
  }, options);
  binding = { ...binding, accepted: true };
  await ports.authorize();
  await ports.save(binding);
  return await readReceipt() ?? { status: 'pending' };
}
