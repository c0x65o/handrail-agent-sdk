# Public job lifecycle contract

Implemented in `src/contracts/job.ts`, exported from `handrail-agent-sdk`. These are readonly TypeScript wire types and pure validation functions, with no runtime dependencies. They do not submit, execute, persist, reconcile or cancel work. The authenticated host remains the execution owner.

## Validation and host authority

- `validateJobSnapshot(value)` checks a six-state snapshot, state-specific fields and receipt/answer bindings.
- `validateJobCommand(value, current?)` checks one of submit/inspect/events/answer/resume/cancel. Supplying the authoritative current snapshot also checks identity, revision, terminal state and waiting requirement. Omitting it is **schema validation only**.
- `validateJobEvent(value)` checks a single canonical event's shape, adjacent revisions, destination state and any embedded command. It cannot establish its predecessor.
- `validateJobTransition(previous, event)` checks a new event against its predecessor. Pass `null` only for initial admission.
- `validateJobResult(value)` checks command-specific results, or a bounded events page with a baseline and a fully validated contiguous suffix.

Every function returns `{ ok: true, value }` or `{ ok: false, code }`. Failures contain only a fixed code; no input keys, values, error messages or exception causes. Successful values are the original input, not a clone or frozen object. Readonly types and transition comparisons enforce the contract; the host must keep canonical snapshots immutable and revalidate against durable state atomically before writing. Pass decoded JSON/data records, not executable objects.

The host derives tenant, user, project, account, environment and purpose references from authenticated admission and resolves every native identity. A command's claimed identity is a binding to compare, never authentication. The host must authorize reads, mutations and output release, enforce current instructions/grants/holds/cancellation/leases, and correlate results to their requests. This module does not verify ACLs, expiry, receipt truth, requirement fulfillment or provider facts. Opaque grant, answer, resolution and completion receipt references never confer authority.

All six scope references are required. Personal or non-provider work requires an explicitly host-derived scoped namespace; absence is not a wildcard. Optional native references should be omitted if no corresponding object exists, rather than inventing native tasks or child work requests.

## Identity and revisions

`identity` is immutable throughout the journal: logical `jobId`, `originTaskRef`, `requestKey`, original `instructionRevision`, host scope, native references and original channel/route/correlation references. Native request/thread, Assistant project versus execution project, Objective/root/outcome, backing versus child work request, turn/run, action/operation/effect and source queue/message remain named separately. Queue references identify both the queue namespace and its message. Resolve these references in the host, without embedding route URLs or arbitrary metadata.

Event `delivery` contains a later attempt, callback and delivery queue/message. It cannot replace original identities. The canonical event identity is `(jobId, snapshot.revision)`, independent of its delivery attempts. Authorized retries replay the original canonical fact; they do not append the same event twice or invent a new effect key. The host owns idempotency and rejection of conflicting content under a reused request key. The submit result is the original queued admission snapshot, even on an authorized admission replay; inspect returns current state.

The first `submitted` event advances revision 0 to queued revision 1, with no effects. Every appended event advances exactly one safe integer revision. Mutations carry `expectedRevision`; an answer also names the current requirement reference and its separate positive revision. A duplicate/stale/skipped event is rejected as a **new append**. Replay storage and delivery deduplication are outside this module. At the maximum safe integer revision, no additional event can be appended.

An events result supplies an authorized baseline snapshot and up to 256 subsequent canonical events. For `afterRevision=0`, return the queued admission baseline at revision 1; otherwise the baseline is the requested cursor revision. The host must bind the baseline to the requested job/cursor and its durable journal. The validator checks internal continuity, not provenance. Larger histories are paged by the host.

## State changes

| Previous state | Event | Next state |
| --- | --- | --- |
| No job | submitted | queued |
| queued | started | running |
| running | waiting | waiting |
| waiting | answered | waiting with one bound answer |
| waiting | resumed | queued |
| running | effects_recorded | running |
| running | succeeded | succeeded |
| queued, running, waiting | failed | failed |
| queued, running, waiting | cancelled | cancelled |

All other transitions are rejected. Succeeded, failed and cancelled are terminal. Failures needing recovery should be represented as waiting with a host-resolvable requirement until terminal failure is appropriate. Resume never resurrects cancellation.

Waiting reasons are approval, secure input, provider, host or reconciliation, each with a requirement reference/revision and a resolvable user/provider/host actor. The host resolves and checks the actor; no arbitrary explanatory text is admitted. Answers contain only a host-accepted private response reference, retain the same job identity, and are consumed once against the current requirement/revision. `answered`, `resumed` and `cancelled` events embed their exact validated commands. An answer does not resume execution. Resume requires a host-verified resolution receipt reference bound to the current requirement, including when a provider/host resolves a requirement without a user answer. The queued result is claimed separately by the host under current authority.

Success requires a `receipt` with `verification: 'host_verified'`, an opaque receipt reference, and the matching job ID and resulting revision. **This literal is a host assertion, not cryptographic proof.** The host must supply and verify the receipt and apply native task acceptance before publishing success. A model claim or worker exit is insufficient.

Cancellation requires an explicit `cancel` command with `reason: 'explicit_stop'`; the host supplies the authorized actor in the resulting cancellation fact. `JobObservation.dispose()` describes only local observation cleanup. There is no dispose/close command or implicit cancellation. No UI or observation implementation is provided here.

## Effects and safe payloads

Each effect has distinct action, operation and effect references with outcome `unknown`, `verified` or `not_applied`. Existing effect entries cannot disappear, change identity or change outcome in lifecycle events. Running work may append accounting; queued/waiting transitions preserve it exactly. Unknown outcomes survive waiting, failure and cancellation and forbid success. They never authorize replay. A future domain-owner reconciliation contract must account for resolution of the original effect; this item intentionally supplies no resolution operation, including after cancellation.

Objects use exact allowlists at every nested boundary. Unknown fields, raw status/error/provider objects, accessors, symbols and hidden properties fail validation. Arrays are dense and bounded to 256 items; references are 1–128 ASCII identifier characters (`A-Z`, `a-z`, digits, `.`, `_`, `:`, `-`, with an alphanumeric first character). Error payloads contain only an enumerated safe code and generated correlation reference; free-form error text is absent.

These bounds are not secret detection. Even a syntactically valid identifier may contain a secret. Hosts must use independently approved nonsecret identifiers, never raw page/provider text, credentials, secret-derived hashes or bearer links. Sensitive input stays on qualified private routes; ordinary transport admission and observation filtering remain mandatory. No raw audit export is defined, and native audit size/access limits remain host-owned.

## Inputs and limits

This contract follows the SDK [runtime concept](Handrail_Agent_Runtime_Concept.md), [security boundary](agent-security-boundary.md) sections 2–3 and 7, and published revision 1 of KB `handrail-ai-sdk-implementation-contract`. The linked Handrail ownership map was read in full through `read_source_code(source=handrail, repo_name=handrail, change_lane_id=null)`: reader revision `ac932053c70915a264ade9d76ef2f59996846e10`, content SHA-256 `b1bd9b24fee983cb2dc03b26e5a25f42fac72900f68408d47b381eac86ca122b`, recorded source baseline `847c632b0718f52669f5adcbf3a377d6d0b4187e`.

Focused synthetic tests prove structural and lifecycle rules only. No persistence, worker, adapter, live provider, cancellation race or cross-process recovery is implemented or qualified. Runtime and independent QA remain separate checklist items.
