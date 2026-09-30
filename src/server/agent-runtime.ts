import { createHash } from 'node:crypto';
import { canonicalAgentJson } from './agent-state-binding.js';
import { Agent, Runner, RunState, setSensitiveDataLoggingEnabled, tool } from '@openai/agents';
import type { AgentInputItem, Model } from '@openai/agents';
import type { ZodObject } from 'zod';
import { validateJobCommand } from '../contracts/job.js';
import type { JobIdentity, JobRequirement, JobSnapshot } from '../contracts/job.js';
import { sameLeaseValue, validLeaseAuthority } from './job-lease.js';
import type { JobAppendFence, JobLease, JobLeaseAuthority, JobLeaseFence, JobLeaseHost } from './job-lease.js';
import type { JobAdmissionStore, JobStore, JobStoreResult, JobStoreErrorCode } from './job-store.js';
import type { JobAuthority } from './submit.js';
import type { EffectRequest, EffectObservation, createEffects } from './effects.js';
import type { VaultOperation } from '../contracts/vault.js';
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
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
/** Trusted host-authored input. Structured history preserves roles, tool-result
 * pairing and multimodal references instead of flattening a conversation into
 * a user string. Private state limits and host attachment authorization apply. */
export type AgentInput = string | AgentInputItem[];
/** Private custody only. Never return this record in job events or diagnostics. */
export interface AgentCheckpoint {
  readonly version: number;
  readonly definitionRef: string;
  readonly dispatches: number;
  readonly input: AgentInput;
  readonly state?: string;
  readonly results: Readonly<Record<string, { readonly binding: string; readonly output: string }>>;
  readonly resolution?: AgentResolution;
  readonly usage?: AgentUsage;
  readonly output?: string;
}
export type AgentCommit = { readonly kind: 'checkpoint' }
  | { readonly kind: 'waiting'; readonly requirement: JobRequirement }
  | { readonly kind: 'succeeded'; readonly receiptRef: string }
  | { readonly kind: 'failed' };
export interface AgentStateStore {
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
  /** Resolve admitted private input; exclude credentials/cookies/Vault values. */
  input(identity: JobIdentity): Promise<AgentInput>;
  /** Current catalog visibility, evaluated on every dispatch/reconstruction.
   * Execution still goes through withToolAuthority. Omit only for a catalog
   * already scoped by the trusted host when constructing this runtime. */
  visibleTools?(identity: JobIdentity, names: readonly string[]): Promise<readonly string[]>;
  /** Resolve/reauthorize opaque attachments just before each model request.
   * Returned provider URLs/bytes are transient, not the durable input. */
  prepareModelInput?(identity: JobIdentity, input: AgentInputItem[], signal: AbortSignal): Promise<AgentInputItem[]>;
  /** Current policy for the exact call; approval receipts are never model supplied.
   * Verify resolution against this call, original wait and current grant. */
  decide(call: AgentCall, resolution?: AgentResolution): Promise<'approve' | 'reject' | JobRequirement>;
  /** Hold current tool authority stable through run and its effect/result commit.
   * Protect read tools too. Catalog visibility and approval are not permission. */
  withToolAuthority<T>(call: AgentCall, run: () => Promise<T>): Promise<T>;
  requirement(call: AgentCall, kind: 'reconciliation'): JobRequirement;
  /** Verify durable answer/schedule facts and current principal, never just receipt possession. */
  resolveWait(snapshot: JobSnapshot & { state: 'waiting' }): Promise<AgentResolution | null>;
  /** Verify task evidence and filter terminal text; issue an idempotent safe receipt.
   * A model success claim is not host verification of the requested outcome. */
  output(identity: JobIdentity, text: string): Promise<{ text: string; receiptRef: string }>;
}
interface AgentToolBase {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodObject;
}
export type AgentRuntimeTool = AgentToolBase & (
  | { readonly kind: 'read'; readonly execute: (call: AgentCall, signal: AbortSignal) => Promise<string> }
  | { readonly kind: 'effect';
      /** Bind validated references to an existing effect/Vault adapter. No IO. */
      readonly bind: (call: AgentCall) => Promise<EffectRequest>;
      /** Read a host-filtered domain result only AFTER a verified effect. This
       * callback is read-only, runs inside current tool authority, and may be
       * repeated after a crash. Never use it to dispatch another mutation. The
       * default remains the safe receipt-only observation. */
      readonly readResult?: (call: AgentCall, receipt: Extract<EffectObservation, { outcome: 'verified' }>,
        signal: AbortSignal) => Promise<string> }
  | { readonly kind: 'vault';
      /** Resolve a persisted, currently authorized grant. No private value. */
      readonly bind: (call: AgentCall) => Promise<VaultOperation>;
      readonly vault: Pick<ReturnType<typeof createVaultUse>, 'execute'> }
);
export interface AgentRuntimeLimits {
  readonly maxTurns: number;
  readonly maxDispatches: number;
  readonly maxToolCalls: number;
  readonly maxContextBytes: number;
  readonly maxStateBytes: number;
  readonly maxOutputBytes: number;
  readonly maxElapsedMs: number;
  readonly leaseTtlMs: number;
  readonly pollMs: number;
}
export type AgentRuntimeEvent = { readonly kind: 'model_progress' | 'tool_completed' | 'checkpoint' | 'waiting' | 'succeeded' }
  | { readonly kind: 'error'; readonly code: 'execution_failed' | 'limit_exceeded' | 'stopped' | 'lease_lost' | 'not_authorized' | 'invalid_checkpoint' }
  | { readonly kind: 'usage'; readonly usage: AgentUsage };
export type AgentOutcome = 'succeeded' | 'failed' | 'waiting' | 'cancelled' | 'busy' | 'stopped' | 'retryable';
class Halt extends Error { constructor(readonly code: 'limit_exceeded' | 'stopped') { super(code); } }
class Reconcile extends Error { constructor(readonly call: AgentCall) { super('reconciliation_required'); } }
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

/** OpenAI owns all model/tool orchestration. The surrounding dispatch loop only
 * checkpoints SDK interruptions and applies host decisions. No legacy engine.
 * All local tools interrupt BEFORE execution, so a crash cannot invent a new
 * mutation identity. Hosted tools/handoffs are deliberately not accepted here. */
export function createAgentRuntime(deps: {
  readonly definitionRef: string;
  readonly instructions: string;
  readonly model: Model;
  /** Explicit host-approved sampling only. Omitted for models that reject it.
   * Never copy legacy request.generation wholesale into this boundary. */
  readonly sampling?: { readonly temperature?: number; readonly topP?: number };
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
  if (deps.sampling && Object.values(deps.sampling).some(v => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))) throw Error('AGENT_SAMPLING_INVALID');
  if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v <= 0)
    || limits.maxToolCalls > 256 || limits.maxStateBytes > 65_536 || limits.pollMs * 3 >= limits.leaseTtlMs
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deps.definitionRef)
    || new Set(deps.tools.map(t => t.name)).size !== deps.tools.length) throw Error('AGENT_CONFIG_INVALID');
  // Upstream has a process-wide logging switch; enforce its stricter setting.
  setSensitiveDataLoggingEnabled(false);
  let stopped = false;
  const active = new Set<AbortController>();
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let record: AgentCheckpoint | null = null;
    let persisted: AgentCheckpoint | null = null;
    let save: ((change?: AgentCommit) => Promise<void>) | undefined;
    let fatal: unknown;
    try {
      let snapshot = await load(identity);
      if (['succeeded', 'failed', 'cancelled', 'waiting'].includes(snapshot.state))
        return { ok: true, value: snapshot.state as AgentOutcome };
      fence = unwrap(await deps.lease.claim(identity, limits.leaseTtlMs));
      if (!fence) return { ok: true, value: 'busy' };
      active.add(controller);
      timer = setTimeout(() => controller.abort(), limits.maxElapsedMs);
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
      if (record && record.definitionRef !== deps.definitionRef) throw new StoreFailure('invalid_checkpoint');
      record ??= { version: 0, definitionRef: deps.definitionRef, dispatches: 0,
        input: await deps.host.input(copy(identity)), results: {} };
      save = async (change = { kind: 'checkpoint' }) => {
        await check();
        if (size(record) > limits.maxStateBytes) throw new Halt('limit_exceeded');
        const next = { ...record!, version: record!.version + 1 };
        await authorized(identity, authority => deps.states.commit(identity, record!.version, next, change,
          { authority, fence: fence!, now: () => deps.host.now() }));
        record = next; persisted = next;
      };
      if (record.dispatches >= limits.maxDispatches || size(record.input) > limits.maxContextBytes) throw new Halt('limit_exceeded');
      record = { ...record, dispatches: record.dispatches + 1 };
      await save();
      const callFor = (name: string, callId: string, input: Record<string, unknown>): AgentCall => ({
        identity: copy(identity), toolName: name, callId, input,
        effectRef: `agent:${digest([identity, callId, name])}`,
      });
      const visible = deps.host.visibleTools ? await deps.host.visibleTools(copy(identity), deps.tools.map(t => t.name)) : deps.tools.map(t => t.name);
      const tools = deps.tools.filter(t => visible.includes(t.name));
      const agent = new Agent({ name: deps.definitionRef, instructions: deps.instructions, model: deps.model,
        modelSettings: { ...(deps.sampling?.temperature === undefined ? {} : { temperature: deps.sampling.temperature }),
          ...(deps.sampling?.topP === undefined ? {} : { topP: deps.sampling.topP }), parallelToolCalls: false, maxTokens: 2048, store: false, retry: { maxRetries: 0 } },
        tools: tools.map(def => tool({ name: def.name, description: def.description, parameters: def.parameters,
          needsApproval: true, errorFunction: null,
          execute: async (input, _context, details) => {
            try {
              if (fatal) throw fatal;
              await check();
              if (!details?.toolCall?.callId) throw Error('missing_call');
              const call = callFor(def.name, details.toolCall.callId, input);
              const binding = digest([call.toolName, call.input]);
              return await deps.host.withToolAuthority(call, async () => {
                await check();
                const prior = record!.results[call.effectRef];
                if (prior) {
                  if (prior.binding !== binding) throw Error('call_conflict');
                  return prior.output;
                }
                if (Object.keys(record!.results).length >= limits.maxToolCalls) throw new Halt('limit_exceeded');
                let output: string;
                if (def.kind === 'vault') {
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
                    ? await abortable(def.readResult(call, observation, controller.signal), controller.signal)
                    : JSON.stringify(observation);
                } else {
                  try { output = await abortable(def.execute(call, controller.signal), controller.signal); }
                  catch { output = '{"error":"tool_failed"}'; }
                }
                await check();
                if (typeof output !== 'string' || size(output) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
                record = { ...record!, results: { ...record!.results, [call.effectRef]: { binding, output } } };
                await save!();
                emit({ kind: 'tool_completed' });
                return output;
              });
            } catch (error) { fatal = error; throw Error('AGENT_TOOL_HALTED'); }
          },
        })),
      });
      const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false,
        toolExecution: { maxFunctionToolConcurrency: 1 }, toolNameCollisionPolicy: 'error',
        toolErrorFormatter: () => 'Tool request rejected.',
        callModelInputFilter: async ({ modelData }) => {
          await check();
          if (size(modelData) > limits.maxContextBytes) throw new Halt('limit_exceeded');
          const prepared = deps.host.prepareModelInput
            ? { ...modelData, input: await deps.host.prepareModelInput(copy(identity), copy(modelData.input), controller.signal) }
            : modelData;
          await check();
          if (size(prepared) > limits.maxContextBytes) throw new Halt('limit_exceeded');
          return prepared;
        },
      });
      let state: RunState<unknown, typeof agent> | undefined = record.state ? await RunState.fromString(agent, record.state) : undefined;
      state?.clearTrace();
      if (state && record.resolution?.input) {
        state.addInput(record.resolution.input);
        // Save the staged input and clear it atomically, before any model call.
        record = { ...record, state: state.toString(), resolution: { receiptRef: record.resolution.receiptRef } };
        await save();
      }
      const invoke = (input: AgentInput | RunState<unknown, typeof agent>) => runner.run(agent, input, {
        stream: true, maxTurns: limits.maxTurns, signal: controller.signal,
      });
      for (;;) {
        await check();
        if (state) {
          for (const interruption of state.getInterruptions()) {
            const def = tools.find(t => t.name === interruption.name);
            if (!def) throw Error('tool_changed');
            const raw = interruption.rawItem;
            if (raw.type !== 'function_call') throw Error('unsupported_tool');
            const input = def.parameters.parse(JSON.parse(raw.arguments));
            const call = callFor(def.name, raw.callId, input);
            const decision = await deps.host.decide(call, record!.resolution);
            if (decision === 'approve') state.approve(interruption);
            else if (decision === 'reject') state.reject(interruption, { message: 'Host declined this action.' });
            else {
              // Keep the UNAPPROVED persisted state: decisions are reauthorized on wake.
              await save({ kind: 'waiting', requirement: decision });
              emit({ kind: 'waiting' });
              return { ok: true, value: 'waiting' };
            }
          }
        }
        const result: Awaited<ReturnType<typeof invoke>> = await invoke(state ?? record!.input);
        await abortable((async () => {
          for await (const event of result) {
            if (event.type === 'raw_model_stream_event') emit({ kind: 'model_progress' });
          }
          await result.completed;
        })(), controller.signal);
        if (result.error) throw Error('provider_failed');
        await check();
        state = result.state;
        const u = result.runContext.usage;
        const usage = { requests: u.requests, inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens };
        record = { ...record!, state: result.state.toString(), usage, resolution: undefined };
        if (result.interruptions.length) {
          await save();
          emit({ kind: 'checkpoint' });
          emit({ kind: 'usage', usage });
          continue;
        }
        if (typeof result.finalOutput !== 'string') throw Error('missing_output');
        const output = await deps.host.output(copy(identity), result.finalOutput);
        if (size(output.text) > limits.maxOutputBytes) throw new Halt('limit_exceeded');
        record = { ...record, output: output.text };
        await save({ kind: 'succeeded', receiptRef: output.receiptRef });
        emit({ kind: 'usage', usage }); emit({ kind: 'succeeded' });
        return { ok: true, value: 'succeeded' };
      }
    } catch (caught) {
      const error = fatal ?? caught;
      if (error instanceof Reconcile && save) {
        try {
          await save({ kind: 'waiting', requirement: deps.host.requirement(error.call, 'reconciliation') });
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
        : error instanceof Halt ? error.code : 'execution_failed';
      emit({ kind: 'error', code });
      if (error instanceof StoreFailure) return { ok: false, code: error.code };
      if (!fence) return { ok: false, code: 'not_authorized' };
      return { ok: true, value: controller.signal.aborted || stopped ? 'stopped' : 'retryable' };
    } finally {
      controller.abort(); clearTimeout(timer); clearTimeout(heartbeat);
      await renewal;
      active.delete(controller);
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
