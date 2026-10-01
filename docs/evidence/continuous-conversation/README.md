# Continuous conversation foundation — source qualification

Assignment: `628cc5f3-d13d-58b6-8839-594c4a093961`. Source inspection and disposable
qualification on 2026-10-01. Base Agent SDK checkout
`18ca76ff5e8f41c5afda69da52c0210a9f706d54`, version 0.1.8; candidate remains
uncommitted. Saved assignment and all frozen instruction sources were retrieved
through `handrail_read_work_request_context` (one complete chunk, next=null).
Current-context MCP confirmed the assigned project/work request. No other MCP
writes, production/customer database access, provider effects, notifications,
configuration changes, deployment, commit or push were performed.

The usable destination is the shared trusted-server SDK foundation, before Avery
or Mills migration. The [integration guide](../../continuous-conversation.md)
and [headless example](../../../examples/continuous-conversation.mts) describe
host assembly. The code is implementation, not an audit-only proposal.

## Verified first-party comparison

| Source checked | Public behavior / reusable API | Limit of evidence |
| --- | --- | --- |
| [Dots](https://chatgpt.com/features/dots/) | Describes starting from ChatGPT memory, using connected tools/Codex, continuing projects between conversations, returning work/decisions for review, and allowing direction changes or pauses. These motivate separate conversation, memory and admitted-work lifetimes. | Product behavior does not document storage schema, queue algorithm, checkpoint layout or SDK implementation. No architecture is inferred. |
| [Muse](https://ai.meta.com/muse/), [productivity](https://ai.meta.com/muse/productivity/), [download](https://ai.meta.com/muse/download/) | First-party pages were opened; titles were available. | All three yielded zero extracted body lines. Search snippets do not establish internals. No Muse memory, durability, orchestration or permission architecture is claimed. |
| [Agents sessions](https://openai.github.io/openai-agents-js/guides/sessions/) | Session provides persistence operations; Responses compaction is an optional wrapper. | Checked installed 0.18.0 source/types, not just current docs. Its compaction implementation clears/rebuilds underlying history; use bounded staging plus durable CAS, not destructive canonical-session delegation. |
| [Agents running](https://openai.github.io/openai-agents-js/guides/running-agents/) | Runner owns model/tool orchestration. Session, RunState, model-input filtering, streaming and interruption are available. | A model run or in-process handoff does not supply native durable job admission, host authorization or exactly-once result delivery. Existing runtime/effect/approval stores retain those duties. |
| [Agents handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/) | Transfers a conversation to another configured Agent; parsed handoff arguments still need host authorization. | This is not durable native Work Request admission. The existing durable runtime deliberately restricts execution to checkpointed function tools; native delegation uses its effect ledger rather than treating an in-process transfer as a queue. |
| [Sandbox memory](https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/) | Memory uses files under a preserved sandbox memories directory; reads need shell and live updates need filesystem capabilities. | A fresh empty sandbox loses those files. This is not ordinary chat memory persistence. This implementation requires no sandbox for chat or memory. |

No third-party upgrade was needed: exact Agents 0.18.0 is retained. The actual
0.18.0 Runner, Session and Responses compaction wrapper are exercised with
simulated external model/compaction boundaries. No live model quality, live
provider latency or actual Codex execution is claimed. A later upgraded upstream
wrapper should be qualified before removing the staging adapter.

## Avery contract inventory / authority matrix

Read-only Handrail source inspected at
`2e146cf64e2de0904d29d2a24ac2eb210d3f4466`. These are integration seams, not
permission to alter the application or import its domain controller into the SDK.

| Inspected seam | Generic SDK responsibility implemented/reused | Retained Handrail authority |
| --- | --- | --- |
| `src/server/services/owner-assistant-thread-runs.js` (open-ended thread vs outcome lifecycle), `avery-outcome-loop.js`, `avery-work-observation.js` | Continuous transcript, bounded context, stable original references, durable work observations and result return | Outcome acceptance, task/objective accounting, review cadence, native workflow/controller and instruction applicability |
| `owner-assistant-memory.js`, `owner-assistant-memory-context.js`, `owner-assistant-memory-topic-scope.js` | Scoped memory read/list/revise/forget, provenance, revision conflicts, stale marking; encrypted reusable adapter | Owner identity, topic/project ACLs, KB publication rules, semantic applicability, original canonical memory migration/retention |
| `owner-assistant-question-receipt.js`, existing SDK answers/interruptions | Preserve question/approval references and pinned obligations; existing issue/complete/resume and current authority checks | Native owner card, exact answer/approval semantics, revocation and business-side effect confirmation |
| `owner-assistant-work-request-subscriptions.js`, `owner-assistant-work-request-policy.js`, `avery-work-observation.js` | Bind original effect/native job to original conversation; monotonic callbacks, result insertion in one transaction, correction fencing | Native Work Request creation/selection, correction authorization, native pause/cancel operation and verified callback mapping |
| `avery-imessage-delivery.js` | Reuse effect reconciliation and notification delivery; original once-only canonical result identity | iMessage outbox status, uncertain external sends, provider proof and destination authorization |
| `src/shared/owner-assistant-attachments.js`, existing application tools/transport | Existing bounded JSON Schema tools, current tool approval, opaque attachment preparation, checkpoint replay, stream text hook | Actual tools/MCP catalog, attachment ACL/type/readiness/size and bytes, approved provider and usage billing, native business mutations |
| Existing SDK `assistance.ts`, notifications and application gateway | Same schedules/watch/notification and web/Flutter wire contracts; no new scheduler | Application startup/recovery role, UI/host migration and independent web/native acceptance |

The related AI Assistant repository's AGENTS.md says Flutter source has moved to
its sibling Flutter repository. This assignment edits neither repository. Native
UI/device parity remains external integration acceptance, not a source-test claim.
The existing assistance guide's canonical feedback question/approval API gap also
remains a host integration gate; this change does not invent missing MCP methods.

## Implementation and focused evidence

- `src/server/conversation.ts`: canonical transcript API, bounded whole-batch
  projection, active exact-source pins, upstream Session adapter, staged upstream
  compaction with context-revision CAS, scoped memory, stable native work binding,
  callback/result transaction and shared runtime composition.
- `src/server/postgres/conversation-store.ts`, migration 0014: one reusable encrypted
  storage adapter, per-scope PostgreSQL transaction serialization and bounded
  active/sequence indexes. No production migration was run.
- `src/server/postgres/paged-envelope.ts`, state-store/runtime changes: opt-in
  explicitly budgeted paged RunState; authenticated pages remain below the old
  envelope boundary. No larger default; no entire conversation in a checkpoint.
- `tests/fixtures/installed/conversation.test.mjs`: real Runner across 45 turns,
  exact original obligations/corrections after bounded retrieval and actual
  upstream compaction; memory isolation/revise/forget/stale checks; two domain
  fixtures (personal travel and industrial sensor tools) through the same
  exported runtime; immediate response while native work remains active;
  fresh-process callbacks and once-only result replay; duplicate/out-of-order,
  correction/revocation and compaction races; explicit capacity failure;
  encrypted large state and page-reordering rejection; actual effect-ledger
  delegation without awaiting native work.

The two fixtures inject different domain schemas and read behavior; neither
imports Handrail/Mills business code. Provider/compaction responses and native
executor receipts are simulated; PostgreSQL, Runner, tools, leases, journal,
effects, encryption, transactions and child-process replay are real.

## Validation record

Checks ran sequentially, using Node 22.23.1, npm 10.9.8, TypeScript 5.9.3,
Agents 0.18.0 and disposable PostgreSQL 15:

| Check | Result / retained evidence |
| --- | --- |
| `npm test` (including build, acceptance compile, reference/Postgres compiles) | 777 passed, zero skipped; [log](npm-test.log). |
| Strict consumer/example compile | Exit 0 with `skipLibCheck:false`; [initial](consumer-typecheck.log), [final pre-install](consumer-typecheck-final.log). |
| Full disposable PostgreSQL runner | 399 checks, 397 passed and two migration-fixture failures; zero skipped. Original failed evidence is retained in [log](postgres-all.log). |
| Corrected migration fixtures plus conversation/runtime rerun | 56 passed (10 conversation, 18 Vault lifecycle, 28 runtime); zero skipped; [log](postgres-final.log). |
| Headless example CLI without host argument | Ran successfully, printed usage, performed no provider or database call. |

The first PostgreSQL failure was the historical Vault fixture rewinding its
migration ledger without dropping the new 0014 table; the second asserted the
old seven-migration count. The fixtures now reconstruct the actual historical
schema and check eight migrations including 0014. Both reruns pass. These failures
were not hidden, skipped or treated as runtime acceptance.

The final installed candidate passed **87 runtime checks, zero skipped**, with
actual package exports, real PostgreSQL, Runner, provider HTTP simulation and
fresh child processes. Both NodeNext (`@types/node` 22.20.4) and Bundler/explicit
provider (`@types/node` 22.18.0) consumer profiles passed strict compilation after
separate empty-cache HTTPS installs and lockfile reinstalls. The build used the
ordinary `prepare` command in the isolated installed package. Source/scripts were
removed before runtime, filesystem permissions denied repository reads, and
module hooks rejected source/reference escapes including recovery children.
See [installed log](installed-candidate.log), [profile metadata](installed-profiles.json),
[NodeNext install](node-next/install.log), [NodeNext reinstall](node-next/reinstall.log),
[NodeNext prepare](node-next/candidate-prepare.log),
[Bundler install](bundler-explicit-provider/install.log),
[Bundler reinstall](bundler-explicit-provider/reinstall.log) and
[Bundler prepare](bundler-explicit-provider/candidate-prepare.log).
Both profile directories also retain their strict typecheck logs.
The final new tests include cross-process paged-checkpoint decoding, user-scope
normalization, original reply receipt recovery and pause/cancel callback races.

This is **candidate-source overlay qualification** on public base
`18ca76ff5e8f41c5afda69da52c0210a9f706d54`, not publication of the new source. The
manifest/lock continued to identify that base during the overlay, as recorded by
the verifier. No candidate commit or release was created. The public dependency remains the frozen assistant SHA
`921a5650f1937504a124574ad795ea222555a684`. Regenerating stale npm metadata was
necessary to keep its manifest/root/resolved lock on public HTTPS. Ordinary
installation ran that dependency's prepare/build and the Agent SDK prepare/build.
The literal `git@` HTTPS username selects public transport, not a credential.
The final local build and strict consumer check are retained in
[build-final.log](build-final.log) and [typecheck-final.log](typecheck-final.log);
[source/build binding](source-binding.json) compares runtime artifacts with
the actual isolated installed candidate.

## Remaining acceptance boundaries

Publication is prohibited in this assignment. After Avery publishes the candidate,
run `node tests/verify-git-install.mjs FULL_DELIVERED_SHA` without an overlay. The
candidate overlay verifier retains the public base install and lock; its isolated
build/runtime evidence cannot establish that the candidate exists at a public SHA.

Avery/Mills still need their canonical-store mapping/migration, native executor
and callback adapters, current authentication/approval/tool/attachment bindings,
provider metering, independent web/Flutter acceptance, rollback plan and approved
cutover. Host pause/cancel must reach the native executor; SDK observation alone
does not stop a remote job. Memory forget does not erase host backups or already
admitted snapshots. Compaction is a bounded context transformation, not a claim
that a model faithfully recalls every archived fact; exact retrieval remains
available and active obligations remain pinned. No source qualification here
accepts an owner outcome or authorizes production delivery.
