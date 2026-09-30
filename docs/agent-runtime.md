# Integrating the OpenAI Agents runtime

The usable first step is a Node 22 trusted-server worker exported from
`handrail-agent-sdk/server/agents`. OpenAI Agents SDK 0.18.0 owns model response,
validated tool dispatch, tool-result continuation, streaming and RunState.
Handrail still owns durable admission, permissions, leases, cancellation,
answers, effects, scheduling, encrypted state and Vault custody.

## Installation and migration

Install the public HTTPS Git repository at the full committed SHA returned by
Handrail's commit/push step and refresh the host's normal lockfile. Do not use a
local path, copied distribution, tarball, branch, tag or registry package. The
upstream third-party `@openai/agents` and `zod` dependencies are exact npm pins.
Use `node tests/verify-git-install.mjs <sha>` after delivery to test normal
prepare, installed exports, lockfile and consumer types.

Replace the former `createReferenceWorker` / deterministic step callback with
`createAgentRuntime`; that executor and its fallback path have been removed.
The canonical public root replaces the unused copied consumer candidate.
No running customer worker is changed by this source migration.

The [headless example](../examples/headless.mts) compiles against package exports.
Inject a host-authorized `Model` (for example an official OpenAIProvider model
using the host's existing approved client). Never accept provider credentials,
identity, policy facts, tool registrations, grant objects or persisted RunState
from an application client. Change `definitionRef` whenever instructions,
schemas, tool meaning or model policy changes; old checkpoints then fail closed.

Implement `AgentRuntimeHost`, `AgentStateStore`, and the existing admission,
journal, lease and effect ports using the application's established services.
`reference/node/agent-state-store.ts` is a working PostgreSQL example. Apply
migration `0013_agent_run_states.sql` along with the earlier reference migrations
only in a host that chooses this reference schema. It stores AES-GCM envelopes
with job identity, version, grant and key reference in authenticated data. The
host supplies managed key custody and old key resolution; no keys are stored in
SQL. The reference schema is not Handrail's native task database.

## Execution and recovery

`start()` recovers host-listed admitted jobs; queue or schedule deliveries call
`wake(originalIdentity)`. Every delivery reauthorizes admission and claims a
cross-process lease. The runtime polls/renews it and propagates AbortSignal to
the Runner. It checks again before model calls, tools, persistence and output.
`withToolAuthority` must hold current authorization through callback and commit;
a catalog check or a stale approval is insufficient.

All local tools use the SDK's approval interruption as a durable execution
boundary, including automatically allowed read tools. The runtime persists the
SDK's unapproved RunState before asking host policy for each decision. This
small dispatch loop only saves interruptions and applies decisions; Runner owns
the model/tool loop. Hosted tools and handoffs are intentionally excluded because
they would bypass the local authorization/effect boundary.

A host decision is `approve`, `reject`, or a safe `JobRequirement`. A waiting
commit atomically stores state, appends the journal wait and releases ownership.
Use `createJobAnswer` for durable answer delivery. `resume(identity)` calls the
host's `resolveWait` against the current wait/answer and queues the same job in
one transaction. The host verifies actor, requirement, exact proposed action,
current grant, expiry and receipt. A schedule wake has the same obligation;
simply delivering a queue message cannot resolve an approval. Optional filtered
new input is staged once with `RunState.addInput`. Decisions are rechecked before
execution and are never sticky approvals for later model calls.

Mutation tools bind a validated model reference to a host-approved immutable
`EffectRequest`. `effectRef` and `idempotencyRef` must equal the runtime-provided
call identity. Keep the entire scope, request digest and provider namespace
stable. The existing effect service commits unknown before IO, then reconciles
under a row lock before dispatch. Only conclusive `not_applied` permits dispatch;
unknown produces a reconciliation wait. A successful result is reused on retry.
Cached tool results are still subject to current authorization. A reused model
call ID with different inputs is rejected.

`stop()` is process shutdown and preserves durable running work for another
process. User Stop uses `createJobCancellation.stop()`; it is terminal, revokes
the execution fence and cannot be resumed. Closing observation is neither.
Already-started remote actions cannot be undone; the original effect remains
unknown until an authorized read-only reconciler establishes its outcome.

Tool read failures return a fixed error result so Runner can seek an alternative.
Provider failures retain the last durable boundary for a later delivery. Limits
bound turns, dispatch attempts, tool calls, context bytes, state, output and wall
time. Context overflow fails closed instead of silently deleting tool/result
pairs. This is bounded-task readiness, not sustained unattended-run qualification.
No second chat-history store is maintained: RunState already owns the current
logical job's history. An OpenAI Session is appropriate for a later separately
scoped cross-job conversation requirement, which this assignment does not add.

## Secrets, output and observation

Only permitted model-visible input/results may enter the Runner. `read` tools
must be read-only and filter their output before returning. A `vault` tool binds
an opaque permitted-use reference to an existing `VaultOperation`, then calls
`createVaultUse.execute` with the current fence. The model never receives the
private value. The existing password/SSN/token/card destination, item grant,
expiry, browser document/profile lease and audit checks still apply. Resolve
persisted grants; do not rebuild changed requests from the latest job revision
on retry. `createPaymentFillExecutor` remains private browser filling, with no
payment gateway or charging requirement.

Tracing is disabled for every Runner and sensitive upstream logging is disabled
at construction (the upstream logging switch is process-wide). The observation
sink emits only lifecycle metadata and normalized cumulative SDK usage for
completed checkpoints. It does not forward raw streaming deltas, tool arguments,
provider errors or SDK trace IDs. Usage is not a billing ledger: interrupted
provider attempts without a usage response are unmeasured. Private checkpoints
can contain confidential model-visible data and need access controls, encryption,
retention and deletion in the host. Do not publish them as logs or artifacts.
Host `output` must verify task-specific evidence, filter terminal text and issue
an idempotent safe receipt; model success text alone is not verification.
State/output and the public terminal receipt commit atomically.

## Native integration boundaries

The mounted Handrail source currently has no imports of this SDK or implementations
of these exported ports. Its actual boundaries must be adapted, not replaced:

- `src/server/services/owner-assistant-tasks.js:createOwnerAssistantTaskService`
  rejects standalone `createTask`; admissions must stay with native Avery request
  and objective services. This SDK does not introduce a second native task queue.
- `src/server/services/owner-assistant-recurring-schedules.js`
  (`claimDueRecurringSchedules`, `createOwnerAssistantRecurringScheduleService`)
  owns persisted schedule facts. An adapter must resolve a wait then wake the
  original SDK identity; this change does not migrate Avery's scheduler.
- `src/server/services/user-vault.js:readUserVaultEntryForExecutor` returns decrypted
  values to private executors. It must be called only inside an authorized private
  Vault adapter; never register it as a model read tool.
- `src/server/services/avery-vault-question.js:resolveAveryVaultQuestionAnswer`
  binds native secure input. Map its accepted reference to `createJobAnswer` /
  `resolveWait` with current scope; never copy its secret payload into RunState.
- `src/server/services/owner-assistant-producer-effects.js:qualifyProducerEffects`
  verifies native work/publication facts. Those receipts cannot be substituted by
  a model's success text or a generic SDK receipt.

Native Vault/Marketing and general browser adapters remain integration work for
the selected host. Browser takeover, restoration, confidential observation and
artifact filtering need independent end-to-end qualification. No Handrail source,
controller, iMessage, deployed consumer or production database was changed.

For an existing approved OpenAI client, model setup is:

```ts
import { OpenAIProvider } from '@openai/agents';
const provider = new OpenAIProvider({ openAIClient: approvedServerClient, useResponses: true });
const model = await provider.getModel(hostApprovedModelName);
const worker = createHeadlessWorker({ ...hostPorts, model });
await worker.start();
// On process shutdown: await worker.stop(); await provider.close();
```

The adapter requests `store: false` and disables Runner model retries. Host client
transport configuration remains host-owned. A separate HTTP/SSE fixture exercises
this official provider/client path without contacting a live model. Inputs while
a job is actively running remain in the host's durable inbox; this runtime's
`resume` admits new input at a persisted wait. Do not turn later input into a
second admission or overwrite a checkpoint from a client request.

The additive state migration has no destructive down migration. Stop/drain the
new worker before a host rollback, retain the private states and effect ledger,
and reconcile outstanding effects. An old deterministic worker cannot recover
OpenAI states; never reintroduce it as an automatic fallback. Changes to the
pinned SDK serialization format need an explicit state migration or drain.
