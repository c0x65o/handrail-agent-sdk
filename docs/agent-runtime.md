# Hosted agent runtime

`handrail-agent-sdk/server/agents` exports `createAgentRuntime`. OpenAI’s hosted
Agents API owns the model/tool loop, persistent context, compaction and execution
environment. Handrail owns admission, conversation scope, native tool authority,
effect receipts, private checkpoints and delivery to the original conversation.
There is no application-run Runner or per-turn Responses inference fallback.

Use `harness`, not a model adapter:

```ts
const runtime = createAgentRuntime({
  definitionRef, instructions, harness,
  host, tools, admission, journal, lease, states, effects, limits,
});
```

The [typed PostgreSQL example](../examples/postgres-application.mts) shows the
native store/transport composition. See [managed access](managed-capabilities.md)
for the authenticated private browser forms and saved-account custody.

## Hosted harness ports

The required `AgentHostedHarness` supplies:

- `client`: the official OpenAI client with Agents API account access.
- `model`: current host-selected model. An idle existing session can update this
  setting without changing provider identity.
- `browser`: true by default. False omits the desktop and computer-use tool for a
  new session. Immutable configuration conflicts fail closed on an existing one.
- `session(identity, create)`: the original provider binding and durable save
  callback, under the existing admitted conversation writer.
- `input(identity, original, signal, {bootstrap})`: authorized provider input.
  Import canonical context once at cutover, then supply only the current admitted
  delta and new native returns. Provider user inputs support text and images;
  historical roles must be represented explicitly as imported context.
- `action(identity, action)`: current browser policy or a native owner-input wait.
  `createManagedAgentCapabilities` supplies registered authentication/origin forms.
- `item(identity, item)`: retain and project scoped screenshots/artifacts. Live
  screenshot bytes may be absent from later provider history; upsert by item ID
  without erasing already retained bytes.
- `usage(identity, turn)`: persist the exact terminal provider usage receipt before
  recording host success.
- Optional `resolveFile`: authorize and resolve opaque/URL native file results.
  The runtime never fetches arbitrary model-provided URLs as application credentials.

`handrail-agent-sdk/server/hosted` exports `createHostedSessionClient`,
`createHostedConversationStore` and `attachHostedFile`. The conversation store uses
existing encrypted `ConversationStorage` and `ConversationAuthority`; it does not
introduce a competing transcript or execution ledger. It performs CAS writes and
binds provider creation key, scope and session identity. The host must keep the
existing conversation writer for the entire admitted operation.

## Continuity and recovery

The durable application observer never ends an admitted or uncertain execution
because its connections have failed repeatedly. Its attempt limit applies only
to preparation proven not to have dispatched a delegate. Reconnect uses the
original identity until the provider settles or Stop is acknowledged. Runtime
errors expose fixed hosted error classifications and HTTP status only; private
provider bodies, browser content and tool arguments stay out of diagnostics.

Before session creation, save a creation intent with a unique metadata key. An
uncertain create is recovered by matching that exact metadata; never create a
replacement because an observer disconnected. Every admitted input has a durable
submission key, previous-turn baseline and eventual provider turn ID. Subscribe
to events before submission. Retry only with the original idempotency key and
reconcile provider state first.

Only a terminal root turn is terminal work. EOF, idle session status, an accepted
request and a queued operation are not completion. A completed provider response
is checkpointed before host output delivery; reconnect retries the idempotent
host commit without repeating model input or native effects.

Original serialized checkpoint schema 1.20 has a one-way import: retain input,
history, pending function call IDs and verified effect receipts; settle pending
calls under current authority, then create the hosted session. No legacy Runner
is started. Unsupported historical schemas or missing current tools fail
explicitly rather than starting the task again.

`runtime.stop()` detaches this process for recovery. Explicit user Stop must call
`runtime.cancelProvider(identity, signal)` while authority still exists, wait for
the original provider turn to settle, then commit `createJobCancellation.stop`.
Acceptance of a remote cancel is insufficient. Unknown input acceptance is an
explicit uncertainty, not successful cancellation. Never cancel a later turn to
satisfy an old Stop request. Delete a provider session only after active work is
terminal and required artifacts have been retained.

## Native tools and effects

The provider receives stable `handrail_list_tools` and `handrail_call_tool`
functions. Catalog lookup returns the current visible application tools and JSON
schemas. Invocation parses the exact named tool’s arguments, checks fresh scope
and approval, and uses the original provider call ID. A changed application
catalog does not require replacing the hosted session.

Tool kinds retain existing contracts: read, effect, vault, browser and managed.
The lower-level browser/vault ports are native application capabilities, not a
second model engine. The default managed browser is OpenAI computer use; the old
SDK-local Chromium controller and `agent_browser_*` tools are removed.

Mutation references derive from job identity, original call ID and tool name.
The effect ledger reconciles uncertain provider work before replay. Cached results
retain their input binding. A mismatched binding is a conflict. No model text,
URL, account alias or tool name can grant authority. `approvals: 'none'` removes
human decision callbacks only; admission, current scope, effect and cancellation
checks still apply.

Only adjacent independent read calls batch. `readConcurrency` bounds local reads;
mutations remain exclusive and ordered. A failing authority check or uncertain
effect fences subsequent native work. Read failures return a fixed nonsecret
error so the provider can choose another permitted action. Invalid arguments
return a structured `invalid_arguments` result without dispatch.

## Private state, files and metering

Checkpoint custody contains original input, exact submitted hosted input, provider
bindings, native results, optional file-copy receipts and terminal output. Use the
existing encrypted PostgreSQL stores and paged private envelopes. Public events
carry statuses/references, never checkpoint bodies or credentials. Do not enable
sensitive tracing or print provider event payloads.

Images remain images in native function results. Binary files are staged in the
original hosted environment, then represented by their workspace path. File
receipts bind session, environment, source digest, destination and size. Lost
upload responses reconcile the original destination without overwriting it.
Inline uploads support the provider's 5 MiB limit; authorized Files API references
support 50 MiB. A larger inline result must first use an authorized Files API
upload. Published output artifacts are bound to both session and turn before
download. The application still owns durable storage, authenticated download and
original-conversation delivery.

Use `createHostedTurnUsageReceipt` from `server/usage` for stable provider usage
receipts with actual input, cached input, output and reasoning tokens. Missing
provider measurements remain unavailable. Store the receipt before dispatching
the existing usage outbox. `AgentUsage.requests` counts completed hosted root
turns; it is not a fabricated count of the provider's internal model calls.

`maxDispatches`, `maxToolCalls` and `maxElapsedMs` accept null to disable optional
local execution cutoffs. Storage/IO bounds remain. The obsolete application Runner
`maxTurns` setting is removed. Do not introduce token budgets where the owner has
not authorized them.

## Validation

Run `npm run test:hosted` for transport, HTTP client, private forms, file recovery,
conversation binding and runtime tests. `node tests/run-local-postgres.mjs
 test:agents test:managed` runs real disposable PostgreSQL authority, effect,
restart, process-kill and private-input tests sequentially. The installed-consumer
fixture uses the same public SDK boundaries with a durable fake hosted provider.
Live account/provider tests must separately prove browser work, original artifact
delivery, retained context, interruption recovery, Stop and cleanup. A source test
or a version bump does not establish deployed consumer behavior.

Completed-turn artifacts can be retained with `retainHostedArtifacts` from
`server/hosted`. Supply the saved provider session binding, original terminal turn,
current native authority, the application's attachment byte capacity, and an
idempotent sink keyed by provider artifact ID. The helper reads only that turn's
published outputs, checks session/environment ownership and exact byte size, and
computes SHA-256 before calling the sink. Retain these outputs before publishing
application success or deleting the provider session. The final artifact list also
recovers outputs when a live screenshot event was missed; an environment path by
itself is not delivery to the originating conversation.
