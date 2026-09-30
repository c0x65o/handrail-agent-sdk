# Reusable assistance integration

This source milestone supplies a trusted Node server dependency. Mills web and
Flutter keep their existing application gateway/client protocol and share the
same backend. It is not an application cutover, live-flight qualification,
notification delivery qualification, or permission to deploy.

## Public composition

| Import from `handrail-agent-sdk/server/…` | API |
| --- | --- |
| `agents` | `createAgentRuntime`, `AgentInput`, `AgentRuntimeHost`, `AgentRuntimeTool`, `AgentStateStore` |
| `application` | `createAgentConversationTransport`, `createAgentCheckpointReader`, `AgentConversationHost` |
| `application-tools` | `createApplicationAgentTools`, `observeApplicationAgentTool` |
| `assistance` | `createAssistance`, `createAssistanceWorker`, `resolveScheduleTime`, `assistanceClock`, `assistanceDigest`, `AssistanceStore`, `AssistanceHost`, `ObservationAdapter` |
| `assistance/postgres` | `createPostgresAssistanceStore`, `assistancePostgresSchema`, `AssistanceDatabase` |
| `assistance/notifications` | `createNotificationDelivery` |
| `handrail-feedback` | `createHandrailFeedbackObserver`, `createHandrailFeedbackEffectAdapter`, `canonicalFeedbackReady`, `feedbackSubject`, `handrailFeedbackOperations` |

Admission, job leases, Stop, answers and effects remain the existing exports of
`handrail-agent-sdk/server`. No second model engine or effect ledger is added.
Factories start no services. The application owns its normal server lifecycle;
call `runtime.start()` to recover admitted jobs and start `createAssistanceWorker`
for shared timer/coalescing/drain behavior, or call `assistance.tick()` from an
existing durable queue. Stop the shared worker during graceful shutdown. Polling batch size bounds one scan, not how
many reminders a person can save. No 100-reminder or one-year limit is imposed.

The Agent runtime uses actual OpenAI Agents Runner, streamed model requests,
Zod validation and encrypted serialized RunState. Structured input and the prior
worker's verified-effect `readResult` extension are retained. The host can now
supply `visibleTools` on every reconstruction and `prepareModelInput` immediately
before every model dispatch. Catalog visibility never substitutes for execution
permission. The latter resolves and reauthorizes opaque attachment references;
it must not persist signed URLs, bytes, credentials or browser sessions.

## Existing gateway, tools and history

The dependency pins `@handrail/ai-assistant` via public HTTPS Git SHA
`97cb53daa35a0ce1bb06c3563e795e94371b17d2`, matching the inspected Mills gateway.
`createAgentConversationTransport<StreamEvent, ChatRequest>` is assignable to its
`ConversationTransport` and can be returned by `provider.createTransport`.
The application assistant already wraps that provider transport in its durable
turn writer, usage delivery and canonical conversation projection. Keep those
services and existing web/Flutter clients. Do not wrap a new provider tool loop
around the Agent runtime or feed model tool calls back into another engine.

Implement the small `AgentConversationHost` binding adapter:

1. `admit` transactionally binds the authenticated conversation/turn and exact
   input digest to `createJobAdmission`. The same turn/request returns the same
   job; changed payloads under the same identity conflict. Persist structured
   input privately. Client identity/correlation fields cannot create authority.
2. `lookup` checks current conversation ownership and returns that saved binding.
3. Use `createAgentCheckpointReader` for `read`. It derives stable validated
   `response.started`, verified final text, usage and terminal frames from durable
   state, using trusted stable job attribution. The existing gateway records
   and projects these frames. No new chat-history database is necessary. Text
   is released at verified completion, not as speculative token deltas. A custom
   `read` may project durable, filtered citations or presentation events instead.
4. `cancel` invokes the existing `createJobCancellation` with the current actor
   and journal revision. Closing an observer does not Stop execution. Reconnect
   only resolves a wait if `AgentRuntimeHost.resolveWait` verifies a saved answer
   for that exact proposal/action and current authority; it cannot approve work.
5. Native proposal call IDs should use `call.effectRef`, and the checkpoint
   reader's `pendingToolCallIds` maps the saved requirement back to those IDs.
   Keep `createJobAnswer` and the existing native proposal stores as the decision
   adapters. Rejected, stale, cross-user or changed-scope answers must fail closed.

`createApplicationAgentTools` converts the existing trusted JSON-schema tool
catalog to Runner tool definitions; applications supply read/mutation
classification, authorized reads and immutable effect bindings/results. Schema
conversion fails closed for unsupported constructs. Use the current native
catalog, not browser-supplied definitions. Change `definitionRef` when tool
schemas, meaning, instructions or provider policy changes; old incompatible
checkpoints then fail closed. Preserve dynamic Handrail catalog refresh and its
current-principal checks.

`observeApplicationAgentTool` bridges an authorized operation/result to the
existing `toolActivity` observer, retaining native tool progress, renderers and
result facts with stable execution IDs. The observer does not authorize or
idempotently execute a mutation. Mutations still use the existing SDK effect
ledger and domain confirmation services. It must not turn an uncertain remote
write into a new execution key.

Keep the existing canonical conversation store, renderer keys, citation policy,
attachment staging/ownership, transcription and realtime voice services, provider
wrapper and usage outbox. Text and voice must use the same trusted tool and
approval adapter. `observe` diagnostics are best effort and are **not** a durable
billing sink. Continue capturing per-invocation normalized receipts in the host's
injected Model/provider wrapper and its existing usage service. The checkpoint
reader exposes aggregate token usage; it does not invent costs, cached-token
counts, provider receipts or charge for a replay. Native voice transport and
rendered client parity still require application integration/QA.

## Durable schedules and observations

`createAssistance` owns create, reschedule, cancel, inspect, paged list/inbox,
due-work scanning, observation timeouts, stale handling, expiry, terminal states
and notification deduplication. Records contain opaque content/provider/subject
references, exact scope, and the original local date/time/IANA zone plus the
resolved UTC instant. Dates are not calculated by adding 24 hours. Nonexistent
DST wall times reject; repeated times require an explicit UTC offset. The stored
UTC instant is authoritative if timezone rules later change; explicit reschedule
recalculates it. This release implements one-shot schedules and condition watches;
recurring business occurrences can admit distinct one-shot identities.

A host `AssistanceDatabase` adapts its existing `query` and `transaction` methods.
The supplied PostgreSQL adapter owns row serialization, command idempotency,
receipts and inbox facts. Apply `assistancePostgresSchema(hostSchema)` through
normal additive host migrations, only after reviewing it. Construction never
creates a schema or changes a database. The host transaction must commit or roll
back the entire callback, retain database errors privately, and use independent
connections for concurrent transactions. The adapter uses PostgreSQL transaction
advisory locks for absent/present record serialization. Its scope includes tenant,
user, project, account, environment and purpose.

`AssistanceHost.withAuthority` derives scope from trusted context and holds current
account, membership and saved-mandate authority through each transaction. For a
permanently revoked mandate, an `observe` callback receives `false`: the SDK writes
terminal `revoked` without reading a provider or sending a notification. A
transient auth service failure throws and retains work. Regranting account access
does not reactivate a revoked record. Foreground reads/edits must also check the
current authenticated session. Keep private text in app custody; durable mandates
must not contain sessions/cookies. Chat deletion does not cancel a mandate.

The generic observation adapter returns `{subjectRef, status, observedAt,
evidenceRef, detailRef?}`. Status is `pending`, `delayed`, `matched`, `cancelled`,
`stale`, or `needs_input`. Wrong-subject, future, out-of-order, expired, missing or
failed observations cannot become a match. Poll/read deadlines are host-configured
operational limits. The first fresh match commits exactly one terminal inbox fact;
concurrent workers/reconstruction cannot repeat it. Updates and cancellation
serialize against observation and delivery. Cancellation cannot retract a fact
already committed or a remote effect already started.

A **real flight adapter still needs** an approved provider/account and its exact
occurrence identity (flight/service date, carrier and operating flight where
relevant, origin/destination), supported actual-arrival/landing field semantics,
source timestamp/revision, provider polling/expiry limits, and the authorized
recipient mandate. Map an actual observed landing to `matched`, a delay to
`delayed`, cancellation to `cancelled`, and stale/unavailable data to `stale`.
Scheduled/estimated arrival times must never count as observed landings. Generic
lifecycle fixtures supply none of those live-provider assurances. The same
adapter/state machine is tested with an industrial pump inspection consumer.

## Notification delivery

The inbox is the canonical notification fact. Existing clients may keep their
app-owned inbox read markers/UI and query `facts` using an opaque fact-ID cursor.
Remote delivery is separate. `createNotificationDelivery` accepts an inbox fact
and a trusted recipient/channel reference. Its `admit` adapter idempotently admits
a dedicated notification job via the existing admission service, resolving device
or email details privately and checking current permissions. Reuse that job on
retry; never create another job per attempt or use a completed chat job.

Its optional `pending` port is a thin paged SQL/destination query; `drain` owns
the delivery loop, including per-item failure isolation. The shared delivery service starts/renews the existing job lease, calls the
existing effect service, and completes the journal only after a verified receipt.
The effect ID derives from scope + fact ID + channel and survives all retries.
The complete bound fact, destination namespace and provider must stay immutable.
Do not turn a changed device token/account/provider into the old effect's meaning.

Effects commit unknown before IO. An uncertain response, crash or timeout cannot
prove non-delivery. Only read-only reconciliation that conclusively excludes all
prior/in-flight effects can establish `not_applied` and permit dispatch. Otherwise
retain `unknown` and surface it for reconciliation; never automatically resend.
A provider without such proof cannot promise automatic recovery of uncertain
push. Exactly-once canonical inbox facts are not exactly-once OS push/email.
Use the host's existing provider wrapper; no provider client or credentials ship
to browsers/mobile. This work sends no real notifications.

## Canonical Handrail feedback

`createHandrailFeedbackEffectAdapter` uses existing MCP v2 discovery plus the
canonical bug/enhancement reporter operations. Bind approved immutable private
submission input to an `EffectRequest` in the existing ledger. Supply fresh Known
User/exact-runtime clients, persisted receipt lookup/save, and conclusive
`notApplied` reconciliation. It overwrites bug `event_id` / enhancement
`idempotency_key` with the original SDK effect identity and persists the canonical
bug/enhancement ID after a response. No developer Work Request bridge is used.
An uncertain submission with no recoverable canonical ID remains unknown; a list
miss is not proof of non-submission. Do not retry under a fresh idempotency key.

After a verified submission, create a watch with adapterRef identifying
`createHandrailFeedbackObserver` and subjectRef from `feedbackSubject(receipt.canonical)`.
The host stores private descriptions and supplies content references. Every poll
rediscovers current Known User reporter availability and reads the canonical ID.
The shared watch persists needs-input/status/ready facts and survives restarts.
The readiness adapter requires a matching intended environment and verified
canonical delivery evidence, including target containment for enhancements.
Worker success, commits, tests or a deployment receipt alone never mean ready.

**Exact remaining shared contract gap:** the inspected public MCP catalog at
`eb879d767d05c7c2e15748f6fe7838294b980d82` (`src/feedback-schemas.js`) exposes bug
submit/list/lookup/archive/restore and enhancement submit/list/lookup/release-status/
archive/restore/cancel. It exposes no feedback question-list/answer or approval-
response operation. The separate developer bridge's `clarify` does not address a
canonical PM bug/enhancement. Reporter lookup can indicate needs-attention or
approval-required; this SDK retains the canonical record reference and emits
`needs_input`, but cannot invent question IDs or submit an answer/approval.
Avery should qualify the actual runtime catalog and route any still-missing
canonical operation to the owning Handrail integration work. No live operation
was attempted here, so this is a source-contract gap, not proof that every deployed
Handrail surface lacks the capability. No new permission or owner decision is
needed merely to report it. The whole follow-through outcome remains open until
that canonical interaction is available and integrated.

## Mills migration map and rollout boundary

| Existing Mills adapter | Shared SDK destination / retained host responsibility |
| --- | --- |
| `assistance-time.ts` | `resolveScheduleTime` / `assistanceClock`; remove the previous one-year cap |
| `assistance-store.ts` | `createAssistance` plus `AssistanceStore` or supplied PostgreSQL adapter; retain account/session/household locks and private content storage |
| `assistance-runtime.ts` | `createAssistanceWorker` owns interval/coalescing and notification drain; existing push sender becomes an effect adapter, with `createNotificationDelivery` orchestrating it |
| `assistance-tools.ts` | thin calls to create/list/reschedule/cancel with trusted scope and original tool execution identity; remove the 100-pending cap |
| `handrail-ai-gateway.ts` | existing `createHandrailAssistant` and clients retained; provider transport becomes `createAgentConversationTransport` |
| Native domain tools / request tools | `createApplicationAgentTools`, current authorization/approval/business executors, existing tool observer/renderer identities; retain all 85 tools and refreshed dynamic MCP definitions |
| Handrail MCP/reporters | existing scoped client factory behind `HandrailFeedbackSession`; durable IDs and source-supported status/readiness in shared SDK |
| Web/Flutter, history, attachments, voice, metering | retain client/UI and canonical stores, translate structured history, and test through the same backend; no parallel client provider or scheduler |

Existing reminder rows/facts must be explicitly mapped (scope, original intent ID,
UTC/local time, status, command receipts and notification identities) in the
application's additive migration. Do not blindly enable both workers on the same
mandates or replay historical push. Keep legacy history readable and retain
rollback data. The source-only SDK assignment does not modify Mills or Handrail,
run host migrations, deploy, or qualify native UI. Avery continues Mills on the
same original outcome and commissions independent web/Flutter QA afterward.

## Delivery and qualification

Install only the final **public full Git SHA** produced by Handrail's post-agent
pipeline, with the matching normal package lock. This worker must not commit,
push, bump version, publish a registry package/tarball, or deploy. Consequently
the final SHA and its fresh public installation cannot be observed before that
pipeline runs. Do not substitute this dirty checkout or the old published base.

After the commit/push step, run:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

The verifier performs fresh-cache public HTTPS Git install and lockfile reinstall
with ordinary prepare/build, checks strict consumer types and exports, then runs
the actual installed Runner and an installed industrial-watch reconstruction
against disposable PostgreSQL. That final-SHA check is a downstream delivery gate,
not something a local source test proves. Current source verification and known
limitations are recorded in `docs/evidence/assistance-core/README.md`.
