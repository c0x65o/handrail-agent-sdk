import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolExecutionQueue } from './tool-execution-queue.js';
import { canonicalAgentJson } from './agent-state-binding.js';
import { setSensitiveDataLoggingEnabled, protocol } from '@openai/agents';
import { attachHostedFile, type HostedFileReceipt, type HostedFileSource } from './hosted-files.js';
import { createHostedSessionClient, HostedSessionError } from './hosted-session.js';
import { APIError } from 'openai';
import type { HostedSessionBinding, HostedTurnBinding } from './hosted-session.js';
import { HOSTED_NATIVE_TOOLS, HOSTED_NATIVE_INSTRUCTIONS } from './hosted-runtime-ports.js';
import { readHostedCheckpointImport } from './hosted-checkpoint-import.js';
import type { AgentHostedHarness } from './hosted-runtime-ports.js';
export type { AgentHostedHarness } from './hosted-runtime-ports.js';
import type { AgentSessionInputMessageParam, AgentFunctionCallOutputParam } from 'openai/resources/beta/agents/agents';
import type { AgentInputItem, ToolCallOutputContent } from '@openai/agents';
import { z, type ZodObject } from 'zod';
import type { AgentJsonSchemaParameters } from './agent-tool-schema.js';
export type { AgentJsonSchemaParameters } from './agent-tool-schema.js';
import { validateJobCommand } from '../contracts/job.js';
import type { JobIdentity, JobRequirement, JobSnapshot } from '../contracts/job.js';
import { sameLeaseValue, validLeaseAuthority } from './job-lease.js';
import type { JobAppendFence, JobLease, JobLeaseAuthority, JobLeaseFence, JobLeaseHost } from './job-lease.js';
import type { JobAdmissionStore, JobStore, JobStoreResult, JobStoreErrorCode } from './job-store.js';
import type { JobAuthority } from './submit.js';
import type { EffectRequest, EffectObservation, createEffects } from './effects.js';
import type { VaultOperation } from '../contracts/vault.js';
import type { BrowserOperation, BrowserObservation } from '../contracts/browser.js';
import type { createBrowserUse } from './browser-use.js';
import type { createVaultUse } from './vault-use.js';

export interface AgentCall {
  readonly identity: JobIdentity;
  readonly callId: string;
  readonly toolName: string;
  /** Validated but untrusted model input. Never contains host authority. */
  readonly input: Record<string, unknown>;
  /** Derived from job identity + OpenAI call ID. Stable across process recovery. */
  readonly effectRef: string;
}
export interface AgentResolution {
  readonly receiptRef: string;
  /** Host-filtered nonsecret input, admitted once with the durable resume. */
  readonly input?: string;
}
export interface AgentUsage {
  /** Completed hosted root turns, not an inferred count of internal model calls. */
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
/** Trusted host-authored input. Structured history preserves roles, tool-result
 * pairing and multimodal references instead of flattening a conversation into
 * a user string. Private state limits and host attachment authorization apply. */
export type AgentInput = string | AgentInputItem[];
/** Tool content; binary data is encoded before checkpointing. Structured image/
 * file parts reach the model as modalities with the same private custody as text. */
export type AgentToolOutput = string | ToolCallOutputContent[];
/** Private custody only. Never return this record in job events or diagnostics. */
export interface AgentCheckpoint {
  readonly version: number;
  readonly definitionRef: string;
  readonly dispatches: number;
  readonly input: AgentInput;
  readonly state?: string;
  readonly hosted?: { readonly session: HostedSessionBinding; readonly turn: HostedTurnBinding; readonly input: AgentSessionInputMessageParam[] };
  readonly results: Readonly<Record<string, { readonly binding: string; readonly output: AgentToolOutput }>>;
  readonly files?: Readonly<Record<string, HostedFileReceipt>>;
  readonly resolution?: AgentResolution;
  readonly resolutionInputCall?: { readonly receiptRef: string; readonly callId: string };
  readonly usage?: AgentUsage;
  readonly output?: string;
  /** SDK-authored nonsecret interaction links, retained for stable projection. */
  readonly interactionNotices?: readonly string[];
}
export type AgentCommit = { readonly kind: 'checkpoint' }
  | { readonly kind: 'waiting'; readonly requirement: JobRequirement }
  | { readonly kind: 'succeeded'; readonly receiptRef: string }
  | { readonly kind: 'failed' };
export interface AgentStateStore {
  /** Opt-in paged private custody. The host supplies a total storage quota;
   * maxStateBytes still bounds control metadata, not the encrypted pages. */
  readonly checkpointQuotaBytes?: number;
  /** Authenticate ownership before returning private state. */
  load(identity: JobIdentity, authority: JobLeaseAuthority): Promise<JobStoreResult<AgentCheckpoint | null>>;
  /** CAS private state AND journal transition in one transaction under the job
   * row lock, checking the current lease and authority. Terminal commits release it. */
  commit(identity: JobIdentity, expectedVersion: number, checkpoint: AgentCheckpoint,
    change: AgentCommit, access: JobAppendFence): Promise<JobStoreResult<void>>;
  /** Host-verified wait resolution; atomically queue the SAME job and stage input.
   * Check wait revision, scope, grant and cancellation. Duplicate resume is a conflict. */
  resume(identity: JobIdentity, expectedRevision: number, resolution: AgentResolution,
    authority: JobLeaseAuthority): Promise<JobStoreResult<void>>;
}
export interface AgentRuntimeHost extends JobLeaseHost {
  recover(): Promise<readonly JobIdentity[]>;
  authorize(identity: JobIdentity): Promise<JobAuthority | null>;
  /** Ephemeral, host-filtered stream; reconnect reads the canonical final output.
   * Observation failure must not cancel admitted work. Never send raw provider events. */
  textDelta?(identity: JobIdentity, delta: string): void;
  /** Resolve admitted private input; exclude credentials/cookies/Vault values. */
  input(identity: JobIdentity): Promise<AgentInput>;
  /** Current catalog visibility, evaluated on every dispatch/reconstruction.
   * Execution still goes through withToolAuthority. Omit only for a catalog
   * already scoped by the trusted host when constructing this runtime. */
  visibleTools?(identity: JobIdentity, names: readonly string[]): Promise<readonly string[]>;
  /** Current policy for the exact call; approval receipts are never model supplied.
   * Verify resolution against this call, original wait and current grant. */
  decide?(call: AgentCall, resolution?: AgentResolution): Promise<'approve' | 'reject' | JobRequirement>;
  /** Hold current tool authority stable through run and its effect/result commit.
   * Protect read tools too. Catalog visibility and approval are not permission. */
  withToolAuthority<T>(call: AgentCall, run: () => Promise<T>): Promise<T>;
  requirement(call: AgentCall, kind: 'reconciliation'): JobRequirement;
  /** Verify durable answer/schedule facts and current principal, never just receipt possession. */
  resolveWait(snapshot: JobSnapshot & { state: 'waiting' }): Promise<AgentResolution | null>;
  /** Verify task evidence and filter terminal text; issue an idempotent safe receipt.
   * Recovery can repeat this commit for the same identity after a lost receipt.
   * A model success claim is not host verification of the requested outcome. */
  output(identity: JobIdentity, text: string): Promise<{ text: string; receiptRef: string }>;
}
interface AgentToolBase {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodObject | AgentJsonSchemaParameters;
}
export type AgentRuntimeTool = AgentToolBase & (
  | { readonly kind: 'managed';
      /** SDK-owned integration. Executes under runtime authority and the job
       * lease; its implementation must use the existing durable effect ledger. */
      readonly execute: (call: AgentCall, fence: JobLeaseFence, signal: AbortSignal) => Promise<{
        readonly output: string; readonly wait?: JobRequirement; readonly notice?: string; readonly reconciliation?: boolean;
      }> }
  | { readonly kind: 'read'; readonly execute: (call: AgentCall, signal: AbortSignal) => Promise<AgentToolOutput> }
  | { readonly kind: 'effect';
      /** Bind validated references to an existing effect/Vault adapter. No IO. */
      readonly bind: (call: AgentCall) => Promise<EffectRequest>;
      /** Read a host-filtered domain result only AFTER a verified effect. This
       * callback is read-only, runs inside current tool authority, and may be
       * repeated after a crash. Never use it to dispatch another mutation. The
       * default remains the safe receipt-only observation. */
      readonly readResult?: (call: AgentCall, receipt: Extract<EffectObservation, { outcome: 'verified' }>,
        signal: AbortSignal) => Promise<AgentToolOutput> }
  | { readonly kind: 'vault';
      /** Resolve a persisted, currently authorized grant. No private value. */
      readonly bind: (call: AgentCall) => Promise<VaultOperation>;
      readonly vault: Pick<ReturnType<typeof createVaultUse>, 'execute'> }
  | { readonly kind: 'browser';
      /** Resolve immutable native admission; never accept model policy claims. */
      readonly bind: (call: AgentCall) => Promise<BrowserOperation>;
      readonly browser: Pick<ReturnType<typeof createBrowserUse>, 'execute' | 'observe'>;
      /** Optional read-only domain projection (e.g. an authorized points balance).
       * Only invoked after a verified effect and authorized sanitized observation.
       * Never return raw page text, credentials or arbitrary browser artifacts. */
      readonly readResult?: (call: AgentCall, observation: Extract<BrowserObservation, { kind: 'sanitized' }>,
        signal: AbortSignal) => Promise<AgentToolOutput> }
);
export interface AgentRuntimeLimits {
  /** null disables the corresponding execution cutoff. Storage/IO bounds remain. */
  readonly maxDispatches: number | null;
  readonly maxToolCalls: number | null;
  readonly maxContextBytes: number;
  readonly maxStateBytes: number;
  readonly maxOutputBytes: number;
  readonly maxElapsedMs: number | null;
  readonly leaseTtlMs: number;
  readonly pollMs: number;
}
export type AgentRuntimeEvent = { readonly kind: 'model_progress' | 'tool_completed' | 'checkpoint' | 'waiting' | 'succeeded' }
  | { readonly kind: 'error'; readonly code: 'execution_failed' | 'preparation_failed' | 'limit_exceeded' | 'stopped' | 'lease_lost' | 'not_authorized' | 'invalid_checkpoint'
      | `hosted_${HostedSessionError['code']}` | 'provider_request_failed'; readonly providerStatus?: number }
  | { readonly kind: 'usage'; readonly usage: AgentUsage };
export type AgentOutcome = 'succeeded' | 'failed' | 'waiting' | 'cancelled' | 'busy' | 'stopped' | 'retryable';
class Halt extends Error { constructor(readonly code: 'limit_exceeded' | 'stopped') { super(code); } }
class Reconcile extends Error { constructor(readonly call: AgentCall) { super('reconciliation_required'); } }
class BrowserHandoff extends Error { constructor(readonly requirement: JobRequirement) { super('browser_handoff_required'); } }
class StoreFailure extends Error { constructor(readonly code: JobStoreErrorCode) { super(code); } }
const unwrap = <T>(r: JobStoreResult<T>): T => { if (!r.ok) throw new StoreFailure(r.code); return r.value; };
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Halt('stopped'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const copy = <T>(v: T): T => structuredClone(v);
const digest = (v: unknown) => createHash('sha256').update(canonicalAgentJson(v)).digest('hex');


async function hostedToolOutput(output: AgentToolOutput, file: (part: Extract<ToolCallOutputContent, { type: 'file' }>, index: number) => Promise<string>): Promise<AgentFunctionCallOutputParam> {
  if (typeof output === 'string') return output;
  return Promise.all(output.map(async (part, index) => {
    if (part.type === 'text') return { type: 'input_text' as const, text: part.text };
    if (part.type === 'image' && typeof part.image === 'string') return { type: 'input_image' as const, image_url: part.image };
    if (part.type === 'image' && typeof part.image === 'object' && 'data' in part.image) {
      const data = typeof part.image.data === 'string' ? part.image.data : Buffer.from(part.image.data).toString('base64');
      return { type: 'input_image' as const, image_url: `data:${part.image.mediaType};base64,${data}` };
    }
    if (part.type === 'file') return { type: 'input_text' as const, text: await file(part, index) };
    throw Error('unsupported_hosted_tool_content');
  }));
}

/** OpenAI owns all model/tool orchestration. The surrounding dispatch loop only
 * persists provider session/turn identities and applies native host decisions.
 * The provider saves function-call identity BEFORE local IO. Existing effects
 * and authorization remain authoritative; no application-run model loop remains. */
export function createAgentRuntime(deps: {
  readonly definitionRef: string;
  readonly instructions: string;
  readonly harness: AgentHostedHarness;
  /** Human/application approval is optional. Account and tool authority checks
   * still run for every call in either mode. Defaults to host decisions. */
  readonly approvals?: 'host' | 'none';
  /** Independent reads may overlap. Effects remain exclusive and ordered.
   * Defaults to one; the provider may request a batch, and this bounds its local reads. */
  readonly readConcurrency?: number;
  readonly tools: readonly AgentRuntimeTool[];
  readonly host: AgentRuntimeHost;
  readonly admission: JobAdmissionStore;
  readonly journal: JobStore;
  readonly lease: JobLease;
  readonly states: AgentStateStore;
  readonly effects: ReturnType<typeof createEffects>;
  readonly limits: AgentRuntimeLimits;
  /** Metadata only, best effort; no text deltas, arguments, errors or identifiers. */
  readonly observe?: (event: AgentRuntimeEvent) => void;
}) {
  const limits = deps.limits;
  const approvals = deps.approvals ?? 'host';
  if (!['host', 'none'].includes(approvals) || (approvals === 'host' && typeof deps.host.decide !== 'function'))
    throw Error('AGENT_APPROVAL_CONFIG_INVALID');
  const readConcurrency = deps.readConcurrency ?? 1;
  const optionalCutoffs = new Set(['maxDispatches', 'maxToolCalls', 'maxElapsedMs']);
  if (Object.entries(limits).some(([key, v]) => !(v === null && optionalCutoffs.has(key)) && (!Number.isSafeInteger(v) || v! <= 0))
    || !Number.isSafeInteger(readConcurrency) || readConcurrency < 1
    || limits.maxStateBytes > 65_536 || limits.pollMs * 3 >= limits.leaseTtlMs
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deps.definitionRef)
    || new Set(deps.tools.map(t => t.name)).size !== deps.tools.length) throw Error('AGENT_CONFIG_INVALID');
  // Upstream has a process-wide logging switch; enforce its stricter setting.
  setSensitiveDataLoggingEnabled(false);
  let stopped = false;
  const active = new Set<AbortController>();
  const activeJobs = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  const emit = (e: AgentRuntimeEvent) => { try { deps.observe?.(e); } catch { /* observation is not authority */ } };
  async function load(identity: JobIdentity) {
    if (!validateJobCommand({ command: 'inspect', identity }).ok) throw Error('invalid_payload');
    const authority = await deps.host.authorize(copy(identity));
    if (!authority || !sameLeaseValue(authority.host, identity.host)) throw Error('not_authorized');
    const admitted = unwrap(await deps.admission.inspectAdmission(identity.jobId, authority));
    if (!sameLeaseValue(admitted.identity, identity)) throw Error('not_authorized');
    return unwrap(await deps.journal.load(identity));
  }
  async function authorized<T>(identity: JobIdentity, run: (authority: JobLeaseAuthority) => Promise<JobStoreResult<T>>) {
    return unwrap(await deps.host.withAuthority(copy(identity), 'append', async authority => {
      if (!validLeaseAuthority(authority, identity)) return { ok: false, code: 'not_authorized' };
      return run(authority);
    }));
  }
  async function dispatch(identity: JobIdentity): Promise<JobStoreResult<AgentOutcome>> {
    if (stopped) return { ok: true, value: 'stopped' };
    let fence: JobLeaseFence | null = null;
    const controller = new AbortController();
    const toolController = new AbortController();
    const toolSignal = AbortSignal.any([controller.signal, toolController.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let record: AgentCheckpoint | null = null;
    let persisted: AgentCheckpoint | null = null;
    let save: ((change?: AgentCommit) => Promise<void>) | undefined;
    let fatal: unknown;
    let preparationFailed = false;
    const executions = createToolExecutionQueue(readConcurrency);
    let checkpointTail = Promise.resolve();
    const serializeCheckpoint = <T>(run: () => Promise<T>): Promise<T> => {
      const next = checkpointTail.then(run);
      checkpointTail = next.then(() => undefined, () => undefined);
      return next;
    };
    const executingRefs = new Set<string>();
    let preparing = false;
    let preparationExpired = false;
    try {
      let snapshot = await load(identity);
      if (['succeeded', 'failed', 'cancelled', 'waiting'].includes(snapshot.state))
        return { ok: true, value: snapshot.state as AgentOutcome };
      fence = unwrap(await deps.lease.claim(identity, limits.leaseTtlMs));
      if (!fence) return { ok: true, value: 'busy' };
      active.add(controller);
      activeJobs.set(identity.jobId, controller);
      if (limits.maxElapsedMs !== null) timer = setTimeout(() => {
        preparationExpired = preparing;
        controller.abort();
      }, limits.maxElapsedMs);
      // A missing attachment/invalid saved input is an execution failure, not
      // an indefinitely running job. Classify preparation before provider input.
      const prepare = async <T>(run: () => Promise<T>): Promise<T> => {
        preparing = true;
        try { return await abortable(Promise.resolve().then(run), controller.signal); }
        catch (error) { preparationFailed = true; throw error; }
        finally { preparing = false; }
      };
      const check = async () => {
        if (controller.signal.aborted || stopped) throw new Halt('stopped');
        unwrap(await deps.lease.check(fence!));
      };
      const beat = () => {
        heartbeat = setTimeout(() => {
          renewal = deps.lease.renew(fence!, limits.leaseTtlMs).then(r => {
            fence = unwrap(r);
            if (!controller.signal.aborted) beat();
          }).catch(error => { fatal = error; controller.abort(); });
        }, limits.pollMs);
      };
      beat();
      snapshot = await load(identity);
      if (snapshot.state === 'queued') unwrap(await deps.lease.append({ kind: 'started', previousRevision: snapshot.revision,
        snapshot: { identity, revision: snapshot.revision + 1, effects: snapshot.effects, state: 'running' } }, fence));
      record = await authorized(identity, a => deps.states.load(identity, a));
      if (record && record.definitionRef !== deps.definitionRef && !(record.state && !record.hosted)) throw new StoreFailure('invalid_checkpoint');
      record ??= { version: 0, definitionRef: deps.definitionRef, dispatches: 0,
        input: await prepare(() => deps.host.input(copy(identity))), results: {} };
      save = async (change = { kind: 'checkpoint' }) => {
        await check();
        const control = deps.states.checkpointQuotaBytes === undefined ? record
          : { ...record, input: undefined, state: undefined, results: undefined, output: undefined,
            hosted: record?.hosted ? { ...record.hosted, input: undefined } : undefined };
        if (size(control) > limits.maxStateBytes || size(record) > (deps.states.checkpointQuotaBytes ?? limits.maxStateBytes)) throw new Halt('limit_exceeded');
        const next = { ...record!, version: record!.version + 1 };
        await authorized(identity, authority => deps.states.commit(identity, record!.version, next, change,
          { authority, fence: fence!, now: () => deps.host.now() }));
        record = next; persisted = next;
      };
      const reconcileTerminalEffects = async () => {
        const current = await load(identity);
        const unknown = current.effects.filter(effect => effect.outcome === 'unknown');
        if (!unknown.length) return;
        const hosted = record?.hosted;
        if (!hosted?.session.sessionId || !hosted.turn.turnId) throw new StoreFailure('effect_conflict');
        // A remote function can time out while native approval is pending. Its
        // terminal answer is not evidence that the native effect settled. Read
        // the original provider call and reconcile its exact durable binding;
        // NEVER dispatch the action after the provider stopped waiting for it.
        const calls: AgentCall[] = [];
        for await (const item of deps.harness.client.beta.agents.sessions.turns.items.list(hosted.turn.turnId,
          { session_id: hosted.session.sessionId, order: 'asc', limit: 100 }, { signal: controller.signal, maxRetries: 0 })) {
          await check(); await load(identity);
          if (item.type !== 'function_call' || item.name !== 'handrail_call_tool') continue;
          const envelope = z.object({name:z.string(),arguments_json:z.string()}).strict().safeParse(item.arguments);
          if (!envelope.success) continue;
          const reference=`agent:${digest([identity,item.call_id,envelope.data.name])}`;
          if(!unknown.some(effect=>effect.effectRef===reference))continue;
          const definition = deps.tools.find(tool => tool.name === envelope.data.name && tool.kind === 'effect');
          if (!definition) continue;
          const parsed = definition.parameters.parse(JSON.parse(envelope.data.arguments_json));
          calls.push({identity:copy(identity),toolName:definition.name,input:parsed,callId:item.call_id,
            effectRef:`agent:${digest([identity,item.call_id,definition.name])}`});
        }
        for (const effect of unknown) {
          const call = calls.find(call => call.effectRef === effect.effectRef);
          const definition = call && deps.tools.find(tool => tool.name === call.toolName && tool.kind === 'effect');
          if (!call || definition?.kind !== 'effect') throw new StoreFailure('effect_conflict');
          await deps.host.withToolAuthority(call, async () => {
            await check();
            const request = await definition.bind(call);
            if (!sameLeaseValue(request.identity,identity) || request.effectRef !== effect.effectRef || request.idempotencyRef !== effect.effectRef)
              throw new StoreFailure('effect_conflict');
            const observation = unwrap(await deps.effects.reconcile(request));
            if (observation.outcome !== 'verified') throw new Reconcile(call);
            // A verified ledger receipt is immutable. Re-enter its fenced
            // completion path solely to project that fact into the job journal;
            // the effect store returns it without dispatching the adapter.
            const settled = unwrap(await deps.effects.execute(request,fence!));
            if(settled.outcome!=='verified')throw new Reconcile(call);
          });
        }
      };
      const commitOutput = async (): Promise<JobStoreResult<AgentOutcome>> => {
        await check();
        await reconcileTerminalEffects();
        const output = await deps.host.output(copy(identity), record!.output!);
        if (size(output.text) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
        record = { ...record!, output: output.text };
        await save!({ kind: 'succeeded', receiptRef: output.receiptRef });
        if (record.usage) emit({ kind: 'usage', usage: record.usage });
        emit({ kind: 'succeeded' });
        return { ok: true, value: 'succeeded' };
      };
      // A completed provider response may outlive a failed/lost host output
      // commit. Reauthorize and commit its saved answer without another model
      // dispatch, tool replay, or provider charge.
      if (typeof record.output === 'string') return await commitOutput();
      if ((limits.maxDispatches !== null && record.dispatches >= limits.maxDispatches) || size(record.input) > limits.maxContextBytes) throw new Halt('limit_exceeded');
      record = { ...record, dispatches: record.dispatches + 1 };
      await save();
      const callFor = (name: string, callId: string, input: Record<string, unknown>): AgentCall => ({
        identity: copy(identity), toolName: name, callId, input,
        effectRef: `agent:${digest([identity, callId, name])}`,
      });
      const execute = (def: AgentRuntimeTool, input: Record<string, unknown>, callId: string) => executions.run(def.kind === 'read', async () => {
            try {
              if (fatal) throw fatal;
              await check();
              const call = callFor(def.name, callId, input);
              const binding = digest([call.toolName, call.input]);
              return await deps.host.withToolAuthority(call, async () => {
                await check();
                const prior = record!.results[call.effectRef];
                if (prior) {
                  if (prior.binding !== binding) throw Error('call_conflict');
                  return prior.output;
                }
                if (limits.maxToolCalls !== null && new Set([...Object.keys(record!.results), ...executingRefs]).size >= limits.maxToolCalls) throw new Halt('limit_exceeded');
                executingRefs.add(call.effectRef);
                let output: AgentToolOutput;
                if (def.kind === 'managed') {
                  const result = await def.execute(call, fence!, toolSignal);
                  await check();
                  if (result.reconciliation) throw new Reconcile(call);
                  output = result.output;
                  if (result.wait) {
                    if (typeof output !== 'string' || size(output) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
                    record = { ...record!, results: { ...record!.results, [call.effectRef]: { binding, output } } };
                    if (result.notice) {
                      if (size(result.notice) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
                      record = { ...record, interactionNotices: [...(record.interactionNotices ?? []), result.notice] };
                    }
                    throw new BrowserHandoff(result.wait);
                  }
                } else if (def.kind === 'browser') {
                  const request = await def.bind(call);
                  if (!sameLeaseValue(request.identity, identity) || request.effect.effectRef !== call.effectRef)
                    throw new StoreFailure('effect_conflict');
                  await check();
                  const receipt = unwrap(await def.browser.execute(request, fence!));
                  if (receipt.outcome !== 'verified') throw new Reconcile(call);
                  const observation = unwrap(await def.browser.observe(request));
                  if (observation.effect.outcome !== 'verified') throw new Reconcile(call);
                  if (observation.kind === 'takeover') {
                    // Retain the verified action's reference-only result before
                    // waiting. Handback changes the browser lease; replay must
                    // not redispatch the old action under a successor lease.
                    output = JSON.stringify(observation);
                    if (size(output) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
                    record = { ...record!, results: { ...record!.results, [call.effectRef]: { binding, output } } };
                    throw new BrowserHandoff(observation.requirement);
                  }
                  output = def.readResult && observation.kind === 'sanitized'
                    ? await abortable(def.readResult(call, observation, toolSignal), toolSignal)
                    : JSON.stringify(observation);
                } else if (def.kind === 'vault') {
                  const request = await def.bind(call);
                  if (!sameLeaseValue(request.identity, identity) || request.effect.effectRef !== call.effectRef)
                    throw new StoreFailure('effect_conflict');
                  await check();
                  const observation = unwrap(await def.vault.execute(request, fence!));
                  if (observation.outcome !== 'verified') throw new Reconcile(call);
                  output = JSON.stringify(observation);
                } else if (def.kind === 'effect') {
                  const request = await def.bind(call);
                  if (!sameLeaseValue(request.identity, identity) || request.effectRef !== call.effectRef
                    || request.idempotencyRef !== call.effectRef) throw Error('effect_binding');
                  await check();
                  const observation = unwrap(await deps.effects.execute(request, fence!));
                  if (observation.outcome !== 'verified') throw new Reconcile(call);
                  output = def.readResult
                    ? await abortable(def.readResult(call, observation, toolSignal), toolSignal)
                    : JSON.stringify(observation);
                } else {
                  try { output = await abortable(def.execute(call, toolSignal), toolSignal); }
                  catch { output = '{"error":"tool_failed"}'; }
                }
                await check();
                if (typeof output !== 'string') output = protocol.ToolCallOutputContent.array().parse(output).map(part => {
                  if (part.type === 'image' && part.image && typeof part.image === 'object'
                    && 'data' in part.image && part.image.data instanceof Uint8Array)
                    return { ...part, image: { ...part.image, data: Buffer.from(part.image.data).toString('base64') } };
                  if (part.type === 'file' && typeof part.file === 'object'
                    && 'data' in part.file && part.file.data instanceof Uint8Array)
                    return { ...part, file: { ...part.file, data: Buffer.from(part.file.data).toString('base64') } };
                  return part;
                });
                if (size(output) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
                await serializeCheckpoint(async () => {
                  await check();
                  if (fatal) throw fatal;
                  record = { ...record!, results: { ...record!.results, [call.effectRef]: { binding, output } } };
                  await save!();
                });
                executingRefs.delete(call.effectRef);
                emit({ kind: 'tool_completed' });
                return output;
              });
            } catch (error) { fatal ??= error; toolController.abort(); throw Error('AGENT_TOOL_HALTED'); }
      });
      if (record.state && !record.hosted) {
        let imported: ReturnType<typeof readHostedCheckpointImport>;
        try { imported = readHostedCheckpointImport(record.state); }
        catch { throw new StoreFailure('invalid_checkpoint'); }
        if (imported.output !== undefined) {
          const { state: _state, ...original } = record;
          record = { ...original, definitionRef: deps.definitionRef, output: imported.output };
          await save();
          return await commitOutput();
        }
        for (const pending of imported.pending) {
          const visible = deps.host.visibleTools ? await deps.host.visibleTools(copy(identity), deps.tools.map(t => t.name)) : deps.tools.map(t => t.name);
          const def = deps.tools.find(t => t.name === pending.name && visible.includes(t.name));
          if (!def) throw new StoreFailure('not_authorized');
          let input: Record<string, unknown>;
          let output: AgentToolOutput;
          try { input = def.parameters.parse(JSON.parse(pending.arguments)); }
          catch {
            imported.history.push({ type: 'function_call_result', status: 'completed', callId: pending.callId, name: pending.name,
              output: '{"error":"invalid_arguments","dispatched":false}' });
            continue;
          }
          const call = callFor(def.name, pending.callId, input);
          const decision = approvals === 'none' ? 'approve' : await deps.host.decide!(call, record.resolution);
          if (decision !== 'approve' && decision !== 'reject') throw new BrowserHandoff(decision);
          output = decision === 'reject' ? 'Host declined this action.' : await execute(def, input, pending.callId);
          imported.history.push(protocol.ModelItem.parse({ type: 'function_call_result', status: 'completed', callId: pending.callId, name: pending.name,
            output: typeof output === 'string' ? output : output.map(({ type, ...part }) => ({ ...part, type: `input_${type}` })) }));
        }
        if (record.resolution?.input) imported.history.push({ role: 'user', content: record.resolution.input });
        const { state: _state, ...original } = record;
        record = { ...original, definitionRef: deps.definitionRef, input: imported.history };
        await save();
      }
      const driver = createHostedSessionClient({ client: deps.harness.client, model: deps.harness.model,
        instructions: HOSTED_NATIVE_INSTRUCTIONS, tools: HOSTED_NATIVE_TOOLS,
        ...(deps.harness.browser === undefined ? {} : { browser: deps.harness.browser }) });
      const session = await deps.harness.session(copy(identity), (scope, key) => ({ ...driver.binding(scope, key), bootstrapJobId: identity.jobId }));
      await driver.connect({ binding: session.binding, signal: controller.signal,
        authorize: async () => { await check(); await load(identity); }, save: binding => session.save(binding) });
      if (!record.hosted) {
        const input = await prepare(() => deps.harness.input(copy(identity), copy(record!.input), controller.signal,
          { bootstrap: session.binding.bootstrapJobId === identity.jobId }));
        if (size(input) > limits.maxContextBytes) throw new Halt('limit_exceeded');
        record = { ...record, hosted: { session: session.binding, turn: { submissionKey: `handrail:${digest(identity)}` },
          input: [{ role: 'user', content: [{ type: 'input_text', text: `Current application instructions:\n${deps.instructions}` }] }, ...input] } };
        await save();
      }
      if (record.hosted!.session.sessionId !== session.binding.sessionId) throw new StoreFailure('invalid_checkpoint');
      const result = await driver.run({ session: session.binding, turn: record.hosted!.turn, input: record.hosted!.input,
        signal: controller.signal, authorize: async () => { await check(); await load(identity); },
        save: async turn => { record = { ...record!, hosted: { ...record!.hosted!, turn } }; await save!(); },
        item: item => {
          const sessionId=session.binding.sessionId,turnId=record!.hosted!.turn.turnId;
          if(!sessionId||!turnId||item.type==='computer_use_call'&&item.turn_id!==turnId)throw new StoreFailure('identity_mismatch');
          return deps.harness.item(copy(identity),item,{sessionId,turnId});
        },
        event: async event => {
          emit({ kind: 'model_progress' });
          if (event.type === 'agent.session.turn.output_text.delta') {
            try { deps.host.textDelta?.(copy(identity), event.delta); } catch { /* observer close is not Stop */ }
          }
        },
        parallelRead: action => {
          if (action.type !== 'function_call' || action.name !== 'handrail_call_tool') return false;
          const envelope = z.object({ name: z.string(), arguments_json: z.string() }).strict().safeParse(action.arguments);
          return envelope.success && deps.tools.some(tool => tool.name === envelope.data.name && tool.kind === 'read');
        },
        action: async action => {
          if (action.type !== 'function_call') {
            const decision = await deps.harness.action(copy(identity), action);
            if ('requirement' in decision) {
              if (size(decision.notice) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
              record = { ...record!, interactionNotices: [...new Set([...(record!.interactionNotices ?? []), decision.notice])] };
              throw new BrowserHandoff(decision.requirement);
            }
            if ('requirementRef' in decision) throw new BrowserHandoff(decision);
            return decision;
          }
          const response = (output: AgentFunctionCallOutputParam) => ({ type: 'agent.session.input.tool_result' as const,
            call_id: action.call_id, turn_id: action.turn_id, success: true, output });
          const current = deps.host.visibleTools ? await deps.host.visibleTools(copy(identity), deps.tools.map(t => t.name)) : deps.tools.map(t => t.name);
          if (action.name === 'handrail_list_tools') return response(JSON.stringify(deps.tools.filter(t => current.includes(t.name))
            .map(t => ({ name: t.name, description: t.description, parameters: 'jsonSchema' in t.parameters ? t.parameters.jsonSchema : z.toJSONSchema(t.parameters) }))));
          if (action.name !== 'handrail_call_tool') return response('{"error":"unknown_tool","dispatched":false}');
          const envelope = z.object({ name: z.string(), arguments_json: z.string() }).strict().safeParse(action.arguments);
          if (!envelope.success) return response('{"error":"invalid_arguments","dispatched":false}');
          const def = deps.tools.find(t => t.name === envelope.data.name && current.includes(t.name));
          if (!def) return response('{"error":"tool_unavailable","dispatched":false}');
          let input: Record<string, unknown>;
          try { input = def.parameters.parse(JSON.parse(envelope.data.arguments_json)); }
          catch { return response('{"error":"invalid_arguments","dispatched":false}'); }
          const call = callFor(def.name, action.call_id, input);
          const decision = approvals === 'none' ? 'approve' : await deps.host.decide!(call, record!.resolution);
          if (decision === 'reject') return response('Host declined this action.');
          if (decision !== 'approve') throw new BrowserHandoff(decision);
          let output = await execute(def, input, action.call_id);
          if (record!.resolution?.input && record!.resolutionInputCall?.receiptRef !== record!.resolution.receiptRef) {
            // The original provider call is still waiting. Return the verified
            // answer with that call's result, saving it before transport IO so a
            // restart cannot drop it or append it to a later unrelated call.
            output = JSON.stringify({ tool_result: output, owner_input: record!.resolution.input });
            record = { ...record!, resolutionInputCall: { receiptRef: record!.resolution.receiptRef, callId: action.call_id },
              results: { ...record!.results, [call.effectRef]: { binding: digest([call.toolName, call.input]), output } } };
            await save!();
          }
          // Preserve multimodal native results through the hosted function protocol.
          return response(await hostedToolOutput(output, async (part, index) => {
            let source: HostedFileSource;
            if (typeof part.file === 'object' && 'data' in part.file) source = {
              data: typeof part.file.data === 'string' ? Buffer.from(part.file.data, 'base64') : part.file.data, filename: part.file.filename };
            else if (typeof part.file === 'object' && 'id' in part.file) source = { fileId: part.file.id, filename: part.file.filename ?? 'attachment' };
            else if (deps.harness.resolveFile) source = await deps.harness.resolveFile(copy(identity), part, controller.signal);
            else throw Error('HOSTED_FILE_RESOLVER_REQUIRED');
            const key = digest([action.call_id, index]);
            const receipt = await attachHostedFile(deps.harness.client, { session: session.binding, source,
              ...(record!.files?.[key] ? { receipt: record!.files[key] } : {}), signal: controller.signal,
              authorize: async () => { await check(); await load(identity); },
              save: next => serializeCheckpoint(async () => { record = { ...record!, files: { ...record!.files, [key]: next } }; await save!(); }),
            });
            return JSON.stringify({ type: 'environment_file', path: receipt.path, filename: source.filename, size_bytes: receipt.sizeBytes });
          }));
        },
      });
      if (result.status === 'waiting') throw Error('missing_host_requirement');
      await deps.harness.usage(copy(identity), result.turn);
      // A separate Stop handler may cancel the provider while this observer
      // still owns the execution lease. Leave the native job cancellable: its
      // authenticated Stop transaction owns the explicit_stop actor and fence.
      // Committing failure here would win the race and erase that outcome.
      if (result.turn.status === 'cancelled') return { ok: true, value: 'stopped' };
      if (result.turn.status !== 'completed') { await save({ kind: 'failed' }); return { ok: true, value: 'failed' }; }
      if (size(result.outputText) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
      record = { ...record, output: result.outputText,
        ...(result.turn.usage ? { usage: { requests: 1, inputTokens: result.turn.usage.input_tokens,
          outputTokens: result.turn.usage.output_tokens, totalTokens: result.turn.usage.total_tokens } } : {}) };
      await save();
      return await commitOutput();

    } catch (caught) {
      // Provider observation may fail before tools settle. Drain queued calls before
      // changing job state or releasing the execution lease. Fatal checks stop
      // queued calls; active reads retain cancellation through their signal.
      toolController.abort();
      await executions.drain();
      const error = fatal ?? caught;
      if (fence && !fatal && !stopped && (preparationExpired || (preparationFailed && !controller.signal.aborted))) {
        try {
          // Use the durable fence, not the aborted local deadline, to settle.
          // Stop/revocation/lease loss must win. Never discard uncertain effects
          // or the completed output retained for host-commit recovery.
          unwrap(await deps.lease.check(fence));
          const current = await load(identity);
          if (!current.effects.some(effect => effect.outcome === 'unknown') && record?.output === undefined) {
            unwrap(await deps.lease.complete({ kind: 'failed', previousRevision: current.revision,
              snapshot: { identity, revision: current.revision + 1, state: 'failed', effects: current.effects,
                error: { code: 'execution_failed', correlationRef: identity.origin.correlationRef } } }, fence));
            emit({ kind: 'error', code: preparationExpired ? 'limit_exceeded' : 'preparation_failed' });
            return { ok: true, value: 'failed' };
          }
        } catch { /* Current durable authority owns any competing transition. */ }
      }
      if ((error instanceof Reconcile || error instanceof BrowserHandoff) && save) {
        try {
          await save({ kind: 'waiting', requirement: error instanceof BrowserHandoff
            ? error.requirement : deps.host.requirement(error.call, 'reconciliation') });
          emit({ kind: 'waiting' }); return { ok: true, value: 'waiting' };
        } catch { /* leave the durable pending call for recovery */ }
      }
      if (error instanceof Halt && error.code === 'limit_exceeded' && save) {
        try {
          if (persisted) { record = persisted; await save({ kind: 'failed' }); }
          else {
            const current = await load(identity);
            unwrap(await deps.lease.complete({ kind: 'failed', previousRevision: current.revision,
              snapshot: { identity, revision: current.revision + 1, state: 'failed', effects: current.effects,
                error: { code: 'execution_failed', correlationRef: identity.origin.correlationRef } } }, fence!));
          }
          emit({ kind: 'error', code: 'limit_exceeded' });
          return { ok: true, value: 'failed' };
        } catch { /* lease may be gone */ }
      }
      const code = error instanceof StoreFailure && ['lease_lost', 'not_authorized', 'invalid_checkpoint'].includes(error.code)
        ? error.code as 'lease_lost' | 'not_authorized' | 'invalid_checkpoint'
        : error instanceof Halt ? error.code
        : error instanceof HostedSessionError ? `hosted_${error.code}` as const
        : error instanceof APIError ? 'provider_request_failed' : 'execution_failed';
      // Only a fixed SDK classification and HTTP status leave private custody.
      // Provider messages, bodies, headers and tool arguments may contain secrets.
      emit({ kind: 'error', code, ...(error instanceof APIError && error.status !== undefined ? { providerStatus: error.status } : {}) });
      if (error instanceof StoreFailure) return { ok: false, code: error.code };
      if (!fence) return { ok: false, code: 'not_authorized' };
      return { ok: true, value: controller.signal.aborted || stopped ? 'stopped' : 'retryable' };
    } finally {
      controller.abort(); clearTimeout(timer); clearTimeout(heartbeat);
      await renewal;
      active.delete(controller);
      if (activeJobs.get(identity.jobId) === controller) activeJobs.delete(identity.jobId);
      if (fence) await deps.lease.release(fence);
    }
  }
  /** Queue/schedule deliveries use the original server-derived identity. */
  function wake(identity: JobIdentity): Promise<JobStoreResult<AgentOutcome>> {
    const result = dispatch(copy(identity)); pending.add(result);
    void result.finally(() => pending.delete(result)); return result;
  }
  return {
    wake,
    /** Stop the original remote turn before native job cancellation revokes its
     * execution authority. Acceptance alone is not a stopped job. Shutdown uses
     * stop() instead and deliberately leaves the provider turn recoverable. */
    async cancelProvider(input: JobIdentity, signal: AbortSignal): Promise<void> {
      const identity = copy(input);
      await load(identity);
      activeJobs.get(identity.jobId)?.abort();
      const checkpoint = await authorized(identity, authority => deps.states.load(identity, authority));
      if (!checkpoint?.hosted) return;
      const { session, turn } = checkpoint.hosted;
      const driver = createHostedSessionClient({ client: deps.harness.client, model: deps.harness.model,
        instructions: HOSTED_NATIVE_INSTRUCTIONS, tools: HOSTED_NATIVE_TOOLS,
        ...(deps.harness.browser === undefined ? {} : { browser: deps.harness.browser }) });
      await driver.cancel(session, turn, async () => { await load(identity); }, signal);
      if (!session.sessionId || !turn.submissionAttempted) return;
      const provider = deps.harness.client.beta.agents.sessions;
      for (;;) {
        signal.throwIfAborted();
        await load(identity);
        const saved = turn.turnId
          ? await provider.turns.retrieve(turn.turnId, { session_id: session.sessionId }, { signal, maxRetries: 0 })
          : (await provider.turns.list(session.sessionId, { order: 'desc', limit: 1 }, { signal, maxRetries: 0 })).data[0];
        if (!saved || saved.id === turn.baseline) return;
        if (['completed', 'failed', 'cancelled'].includes(saved.status)) {
          await deps.harness.usage(copy(identity), saved);
          return;
        }
        await delay(limits.pollMs, undefined, { signal });
      }
    },
    /** Trusted-server projection seam. Never expose raw checkpoint custody to
     * clients; filter results through the application's conversation policy. */
    async inspect(identity: JobIdentity): Promise<JobStoreResult<{ snapshot: JobSnapshot; checkpoint: AgentCheckpoint | null }>> {
      try {
        identity = copy(identity);
        const snapshot = await load(identity);
        // Stop revokes the private-state execution fence. Public terminal
        // convergence must not require opening the now-revoked checkpoint.
        if (snapshot.state === 'cancelled' || snapshot.state === 'failed') return { ok: true, value: { snapshot, checkpoint: null } };
        const checkpoint = await authorized(identity, authority => deps.states.load(identity, authority));
        return { ok: true, value: { snapshot, checkpoint } };
      } catch { return { ok: false, code: 'not_authorized' }; }
    },
    async start() {
      const results: JobStoreResult<AgentOutcome>[] = [];
      for (const identity of await deps.host.recover()) results.push(await wake(identity));
      return results;
    },
    resume(input: JobIdentity): Promise<JobStoreResult<void>> {
      if (stopped) return Promise.resolve({ ok: false, code: 'invalid_transition' });
      const identity = copy(input);
      const operation = (async (): Promise<JobStoreResult<void>> => {
        try {
          const snapshot = await load(identity);
          if (snapshot.state !== 'waiting') return { ok: false, code: 'invalid_transition' };
          await authorized(identity, async authority => {
            const resolution = await deps.host.resolveWait(snapshot);
            if (!resolution || size(resolution.input ?? '') > limits.maxContextBytes) return { ok: false, code: 'not_authorized' };
            return deps.states.resume(identity, snapshot.revision, resolution, authority);
          });
          return { ok: true, value: undefined };
        } catch { return { ok: false, code: 'not_authorized' }; }
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    },
    /** Process shutdown only. Explicit user Stop uses createJobCancellation and
     * remains terminal; a process restart may recover unfinished running work. */
    async stop() { stopped = true; for (const c of active) c.abort(); await Promise.allSettled([...pending]); },
  };
}
