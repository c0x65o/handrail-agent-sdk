# Integrating the OpenAI Agents runtime

The usable first step is a Node 22 trusted-server worker exported from
`handrail-agent-sdk/server/agents`. OpenAI Agents SDK 0.18.0 owns model response,
validated tool dispatch, tool-result continuation, streaming and RunState.
Handrail still owns durable admission, permissions, leases, cancellation,
answers, effects, scheduling, encrypted state and Vault custody.

For continuous context, scoped memory, native work return and opt-in paged
checkpoints, see [continuous conversations](continuous-conversation.md).

For the reusable schedule/watch, notification, canonical feedback and existing
application-gateway adapters, see [assistance composition](assistance.md).
For supported durable store composition, migrations and key custody, use the
[PostgreSQL guide](postgres-runtime.md) and
[complete application example](../examples/postgres-application.mts).

## Installation and migration

Install the public HTTPS Git repository at the full committed SHA returned by
Handrail's commit/push step and refresh the host's normal lockfile. Do not use a
local path, copied distribution, tarball, branch, tag or registry package. The
upstream third-party `@openai/agents` and `zod` dependencies are exact npm pins.
Use `node tests/verify-git-install.mjs <sha>` after delivery to test normal
prepare, installed exports, lockfile and consumer types.

### Consumer type and lock contract

The qualified runtime is Node 22.23.1. `engines.node >=22` expresses the runtime
floor; it does not qualify newer Node majors. For TypeScript 5.9.3 consumers,
pin `@types/node` to **22.20.4** in the application's own devDependencies. The
SDK's devDependency pin only controls its build during Git installation; it is
not inherited by applications. Strict NodeNext and ESNext/Bundler consumer
checks both run with `skipLibCheck: false`. The Bundler fixture also qualifies
`@types/node` **22.18.0**, direct `@openai/agents` **0.18.0** / `zod` **4.3.6**
dependencies, and the typed headless worker's provider/model/tool composition.
No other runtime/type version combination is qualified here.

A qualified application manifest contains these entries (replace the placeholders
with the full delivered SDK SHA and its frozen Assistant dependency SHA):

```json
{
  "type": "module",
  "dependencies": {
    "handrail-agent-sdk": "git+https://git@github.com/c0x65o/handrail-agent-sdk.git#FULL_40_CHARACTER_DELIVERED_SHA",
    "@handrail/ai-assistant": "git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#FULL_40_CHARACTER_ASSISTANT_SHA"
  },
  "devDependencies": {
    "@types/node": "22.20.4",
    "typescript": "5.9.3"
  }
}
```

If the application imports Agents or Zod directly, declare their exact versions
above as direct dependencies too. Do not depend on incidental npm hoisting for
application imports. The installed runtime qualification declares its OpenAI
client and PostgreSQL dependencies directly too.

The explicit `@handrail/ai-assistant` dependency selects npm's HTTPS resolution
for that shared package too. Pin it to the **same full Git SHA as the chosen
Agent SDK's dependency**.
Upgrade both pins and regenerate the consumer lock together. Combining an old
Agent SDK with a newer direct Assistant SDK can install two revisions whose
branded conversation/citation types are incompatible. Do not cast away these
errors. The current verifier derives the Assistant pin from this checkout's
manifest, preserves its SHA, and rejects mismatching nested lock entries.
Historical manifests under `docs/evidence` are frozen run records, not consumer
examples to upgrade or rerun as current acceptance; use the verifier to generate
fresh consumers for the selected committed SDK.

With npm 10.9.8, a bare public GitHub HTTPS URL becomes
`git+ssh://git@github.com/…` in the generated lock. Use the exact **HTTPS** URL
form above, including the literal `git@` username. This is a public transport
selector for npm's GitHub resolver, not an SSH URL, password, token, private key,
or new credential. The repository remains publicly readable without
credentials. npm/pacote preserves HTTPS when that username is present.

```sh
npm install --include=dev
GIT_ALLOW_PROTOCOL=https GIT_TERMINAL_PROMPT=0 npm ci --include=dev
```

Commit the application's manifest and generated lock together. The SDK manifest
dependency, root lock dependency, and SDK `resolved` lock entry must all equal
`git+https://git@github.com/c0x65o/handrail-agent-sdk.git#<full-sha>` exactly.
Do not hand-edit an SSH lock into apparent compliance: npm can canonicalize the
installed metadata back to SSH. Generate it with the HTTPS URL form instead.
`prepare` still builds the SDK during ordinary installation. npm may internally
download a GitHub archive over HTTPS for a Git dependency; the dependency and
lock remain full-SHA Git URLs, never tarball dependencies.

The authoritative verifier automates this sequence using **separate empty caches**
for install and `npm ci`, disables Git credentials/global rewrites and all Git
protocols except HTTPS, asserts the root and installed lock URLs exactly, then
checks installed exports, strict declarations and real installed Runner behavior.
It rejects SSH even when the SHA suffix matches. Neither lockfile is rewritten
by the test.

The unpinned failure is reproducible with:

```sh
node tests/verify-git-install.mjs 4d1f995e2bf337fb4ad9552bb675dade0f633fdb --reproduce-default
```

That diagnostic expects failure and is separate from the passing supported
matrix. `@types/ws` requests `@types/node: "*"`; without the application pin,
Node 26.6.3 declarations conflict with Agents 0.18.0 event-emitter overrides.
Do not suppress those errors, patch installed declarations, or widen the
runtime's supported type contract to Node 26.

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

Implement `AgentRuntimeHost` using the application's current identity, policy,
input, approval and domain services. For PostgreSQL, compose the supported
`createPostgresAgentStores` factories instead of implementing generic stores in
the application. Run the explicit additive migration API before workers and
provide host-controlled key handles; see the PostgreSQL guide above. Alternative
persistence engines may implement the existing store ports. These tables are not
Handrail's native task database.

### Application tool schemas

Pass the trusted application's complete `ToolDefinition[]` to
`createApplicationAgentTools` from `handrail-agent-sdk/server/application-tools`,
then pass its result directly to `createAgentRuntime`. Names, descriptions and
JSON Schemas are preserved. The SDK uses upstream raw JSON Schema tools with
`strict: false` and `needsApproval: true`. Optional members stay optional;
explicit null is accepted only where the original schema allows it. This is
the documented [non-strict function tool representation](https://openai.github.io/openai-agents-js/guides/tools/),
not strict Structured Outputs with nullable placeholders.

The model is not the validator. Ajv 8.20.0 with ajv-formats 3.0.1 compiles the
original schema once and validates both the durable interruption before
`host.decide` and the executed arguments before `withToolAuthority`, `read`,
`bind`, or any effect. Validation never coerces types, supplies defaults, strips
additional fields, or replaces null with absence. Thus `patch: {label: null}`
and `patch: {}` remain different calls and have different effect bindings.
Additional properties follow the application's schema (retained if allowed,
rejected if forbidden). Invalid arguments cannot reach application IO; malformed
JSON may become an upstream tool error that the model can correct. Other schema
failures leave the durable run retryable under the existing dispatch bounds.

Supported object-root schemas use JSON Schema 2020-12 (default, or explicit
`https://json-schema.org/draft/2020-12/schema`), 2019-09
(`https://json-schema.org/draft/2019-09/schema`), or draft-07
(`http://json-schema.org/draft-07/schema#`). This includes local references,
unions, intersections, nested optional members, pattern/format and numeric,
string, object and array constraints. Unknown dialects, keywords, formats,
unresolved references and asynchronous validators fail catalog construction;
no tools or fields are silently omitted. Remote reference fetching and custom
executable keywords are not enabled. See [Ajv dialects](https://ajv.js.org/json-schema.html)
and [data mutation options](https://ajv.js.org/guide/modifying-data.html).

Keep the original business validators and authorization in the host adapters.
JSON Schema cannot express every application refinement, transaction rule,
optimistic version check or permission. Validate the immutable intent during
binding and retain the existing domain executor's checks immediately before
mutation. `bind` must not dispatch a mutation. Reads and effects still run under
current host authority and the existing durable ledger.
An upstream provider that does not support non-strict function tools is not
qualified by this contract; do not silently fall back to a lossy strict schema.

Compatibility: existing host-authored `ZodObject` runtime tools retain their
strict upstream behavior. Application-generated tools now return
`AgentJsonSchemaParameters` in the `AgentRuntimeTool.parameters` union, exported
from `server/agents`. Both variants support `.parse(unknown)` returning
`Record<string, unknown>`; narrow with `'jsonSchema' in parameters` to inspect
the unchanged model schema. The application adapter no longer promises Zod
methods such as `.shape` or `.safeParse`. Do not hand the wrapper to upstream
`tool({parameters})`: it requires the runtime's non-strict representation and
validation boundary. Diagnostics should instantiate the public runtime and
assert the tools seen by its injected `Model`, as the catalog regression does.
This avoids comparing the application's Zod version structurally with the SDK's
Zod version. No consumer schema rewrite is required. Change `definitionRef`
when adopting the corrected schema semantics; reconcile old pending work via
the host's existing policy rather than replaying it under a changed definition.

### Structured application input and verified domain results

`AgentRuntimeHost.input` also accepts `AgentInputItem[]`. Hosts migrating an
existing conversation must preserve message roles and tool/result pairing rather
than concatenate history into one user message. The encrypted checkpoint retains
that structured input across approval waits and process recovery. Existing string
checkpoints remain compatible. These items are trusted host input, never a client
submission of an arbitrary Agent history. Existing context/state byte limits
still apply; this is not permission to store unbounded attachment bytes.

Multimodal references remain host-owned: resolve and authorize them immediately
before provider dispatch with the injected Model adapter. The runtime does not
authorize URLs, download attachments, or make a reference safe by accepting it.
Hosts must retain their existing owned-file checks and should retain opaque
references rather than expiring URLs or credentials in checkpoints.

An effect tool may supply `readResult(call, verifiedReceipt, signal)` to read the
canonical domain result after the effect service has verified its receipt. This
is useful when subsequent steps need the created record ID and current version.
The callback runs inside `withToolAuthority`, must only read/filter, and is bounded
by the existing result size limit. It may run again after a crash. An error must
not dispatch the mutation again; the effect ledger reuses its verified receipt.
Unknown effects still enter reconciliation and never call `readResult`. Omitting
the callback preserves receipt-only output. It does not replace host verification,
approval, authorization, or the effect ledger.

The published 0.1.5 assistance integration remains in Mills. The new durable
PostgreSQL composition requires its own pipeline-delivered public SHA before
adoption; candidate source qualification is not a consumer dependency upgrade.

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
Host input/pre-model preparation failures (for example unavailable attachment
storage) settle the job as failed under its current lease. Preparation is bounded
by the existing execution deadline; its expiry also settles failure. Diagnostics
contain only `preparation_failed` or `limit_exceeded`, never the private error.
Reconnect observes that terminal result without redispatch. Durable Stop,
revocation and uncertain effects remain authoritative; process shutdown leaves
unfinished work recoverable.

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

### Nonterminal execution exits at the conversation boundary

`createAgentConversationTransport` observes while its resume/wake attempt runs.
When that attempt returns or rejects, it makes a final fresh authorized read.
Canonical completion, cancellation, failure, and approval waits take precedence.
If the job remains nonterminal, the observation ends with `disconnected` and its
last applied checkpoint. This includes `retryable`, `busy`, process shutdown,
and authorization failures. A read begun before exit is not the final read.
A failed resume other than the normal non-waiting `invalid_transition` does not
start another wake. Existing runtime and host authorization fences still apply.

Direct consumers should reconnect/recover the same turn after disconnection;
a concurrent busy dispatch can finish separately. Observation close never means
explicit Stop and never grants approval. The AI durable wrapper must preserve a
disconnected delegate as pending, clear only its fenced observer claim, and use
its existing authenticated recovery path. Deploy both SDK corrections together:
an older wrapper treats disconnection as terminal failure. No journal, effect,
turn, or cancellation identity is reset, and no new timeout is introduced.
