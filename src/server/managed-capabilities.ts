import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { JobIdentity, JobRequirement, JobSnapshot } from '../contracts/job.js';
import { validateJobCommand } from '../contracts/job.js';
import { createAgentRuntime, type AgentRuntimeTool, type AgentCall } from './agent-runtime.js';
import { createEffects, type EffectRequest } from './effects.js';
import { createJobAnswer } from './answer.js';
import { createEffectStore, createJobAnswerStore, createJobJournal, migrateAgentPostgres } from './postgres/index.js';
import type { AgentStateKeys } from './postgres/keys.js';
import { managedStore, canonicalScope, type Scope } from './managed/store.js';
import type { HostedAction, HostedActionResult } from './hosted-session.js';
import { hostedApprovalNotice, hostedApprovalPage, hostedApprovalResponse } from './managed/hosted-approval.js';
interface PrivateAccount { label: string; url: string; origins: string[]; username: string; password: string; approved: boolean; revoked: boolean; expiresAt: number }
import { website } from './managed/network.js';
import { portalPage, portalHeaders } from './managed/portal.js';
import { credentialResponse, validateCredentialSelection, type CredentialSelection, type ManagedCredentialProvider } from './managed/credentials.js';
export type { CredentialRequest, CredentialSelection, ManagedCredentialProvider } from './managed/credentials.js';

export interface ManagedAgentCapabilitiesOptions {
  readonly database: Pool;
  readonly schema: string;
  readonly keys: AgentStateKeys;
  /** Absolute public HTTPS mount URL, e.g. https://app.example.com/agent-access. */
  readonly baseUrl: string;
  /** Existing authenticated application session -> complete current SDK scope.
   * Never derive this scope from request parameters, the link, or a model. */
  readonly authenticate: (request: Request) => Promise<Scope | null>;
  /** Rebind the original persisted job after process recovery or observer cleanup.
   * Called only after authentication and matching encrypted interaction scope.
   * Register through this service's createRuntime; do not submit a new job. */
  readonly restoreRuntime?: (identity: JobIdentity) => Promise<void>;
  /** Let the host's canonical scheduler observe the saved answer. The answer is
   * already durable; retries must retain the original job/conversation identity. */
  readonly onAnswered?: (identity: JobIdentity) => Promise<void>;
  readonly features?: { readonly vault?: boolean; readonly browser?: boolean };
  readonly credentialProvider?: ManagedCredentialProvider;
}
type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type ManagedResult = { output: string; wait?: JobRequirement; notice?: string; reconciliation?: boolean };
interface Interaction { identity: JobIdentity; ref: string; accountRef: string; label: string; url: string;
  kind: 'credentials' | 'hosted'; csrf: string; expiresAt: number; completed: boolean;
  credentialSelection?: CredentialSelection;
  action?: Extract<HostedAction, { type: 'computer_use_approval_request' }>; response?: HostedActionResult }
interface Operation { call: AgentCall; phase: 'prepared' | 'started' | 'complete'; result?: ManagedResult }
const equal = (a: Scope, b: Scope) => canonicalScope(a) === canonicalScope(b);
const ref = z.string().uuid();
const safeError = (stage = 'request') => new Response('Account access is unavailable. Return to your conversation.', { status: 403, headers: { 'Cache-Control': 'no-store', 'X-Handrail-Agent-Input-Error': stage } });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
class AnswerDeliveryError extends Error { constructor(readonly stage: string) { super('CAPABILITY_ANSWER_UNAVAILABLE'); } }
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => { if (!r.ok) throw Error('CAPABILITY_UNAVAILABLE'); return r.value; };

/** Batteries-included SDK service. The application mounts handleRequest and
 * uses createRuntime instead of createAgentRuntime. No app-owned browser, vault
 * store, secure form, grant adapter or tool catalog is required. */
export function createManagedAgentCapabilities(options: ManagedAgentCapabilitiesOptions) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password || base.pathname.endsWith('/')) throw Error('CAPABILITY_BASE_URL_INVALID');
  const flags = Object.freeze({ vault: options.features?.vault !== false, browser: options.features?.browser !== false });
  const store = managedStore(options.database, options.schema, options.keys);
  const journal = createJobJournal(options.database, options.schema);
  const effectsStore = createEffectStore(options.database, options.schema);
  const answerStore = createJobAnswerStore(options.database, options.schema);
  const runtimes = new Set<ReturnType<typeof createAgentRuntime>>();
  const registrations: Array<{ runtime: ReturnType<typeof createAgentRuntime>; host: RuntimeOptions['host']; definitionRef: string }> = [];
  const jobs = new Map<string, { runtime: ReturnType<typeof createAgentRuntime>; host: RuntimeOptions['host'] }>();
  const pending = new Set<Promise<unknown>>();
  const restoring = new Map<string, Promise<void>>();
  let closed = false;
  const requirement = (i: Interaction): JobRequirement => ({ kind: i.kind === 'credentials' || i.action?.request.type === 'browser_authentication' ? 'secure_input' : 'approval',
    requirementRef: `managed:${i.ref}`, revision: 1, actor: { kind: 'user', actorRef: i.identity.host.userRef } });
  async function authorizeJob(identity: JobIdentity): Promise<JobSnapshot> {
    const current = unwrap(await journal.load(identity));
    if (closed || current.state === 'cancelled' || current.state === 'failed') throw Error('CAPABILITY_JOB_STOPPED');
    if (!jobs.has(identity.jobId)) for (const candidate of registrations) {
      const a = await candidate.host.authorize(identity).catch(() => null);
      if (!a || !equal(a.host, identity.host)) continue;
      const inspected = await candidate.runtime.inspect(identity);
      if (inspected.ok && inspected.value.checkpoint?.definitionRef === candidate.definitionRef) { jobs.set(identity.jobId, candidate); break; }
    }
    if (!jobs.has(identity.jobId) && options.restoreRuntime) {
      let restore = restoring.get(identity.jobId);
      if (!restore) {
        restore = options.restoreRuntime(structuredClone(identity));
        restoring.set(identity.jobId, restore);
      }
      try { await restore; } finally { if (restoring.get(identity.jobId) === restore) restoring.delete(identity.jobId); }
      for (const candidate of registrations) {
        const a = await candidate.host.authorize(identity).catch(() => null);
        if (!a || !equal(a.host, identity.host)) continue;
        const inspected = await candidate.runtime.inspect(identity);
        if (inspected.ok && inspected.value.checkpoint?.definitionRef === candidate.definitionRef) { jobs.set(identity.jobId, candidate); break; }
      }
    }
    const bound = jobs.get(identity.jobId);
    if (!bound) throw Error('CAPABILITY_RUNTIME_UNAVAILABLE');
    const a = await bound.host.authorize(identity); if (!a || !equal(a.host, identity.host)) throw Error('CAPABILITY_AUTHORITY_LOST');
    return current;
  }
  async function interact(call: AgentCall, kind: Interaction['kind'], accountRef: string, label: string, url: string): Promise<ManagedResult> {
    const id = createHash('sha256').update(call.effectRef).digest('hex');
    const old = await store.get<Interaction>(call.identity.host, `interaction:${id}`);
    const i: Interaction = old?.value ?? { identity: call.identity, ref: id, accountRef, label, url, kind,
      csrf: randomBytes(32).toString('hex'), expiresAt: Date.now() + 900_000, completed: false };
    if (!old) await store.put(call.identity.host, `interaction:${id}`, i, 0);
    const link = `${base.href}/${id}`;
    return { output: JSON.stringify({ status: 'waiting_for_user', accountRef, secureUrl: link }), wait: requirement(i),
      notice: kind === 'credentials' ? `[Enter the account login securely](${link}). This task will continue after you save it. Do not send the password in chat.`
        : `[Help finish sign-in](${link}) to complete the step the website needs. Your task will continue when you return control.` };
  }
  async function perform(call: AgentCall, signal: AbortSignal, isCurrent: () => Promise<boolean>): Promise<ManagedResult> {
    const scope = call.identity.host, args = call.input;
    if (signal.aborted) throw Error('CAPABILITY_STOPPED');
    if (!await isCurrent()) throw Error('CAPABILITY_AUTHORITY_LOST');
    if (call.toolName === 'agent_connect_account') {
      const url = website(args.url as string);
      return interact(call, 'credentials', createHash('sha256').update(call.effectRef).digest('hex').slice(0, 8) + '-0000-4000-8000-' + createHash('sha256').update(call.effectRef).digest('hex').slice(8, 20), args.label as string, url.href);
    }
    const id = args.accountRef as string;
    return store.lock(scope, `account:${id}`, async () => {
      const row = await store.get<PrivateAccount>(scope, `account:${id}`);
      if (!row || row.value.revoked || !row.value.approved || row.value.expiresAt <= Date.now()) return { output: JSON.stringify({ status: 'account_access_required' }) };
      const account = row.value;
      if (call.toolName === 'agent_disconnect_account') {
        account.revoked = true; account.password = ''; account.username = '';
        await store.put(scope, `account:${id}`, account, row.version);
        return { output: JSON.stringify({ status: 'revoked', accountRef: id }) };
      }
      throw Error('CAPABILITY_TOOL_UNAVAILABLE');
    });
  }
  function createRuntime(deps: RuntimeOptions) {
    if (closed) throw Error('CAPABILITIES_CLOSED');
    const definitions: Array<{ name: string; description: string; parameters: AgentRuntimeTool['parameters'] }> = [];
    if (flags.vault) definitions.push(
      { name: 'agent_connect_account', description: 'Request a private SDK vault form for one account. Use a public HTTPS login page and a nonsecret person/account label. The user approves the website and enters their username/password privately. Never request credentials in chat. This pauses until the user saves access.', parameters: z.object({ label: z.string().min(1).max(80), url: z.string().url().max(2048) }).strict() },
      { name: 'agent_disconnect_account', description: 'Revoke saved browser access for an exact account only when the user asks to disconnect it. This removes saved credentials, not existing remote provider login sessions.', parameters: z.object({ accountRef: ref }).strict() },
    );
    let runtime: ReturnType<typeof createAgentRuntime>;
    const managed: AgentRuntimeTool[] = definitions.map(d => ({ ...d, kind: 'managed' as const,
      async execute(call, fence, signal): Promise<ManagedResult> {
        jobs.set(call.identity.jobId, { runtime, host: deps.host });
        const scope = call.identity.host, opKey = `operation:${call.effectRef}`;
        const effect: EffectRequest = { identity: call.identity, effectRef: call.effectRef, idempotencyRef: call.effectRef,
          actionRef: call.toolName, operationRef: 'managed-capability-v1', providerRef: 'sdk-managed-access',
          requestDigest: `sha256:${createHash('sha256').update(JSON.stringify([call.toolName, call.input, canonicalScope(scope)])).digest('hex')}` };
        const old = await store.get<Operation>(scope, opKey);
        if (!old) await store.put(scope, opKey, { call, phase: 'prepared' } satisfies Operation, 0);
        else if (JSON.stringify(old.value.call) !== JSON.stringify(call)) throw Error('CAPABILITY_CONFLICT');
        const effects = createEffects({ now: Date.now, withAuthority: async (_r, _phase, run) => {
          const a = await deps.host.authorize(call.identity);
          if (!a || !equal(a.host, scope) || signal.aborted) return { ok: false, code: 'not_authorized' };
          return run({ host: a.host, grantRevision: a.grantRevision, cancellationRevision: fence.cancellationRevision });
        } }, effectsStore, {
          async dispatch(_r, effectSignal) {
            const current = await store.get<Operation>(scope, opKey);
            if (!current || current.value.phase !== 'prepared') return { outcome: 'unknown' };
            await store.put(scope, opKey, { ...current.value, phase: 'started' }, current.version);
            try {
              const result = await perform(call, AbortSignal.any([signal, effectSignal]), async () => {
                const a = await deps.host.authorize(call.identity);
                return !!a && equal(a.host, scope) && a.grantRevision === fence.grantRevision && !signal.aborted && !effectSignal.aborted;
              });
              if (signal.aborted || effectSignal.aborted) return { outcome: 'unknown' };
              await store.put(scope, opKey, { ...current.value, phase: 'complete', result }, current.version + 1);
              return { outcome: 'verified', receiptRef: call.effectRef };
            } catch { return { outcome: 'unknown' }; }
          },
          async reconcile() {
            const r = await store.get<Operation>(scope, opKey);
            return r?.value.phase === 'complete' ? { outcome: 'verified', receiptRef: call.effectRef }
              : r?.value.phase === 'prepared' ? { outcome: 'not_applied', evidenceRef: call.effectRef } : { outcome: 'unknown' };
          },
        }, 30_000);
        const receipt = unwrap(await effects.execute(effect, fence));
        if (receipt.outcome !== 'verified') return { output: '', reconciliation: true };
        const result = (await store.get<Operation>(scope, opKey))?.value.result;
        if (!result) throw Error('CAPABILITY_RESULT_UNAVAILABLE');
        return result;
      },
    }));
    if (flags.vault) managed.push({ name: 'agent_accounts', description: 'List this user’s saved website accounts and their access status. Returns aliases and labels only, never logins or passwords.', kind: 'read', parameters: z.object({}).strict(),
      execute: async call => JSON.stringify((await store.list<PrivateAccount>(call.identity.host, 'account:')).map(r => ({ accountRef: r.id.slice(8), label: r.value.label, website: new URL(r.value.url).origin,
        status: r.value.revoked || r.value.expiresAt <= Date.now() ? 'access_required' : 'connected' }))) });
    const names = new Set(managed.map(t => t.name));
    runtime = createAgentRuntime({ ...deps, harness: { ...deps.harness,
      browser: flags.browser && deps.harness.browser !== false,
      async action(identity, action) {
        if (action.type !== 'computer_use_approval_request') return deps.harness.action(identity, action);
        if (!flags.browser || deps.harness.browser === false) throw Error('BROWSER_DISABLED');
        jobs.set(identity.jobId, { runtime, host: deps.host });
        await authorizeJob(identity);
        const id = createHash('sha256').update(JSON.stringify([identity, action.request_id])).digest('hex');
        const old = await store.get<Interaction>(identity.host, `interaction:${id}`);
        if (old && JSON.stringify(old.value.action) !== JSON.stringify(action)) throw Error('CAPABILITY_CONFLICT');
        if (old?.value.completed && old.value.response) {
          if (old.value.credentialSelection && action.request.type === 'browser_authentication') {
            const input = { identity, requestId: action.request_id, request: action.request };
            const values = await options.credentialProvider?.resolve(input, old.value.credentialSelection);
            await authorizeJob(identity);
            if (!values) throw Error('CREDENTIAL_AUTHORITY_LOST');
            return credentialResponse(input, old.value.credentialSelection, values);
          }
          if (old.value.accountRef) {
            const account = await store.get<PrivateAccount>(identity.host, `account:${old.value.accountRef}`);
            if (!account || account.value.revoked || !account.value.approved || account.value.expiresAt <= Date.now()
              || !account.value.origins.includes(old.value.url)) throw Error('ACCOUNT_AUTHORITY_LOST');
          }
          return old.value.response;
        }
        const i: Interaction = old?.value ?? { identity, ref: id, accountRef: '', label: 'browser access',
          url: action.request.type === 'browser_origin_access' ? action.request.origin : action.request.credential_origin ?? '',
          kind: 'hosted', action, csrf: randomBytes(32).toString('hex'), expiresAt: Date.now() + 900_000, completed: false };
        if (!old) await store.put(identity.host, `interaction:${id}`, i, 0);
        if (!old && flags.vault && options.credentialProvider && action.request.type === 'browser_authentication'
          && action.request.credential_origin) {
          const input = { identity, requestId: action.request_id, request: action.request };
          // A rejected login must return control to the private form, not loop
          // through passwords. Claim once per original job and exact origin,
          // before calling the provider; recovery never creates another attempt.
          const attemptKey = `credential-attempt:${createHash('sha256').update(JSON.stringify([identity.jobId, i.url])).digest('hex')}`;
          const claimed = await store.lock(identity.host, attemptKey, async () => {
            if (await store.get(identity.host, attemptKey)) return false;
            await store.put(identity.host, attemptKey, { requestId: action.request_id }, 0);
            return true;
          });
          if (claimed) {
            const selection = await options.credentialProvider.select(input);
            await authorizeJob(identity);
            if (selection) {
              validateCredentialSelection(input, selection);
              const values = await options.credentialProvider.resolve(input, selection);
              await authorizeJob(identity);
              if (values) {
                const response = credentialResponse(input, selection, values);
                await store.put(identity.host, `interaction:${id}`, { ...i, completed: true,
                  credentialSelection: selection, response }, 1);
                return response;
              }
            }
          }
        }
        return { requirement: requirement(i), notice: hostedApprovalNotice(action, `${base.href}/${id}`) };
      },
    }, limits: { ...deps.limits, leaseTtlMs: Math.max(deps.limits.leaseTtlMs, 90_000) },
      tools: [...deps.tools, ...managed], host: { ...deps.host,
      async decide(call, resolution) {
        if (names.has(call.toolName)) await authorizeJob(call.identity);
        return deps.host.decide ? deps.host.decide(call, resolution) : 'approve';
      },
      async withToolAuthority(call, run) {
        if (!names.has(call.toolName)) return deps.host.withToolAuthority(call, run);
        jobs.set(call.identity.jobId, { runtime, host: deps.host });
        return deps.host.withToolAuthority(call, async () => {
          await authorizeJob(call.identity);
          const result = await run(); await authorizeJob(call.identity); return result;
        });
      },
      async resolveWait(snapshot) {
        if (!snapshot.requirement.requirementRef.startsWith('managed:')) return deps.host.resolveWait(snapshot);
        const id = snapshot.requirement.requirementRef.slice(8), i = await store.get<Interaction>(snapshot.identity.host, `interaction:${id}`);
        if (!i?.value.completed || snapshot.answer?.responseRef !== `managed-answer:${id}`) return null;
        return { receiptRef: snapshot.answer.responseRef, input: 'The user responded to the private access step. Continue the original task using the provider result. Do not ask for credentials in chat.' };
      },
    } });
    const resume = runtime.resume;
    runtime.resume = async identity => {
      const snapshot = await journal.load(identity);
      if (snapshot.ok && snapshot.value.state === 'waiting' && !snapshot.value.answer
        && snapshot.value.requirement.requirementRef.startsWith('managed:')) {
        const id = snapshot.value.requirement.requirementRef.slice(8);
        const saved = await store.get<Interaction>(identity.host, `interaction:${id}`);
        if (saved?.value.completed) await complete(saved.value, false);
        else {
          // An unanswered private step is an ordinary wait, not a rejected
          // attempt to resume execution. Recheck authority before leaving it.
          await authorizeJob(identity);
          return {ok: true as const, value: undefined};
        }
      }
      return resume(identity);
    };
    const stop = runtime.stop;
    runtime.stop = async () => {
      runtimes.delete(runtime);
      const index = registrations.findIndex(r => r.runtime === runtime);
      if (index >= 0) registrations.splice(index, 1);
      for (const [id, registered] of jobs) if (registered.runtime === runtime) jobs.delete(id);
      await stop();
    };
    runtimes.add(runtime); registrations.push({ runtime, host: deps.host, definitionRef: deps.definitionRef }); return runtime;
  }
  async function complete(input: Interaction, notify = true) {
    // Approval is already durable. Serialize retry/expiry renewal with the same
    // private record; never ask for the response again or manufacture a new job.
    await store.lock(input.identity.host, `account:${input.accountRef}`, async () => {
      const key = `interaction:${input.ref}`;
      const saved = await store.get<Interaction>(input.identity.host, key);
      if (!saved?.value.completed) throw Error('CAPABILITY_RESPONSE_NOT_SAVED');
      let i = saved.value;
      const current = await authorizeJob(i.identity);
      if (current.state !== 'waiting' || current.requirement.requirementRef !== requirement(i).requirementRef) throw Error('CAPABILITY_WAIT_CHANGED');
      const answers = createJobAnswer({ now: Date.now, withAnswerAuthority: async (_id, actor, _op, run) => {
        const state = await authorizeJob(i.identity);
        if (state.state !== 'waiting' || actor !== i.identity.host.userRef) return { ok: false, code: 'not_authorized' };
        const active = jobs.get(i.identity.jobId);
        if (!active) return { ok: false, code: 'not_authorized' };
        return active.host.withAuthority(i.identity, 'append', run);
      } }, answerStore);
      if (current.answer?.responseRef !== `managed-answer:${i.ref}`) {
        if (i.expiresAt <= Date.now()) {
          i = { ...i, expiresAt: Date.now() + 900_000 };
          await store.put(i.identity.host, key, i, saved.version);
        }
        const issued = await answers.issue({ identity: i.identity, requirement: requirement(i), jobRevision: current.revision,
          expiresAt: i.expiresAt, resolverRef: i.identity.host.userRef });
        if (!issued.ok) throw new AnswerDeliveryError(`answer_issue_${issued.code}`);
        const delivered = await answers.complete({ identity: i.identity, requirementRef: requirement(i).requirementRef, requirementRevision: 1,
          resolverRef: i.identity.host.userRef, deliveryKey: `managed:${i.ref}`, status: 'verified', responseRef: `managed-answer:${i.ref}` });
        if (!delivered.ok) throw new AnswerDeliveryError(`answer_complete_${delivered.code}`);
      }
    });
    const i = input;
    if (!notify) return;
    if (options.onAnswered) {
      await options.onAnswered(structuredClone(i.identity));
      return;
    }
    const registered = jobs.get(i.identity.jobId);
    if (registered) {
      const work = (async () => { const result = await registered.runtime.resume(i.identity); if (result.ok) await registered.runtime.wake(i.identity); })().catch(() => {});
      pending.add(work); void work.finally(() => pending.delete(work));
    }
  }
  /** A trusted host may collect a nonsecret website decision through another
   * authenticated surface (for example an explicit reply to its notification).
   * This never exposes or accepts authentication fields. The host supplies the
   * authenticated scope, not a model-selected actor or a bearer link. */
  async function browserOriginAccess(identity: JobIdentity, actor: Scope, requirementRef: string) {
    if (!flags.browser || !equal(identity.host, actor)) throw Error('CAPABILITY_AUTHORITY_LOST');
    const current = await authorizeJob(identity);
    if (current.state !== 'waiting' || current.requirement.kind !== 'approval'
      || current.requirement.requirementRef !== requirementRef) throw Error('CAPABILITY_WAIT_CHANGED');
    const id = requirementRef.slice('managed:'.length);
    if (!requirementRef.startsWith('managed:')) throw Error('CAPABILITY_WAIT_CHANGED');
    const saved = await store.get<Interaction>(actor, `interaction:${id}`);
    if (!saved || JSON.stringify(saved.value.identity) !== JSON.stringify(identity)
      || saved.value.kind !== 'hosted' || saved.value.action?.request.type !== 'browser_origin_access')
      throw Error('CAPABILITY_WAIT_CHANGED');
    return saved;
  }
  async function readBrowserOriginAccess(identity: JobIdentity, actor: Scope, requirementRef: string) {
    const {value} = await browserOriginAccess(identity, actor, requirementRef);
    return {requirementRef, origin: value.action!.request.type === 'browser_origin_access' ? value.action!.request.origin : '',
      answered: value.completed};
  }
  async function answerBrowserOriginAccess(identity: JobIdentity, actor: Scope, input: {
    requirementRef: string; decision: 'approve' | 'deny' | 'cancel'; sourceRef: string;
  }) {
    if (!input.sourceRef?.trim()) throw Error('CAPABILITY_REPLY_SOURCE_REQUIRED');
    const initial = await browserOriginAccess(identity, actor, input.requirementRef);
    const answered = await store.lock(actor, `account:${initial.value.accountRef}`, async () => {
      const fresh = await browserOriginAccess(identity, actor, input.requirementRef);
      const response = hostedApprovalResponse(fresh.value.action!, {decision: input.decision});
      if (fresh.value.completed) {
        if (JSON.stringify(fresh.value.response) !== JSON.stringify(response)) throw Error('CAPABILITY_CONFLICT');
        return fresh.value;
      }
      const value = {...fresh.value, completed: true, response, replySourceRef: input.sourceRef};
      await authorizeJob(identity);
      await store.put(actor, `interaction:${value.ref}`, value, fresh.version);
      return value;
    });
    await complete(answered, false);
    return {requirementRef: input.requirementRef, decision: input.decision, status: 'saved' as const};
  }
  async function handleRequest(request: Request): Promise<Response> {
    // Fixed nonsecret stages make production failures diagnosable without
    // exposing URLs, provider payloads, credentials, CSRF, or exception text.
    let stage = 'request';
    const fail = () => safeError(stage);
    try {
      if (closed || (!flags.vault && !flags.browser)) return new Response('Not found', { status: 404 });
      const url = new URL(request.url), prefix = `${base.pathname}/`;
      if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.search || !/^[a-f0-9]{64}$/.test(url.pathname.slice(prefix.length))) return new Response('Not found', { status: 404 });
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      stage = 'authentication';
      const scope = await options.authenticate(request);
      if (!scope || !validateJobCommand({ command: 'inspect', identity: { jobId: 'scope-check', originTaskRef: 'scope-check', requestKey: 'scope-check', instructionRevision: 1,
        host: scope, native: { requestRef: 'scope-check' }, origin: { channelRef: 'scope-check', routeRef: 'scope-check', correlationRef: 'scope-check' } } }).ok) return fail();
      stage = 'interaction';
      const id = url.pathname.slice(prefix.length), key = `interaction:${id}`, found = await store.get<Interaction>(scope, key);
      if (!found || !equal(found.value.identity.host, scope)) return fail();
      if (found.value.kind !== 'credentials' && found.value.kind !== 'hosted') return fail();
      let i = found.value;
      stage = 'job_authority';
      const current = await authorizeJob(i.identity);
      if (i.completed) {
        stage = 'answer_delivery';
        if (current.state === 'waiting' && current.requirement.requirementRef === requirement(i).requirementRef) await complete(i);
        return new Response('Access saved. You can return to your conversation.', { headers: portalHeaders('completed') });
      }
      if (current.state !== 'waiting' || current.requirement.requirementRef !== requirement(i).requirementRef) return fail();
      stage = 'feature';
      if (i.kind === 'hosted' ? !flags.browser : !flags.vault) return fail();
      if (request.method === 'GET') {
        stage = 'form_renewal';
        // The form lifetime is not a deadline for the original task. A current
        // authenticated owner may reopen its still-pending step after a restart
        // or delay. Rotate the CSRF token; never revive an expired submission.
        if (i.expiresAt <= Date.now()) i = await store.lock(scope, `account:${i.accountRef}`, async () => {
          const fresh = await store.get<Interaction>(scope, key);
          if (!fresh || fresh.value.completed) throw Error('CAPABILITY_WAIT_CHANGED');
          const active = await authorizeJob(fresh.value.identity);
          if (active.state !== 'waiting' || active.requirement.requirementRef !== requirement(fresh.value).requirementRef) throw Error('CAPABILITY_WAIT_CHANGED');
          if (fresh.value.expiresAt > Date.now()) return fresh.value;
          const renewed = { ...fresh.value, csrf: randomBytes(32).toString('hex'), expiresAt: Date.now() + 900_000 };
          await store.put(scope, key, renewed, fresh.version);
          return renewed;
        });
        stage = 'form_render';
        const nonce = randomBytes(18).toString('base64');
        const accounts = flags.vault && i.action?.request.type === 'browser_authentication' && i.action.request.credential_origin
          ? (await store.list<PrivateAccount>(scope, 'account:')).filter(a => a.value.approved && !a.value.revoked && a.value.expiresAt > Date.now()
            && a.value.origins.includes(i.action!.request.type === 'browser_authentication' ? i.action!.request.credential_origin! : ''))
            .map(a => ({ ref: a.id.slice(8), label: a.value.label })) : [];
        return new Response(i.kind === 'hosted' && i.action ? hostedApprovalPage({ action: i.action, csrf: i.csrf, path: url.pathname, nonce, accounts }) : portalPage({ ...i, kind: 'credentials', path: url.pathname, nonce }), { headers: portalHeaders(nonce) });
      }
      stage = 'submission';
      if (i.expiresAt <= Date.now()) return fail();
      if (request.headers.get('origin') !== base.origin || request.headers.get('sec-fetch-site') === 'cross-site') return fail();
      if (Number(request.headers.get('content-length') ?? 0) > 16384) return fail();
      const reader = request.body?.getReader(); if (!reader) return fail();
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const r = await reader.read(); if (r.done) break; length += r.value.length; if (length > 16384) { await reader.cancel(); return fail(); } chunks.push(r.value); }
      const text = Buffer.concat(chunks).toString('utf8');
      const form = request.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
      if (typeof form.csrf !== 'string' || form.csrf.length !== i.csrf.length || !timingSafeEqual(Buffer.from(form.csrf), Buffer.from(i.csrf))) return fail();
      let completed = false;
      stage = 'submission_commit';
      const response = await store.lock(scope, `account:${i.accountRef}`, async () => {
        const active = await authorizeJob(i.identity);
        if (active.state !== 'waiting' || active.requirement.requirementRef !== requirement(i).requirementRef || i.expiresAt <= Date.now()) return fail();
        const fresh = await store.get<Interaction>(scope, key);
        if (!fresh || fresh.value.completed) return json({ status: 'ready' });
        if (fresh.value.expiresAt <= Date.now() || fresh.value.csrf !== i.csrf) return fail();
        if (i.kind === 'credentials') {
          if (form.consent !== 'yes' || typeof form.username !== 'string' || !form.username || form.username.length > 512
            || typeof form.password !== 'string' || !form.password || form.password.length > 4096 || typeof form.origins !== 'string') return fail();
          const origins = [...new Set([website(i.url).origin, ...form.origins.split(/[\s,]+/).filter(Boolean).map((s: string) => {
            const u = website(s); if (u.origin !== s) throw Error('ORIGIN_INVALID'); return u.origin;
          })])];
          if (origins.length > 12) return fail();
          const account: PrivateAccount = { label: i.label, url: i.url, origins, username: form.username, password: form.password,
            approved: true, revoked: false, expiresAt: Date.now() + 30 * 86400000 };
          const old = await store.get<PrivateAccount>(scope, `account:${i.accountRef}`);
          await store.put(scope, `account:${i.accountRef}`, account, old?.version ?? 0);
        } else {
          if (!i.action) return fail();
          if (form.action === 'submit' && i.action.request.type === 'browser_authentication' && form.accountRef) {
            if (!flags.vault || typeof form.accountRef !== 'string') return fail();
            const account = await store.get<PrivateAccount>(scope, `account:${form.accountRef}`);
            if (!account || !account.value.approved || account.value.revoked || account.value.expiresAt <= Date.now()
              || !i.action.request.credential_origin || !account.value.origins.includes(i.action.request.credential_origin)) return fail();
            i.accountRef = form.accountRef;
            for (let n = 0; n < i.action.request.fields.length; n++) {
              const source = form[`source_${n}`];
              if (source === 'username' || source === 'password') form[`field_${n}`] = source === 'username' ? account.value.username : account.value.password;
              else if (source) return fail();
            }
          }
          i.response = hostedApprovalResponse(i.action, form);
        }
        await authorizeJob(i.identity);
        await store.put(scope, key, { ...i, completed: true }, fresh.version);
        completed = true;
        return new Response('Your response was saved securely. The assistant can continue. You can close this page.', { headers: portalHeaders('complete') });
      });
      // Release the account lock before waking a model that may use the account.
      stage = 'answer_delivery';
      if (completed) await complete(i);
      return response;
    } catch (error) { return error instanceof AnswerDeliveryError ? safeError(error.stage) : fail(); }
  }
  return { createRuntime, handleRequest, readBrowserOriginAccess, answerBrowserOriginAccess,
    /** For applications with an explicit tool allowlist. Current host authority
     * still governs every call; enabling a feature never bypasses it. */
    toolNames: Object.freeze([
      ...(flags.vault ? ['agent_accounts', 'agent_connect_account', 'agent_disconnect_account'] : []),
    ]),
    /** Explicit normal application bootstrap; no import-time DB or browser IO. */
    initialize: () => migrateAgentPostgres(options.database, options.schema),
    async status() { return { vault: flags.vault ? 'enabled' : 'disabled', browser: flags.browser ? 'provider_managed' : 'disabled' }; },
    async close() { closed = true; await Promise.allSettled([...runtimes].map(r => r.stop())); await Promise.allSettled(pending); },
  };
}
