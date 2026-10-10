# Continuous conversations, memory and native work

The trusted server can now use `handrail-agent-sdk/server/conversation` to compose
quick model turns with the existing durable Agent runtime. Normal chat uses the
injected Agents `Model` directly. No Codex process, sandbox, new provider client,
scheduler or outcome controller is created. Native long-running work goes through
an injected executor and the existing effect ledger. Publication, Mills adoption
and Avery cutover are separate gates.

## Minimal integration

See [the complete headless host](../examples/continuous-conversation.mts). It
compiles against package exports and can run with Node 22 and an explicitly
supplied approved host module:

```sh
node --experimental-strip-types examples/continuous-conversation.mts ./approved-host.mjs
```

That module exports `createPorts()` and an already admitted `identity`. Run without
an argument to see usage without accessing a provider or database. The isolated,
executable two-consumer demonstration is:

```sh
node tests/run-local-postgres.mjs test:conversation
```

Production integration uses the host's existing Pool, keys, authentication,
provider wrapper, native job executor, tools and startup/recovery path:

1. Apply `migrateAgentPostgres(pool, schema)` in the approved host migration phase.
   Migration 0014 adds encrypted conversation records and bounded paging indexes.
   Existing job, effect, approval and delivery identities are unchanged.
2. Create `createPostgresConversationStorage({client, schema, keys,
   maxRecordBytes})` and `createConversation({storage, authority, now,
   maxEntryBytes, maxContextBytes, pageSize})`. Alternatively implement the small
   transactional storage port against the host's canonical storage. Do not run
   two canonical transcript writers; choose the adapter or migrate explicitly.
3. Authenticate and derive `{tenantRef,userRef,conversationRef}` on the server.
   Append a role-preserving `TranscriptEntry` with a stable original turn ID and
   exact `sourceRefs`. Identical retries return the original sequence; conflicting
   content under that ID fails. Each entry is a complete replayable message/turn
   batch; never split a tool call from its result across compaction boundaries.
4. Persist its returned head with the admitted job in the host's existing turn
   binding. `createConversationAgentRuntime({...runtimeOptions, conversation,
   turn})` obtains bounded input and appends verified final output under a stable
   job-derived ID. Its `turn(identity)` resolves that saved `{scope,head}`.
   Initial input rejects a changed head. The host serializes initial turn
   admission and revalidates corrections through existing authority callbacks.
   Started jobs retain their admitted snapshot; unrelated later conversation
   turns do not cancel delegated work.
5. Feed optional `host.textDelta(identity, delta)` into the existing authenticated
   stream writer. It is provisional text, filtered by the host before UI delivery;
   exceptions/disconnection do not cancel work. Replay comes from canonical final
   entries and the existing checkpoint/application transport. This hook is not a
   durable token stream or a billing ledger. Keep the approved provider's usage
   receipt/outbox. Runtime usage totals and compaction usage are available.
6. Use existing `answer.issue/complete`, `runtime.resume`, job cancellation,
   application tools, attachment preparation, assistance ticks and notification
   delivery. The new layer does not replace those mechanisms.

## Three different state lifetimes

| State | Authority and behavior |
| --- | --- |
| Transcript | Host-canonical, append-only, encrypted, paged by sequence. `read(scope, after)` exposes a bounded cursor, including old exact source roles and references. |
| Model context | Disposable bounded projection. Recent complete batches, every active exact-source pin and pending native work references. `context()` reports included IDs, omitted count, canonical head, context revision and retrieval cursor. |
| Long-term memory | Explicit scoped values with provenance, revision and `validUntil`. Read/list expose stale status. Memory is data, never an approval, grant, executable policy or source of identity. |
| Temporary work | Existing job/effect/approval stores plus durable originating-conversation bindings and native observations. A native completion is execution evidence, not business acceptance. |

Use `pin(scope, key, expectedRevision, entryId)` for owner corrections and pending
obligations/approvals; pass null to release a resolved pin. Classification comes
from explicit host state or a host-validated structured decision, never keyword
matching. Pinned text preserves its original role. If all required pins plus the
latest turn cannot fit, context construction fails explicitly before a provider
call. It never drops an approval to make room. `pageSize` bounds database reads
and active pin/work counts per model view; capacity errors require a host/model
budget decision or explicit resolution, not silent truncation. Transcript length
has no corresponding cap. Add a read-only history tool through the existing tool
adapter when the model needs omitted source material.

`compactConversation({conversation,scope,client,model})` uses the installed
upstream `OpenAIResponsesCompactionSession` against a bounded staging session.
It atomically replaces only the model view after a context-revision comparison.
A correction, pin change, new turn or work observation invalidates an in-flight
compaction. Canonical history and exact pins remain independently retrievable.
The injected client/model must already be approved for compaction. Do this between
turns to avoid adding latency to visible streaming. No provider is called by
ordinary bounded retrieval. Compaction does not promise recovery of details that
were omitted from its input; those details stay in canonical paged history.

`createConversationSession(service,scope,turnRef)` is also a Session adapter for
upstream Runner read/append use. Use a fresh instance with the same stable turn
reference on retry and serialize runs for one session. Destructive pop/clear are
rejected; do not wrap this canonical session directly with 0.18's compaction
wrapper. Use `compactConversation` instead. A requested item limit that would
remove required context fails explicitly.

## Memory

`memory.revise` retains an encrypted revision ledger in the same scope transaction
as the current value. Use `memory.readRevision(scope,id,revision)` and
`memory.history(scope,id,beforeRevision?,limit?)` for exact historical reads.
History pages run newest first and return `next` plus `unavailableRevisions` when
older values were never retained by an earlier SDK. An existing current revision
is preserved when first updated with this SDK; missing older versions are not
fabricated. Historical reads use the same memory access authority as current reads.

`validUntil:null` represents a lasting preference. Optional JSON `metadata` stores
host-defined labels and domain scope; it never supplies authorization. Applications
must validate that domain scope through their native access boundaries. CAS writes
retain the original per-revision provenance. Passing null to `revise` means forget:
it erases value payloads from both the current record and every retained revision
in one transaction. Use a host metadata archive state if values should remain
available in history. Backup retention and source transcript retention remain
host responsibilities. The new ledger uses the existing conversation-record table;
no host-owned duplicate memory journal is needed.

```ts
await conversation.memory.revise(scope, 'preference', 0, {
  text: 'Use the owner-confirmed project.',
  provenance: [{sourceRef:'message:correction',role:'user',observedAt:now}],
  validUntil: now + approvedFreshnessInterval,
});
const memory = await conversation.memory.read(scope, 'preference');
// Validate provenance/current applicability before incorporating active memory.
await conversation.memory.revise(scope, 'preference', memory!.revision, null);
```

Revise uses optimistic revision checks; concurrent conflicting edits fail. Null
forgets the current payload, retaining only a tombstone and revision. Encrypted
old payload pages are replaced in the row. This is not deletion from host backups,
audit systems, already admitted job inputs or the source transcript. The host's
retention/erasure procedure owns those stores. User-scoped memory omits
`conversationRef`; conversation-scoped memory includes it. There is no implicit
cross-conversation merge: read the explicitly authorized scope. `withAccess`
runs on every read/write/list and must hold permission valid through the awaited
transaction. Stale values are marked, not silently refreshed or used as current.

## Durable delegation and result return

Create `createDelegatedWorkAdapter({conversation, resolve, executor})` and route
its operations through **the existing `createEffects`**. `resolve` maps the exact
trusted effect request to `{scope,originEntryId}`. The adapter durably binds that
request before asking the native executor to enqueue/reconcile. The executor
returns the original native job receipt when admission is verified; it does not
wait for job completion. Codex can be one host executor; it is not required.

Reuse original effect/idempotency/native IDs. An uncertain admission remains
`unknown`; only conclusive `not_applied` evidence permits the existing effect
ledger to dispatch. A lookup miss is not proof that a late original operation
cannot apply. Executor authorization still belongs to the host effect boundary.
No automatic polling loop is added.

Feed authenticated native callbacks into `work.observe(scope,effectRef,{revision,
instructionRevision,status,reference,result})`. Native revisions must be monotonic.
Older observations are ignored, identical retries are acknowledged, conflicting
same-revision or post-terminal observations fail. Completed observations require
a result. Result append and observation update share one transaction; the original
effect owns the delivery ID. A retry in another process returns the original fact
without a second result. Original entry and native receipt references are added
to delivery provenance. This is once-only canonical result insertion, not a claim
of exactly-once external email, push, iMessage or provider execution.

`work.correct` invalidates callbacks from an older instruction revision while
retaining the original effect/native identity. The host first pauses/revalidates
its native work and records/pins the owner's exact correction. The SDK does not
send a native pause/cancel command or manufacture permission. `paused` and
`waiting` observations retain pending work; explicit native cancellation is
terminal. Closing observation does nothing to durable work. Process `stop()`
releases runtime execution; existing recovery resumes admitted jobs. Explicit
user Stop remains the existing authoritative cancellation API. A work result
removes only its temporary work pin; host-owned outcome/approval pins remain
until explicitly resolved by the host.

## Checkpoint size and security

The previous whole-record 64 KiB guard rejected valid RunState because it contains
input, model/tool history and usage, while the surrounding checkpoint also
contains input and tool results. Merely increasing that constant would bypass
both the runtime and private-envelope bounds.

`createPostgresAgentStores({...,checkpointQuotaBytes})` now opts into paged private
custody. A sealed manifest authenticates total size, digest and page count. Each
32 KiB byte page is base64 encoded and separately AES-GCM sealed below the existing
64 KiB plaintext boundary. AAD binds full job identity, version, grant, key,
digest and page index. The checkpoint, pages and job transition stay in the same
row-locked transaction. Reordering, corruption, missing keys, cross-scope copying
and quota excess fail closed. No compression bomb, unsigned blob reference or
partial checkpoint commit is introduced.

The host explicitly budgets total bytes; there is no new larger default. With no
quota option the existing 64 KiB whole-checkpoint contract remains. With paging,
`maxStateBytes` bounds control metadata and the host quota bounds the whole
serialized record; request bytes, tool output, calls, turns and elapsed time stay
independently bounded. Whole RunState still needs deserialization in memory, so
budget the quota accordingly. Pages are stored in one JSONB envelope, not an
unbounded object store. Old single-envelope checkpoints remain readable. Rolling
back to code that predates paged custody requires stopping writers and retaining
state for forward recovery; do not run old workers on paged records.

## Boundary inventory and delivery

See [research and qualification](evidence/continuous-conversation/README.md) for
actual Avery seams, public-source comparison, test evidence and remaining gates.
The existing [Postgres application](../examples/postgres-application.mts) shows
web/Flutter-compatible transport, tools, approvals, notifications and schedules.
No browser/mobile protocol, provider configuration or business authority changed.
Install only the eventual public full Git SHA with ordinary prepare/build and a
matching lock. Candidate-source qualification is explicitly not that publication.

### Explicit Stop projection

The checkpoint reader emits `response.cancelled.reason` directly from the
validated cancelled snapshot (`explicit_stop`). Only the authorized Agent
cancellation operation creates that snapshot. Failed jobs and authority loss
are not relabelled as user cancellation. The AI Assistant SDK's matching protocol
maps it to canonical `user` history, independently of the observing device.
Cursor replay and cancelled-job fencing remain unchanged.

This source requires the AI Assistant SDK protocol revision adding
`explicit_stop`. Before publishing Agent, update its public HTTPS full-SHA JS
pin and matching lock to the published repair. Source-path compile/fixture
qualification does not replace that install check. See
[evidence](evidence/explicit-stop/result.json) for the source qualification and
ordered publication/adoption requirements.
