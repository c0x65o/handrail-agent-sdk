# Verified connection contract

`src/contracts/connection.ts` exports readonly `connection.ensure` input/result types and three pure validators through `handrail-agent-sdk`. It reuses `JobIdentity`, its six-dimensional host scope, `JobEffect` identity and job requirement references/revisions. It does not implement orchestration, persistence, browser execution, provider integration or server exports. Existing job semantics are unchanged.

## Admission and evidence

`ConnectionEnsureInput` carries the original job/task/native/route identity, connection and provider references, provider-prerequisite version, nonempty minimum API capabilities, fixture/provider evidence mode, original action/operation/effect references, and optional opaque vault/profile references. The intended account is `identity.host.accountRef`; tenant, user, project, environment and purpose are also mandatory. Native effect references, when present, must agree with the explicit logical effect. References are independently approved nonsecret identifiers, not credentials, account display names, paths, URLs or secret-derived hashes.

`validateConnectionEnsureInput(value)` checks admission shape and effect consistency. The host derives the admitted request from authenticated identity and current scoped authorization, resolves custody references, and persists it. A caller's structurally valid request is not authority. Optional vault/profile references can be absent before setup; newly captured custody and credential rotation remain private host state rather than rewriting the admitted request.

`validateConnectionEnsureResult(value, admittedRequest, now)` requires a matching original request and a trusted host clock in Unix milliseconds. It validates the following states:

| State | Required facts |
| --- | --- |
| requested, inspecting, authenticating, configuring, verifying | Original request and explicit authorization status; no readiness evidence claim |
| waiting_for_user | Nonempty typed secure-input/approval requirements for the admitted user: credentials, authentication challenge, consent, account selection or authority |
| waiting_for_provider | Nonempty requirements for the admitted provider: review, access level, account role, prerequisite availability or a named missing requested capability |
| reauthorization_required | Explicit expired, revoked, scope-changed or provider-rejected reason and resolvable missing requirements; expired/revoked reasons must match authorization status, other reasons require unverified status |
| unknown_effect | Original action/operation/effect with outcome unknown and a reconciliation reference |
| ready | Active, unexpired authorization and account/capability evidence with matching provenance |

Requirements have unique references, positive revisions and an actor reference. They carry no arbitrary instructions or provider error text. Authorization is explicitly unverified, active with expiry, expired with expiry, or revoked with revocation time. The validator rejects elapsed active authorization, future claimed expiry/revocation events, and any expired/revoked ready result. It does not mutate an expired snapshot into a reauthorization state; the host records that state under its durable revision rules.

Ready evidence includes only an opaque receipt reference, `api_capabilities` verification kind, all six scope references, provider/prerequisite version, a nonempty unique set of verified capabilities, verification time and expiry. Evidence must cover every requested minimum capability; extra verified capabilities confer no additional authority. Both evidence and authorization must be current at the supplied clock, including on replay. Browser login, token presence and setup grants cannot substitute for API evidence. Connection readiness never grants ads, spending, purchases or domain mutations; action-specific host approvals and execution gates still apply.

Provenance is exactly one of `fixture` with a fixture reference or `provider` with a verification reference, and must match the immutable admission mode. A provider-required request rejects fixture evidence. A fixture request also rejects a provider label, so reconnect cannot silently upgrade a test execution. Tests containing synthetic provider-shaped receipts prove this structural rule only; they are not provider verification.

## Reconnect and unknown effects

`validateConnectionReconnect(canonicalPreviousResult, nextResult, now)` checks the next result against the prior admitted request. Every request field, including original job/task, native references, route, scope, prerequisite version, capability list, custody hints, mode and logical effect, remains identical. Capability list order is canonical and significant for request equality. A new attempt, wake or delivery does not create a task or a new effect. Changed authority is rechecked by the host against the original ceiling; it cannot silently widen or replace that admission. Provider prerequisite changes require separately reviewed admission binding on the same original work, outside this reconnect guard.

A historical ready result can be inspected after expiry, but the next ready result must pass current-time validation. Reusing a receipt reference with changed evidence fails. Identical replay is structurally accepted only while current; the host deduplicates delivery and verifies canonical receipt contents and authority before release. It must reject reused or relabelled fixture receipts even if a caller fabricates an entirely new request.

An unknown effect cannot disappear, change outcome, change identity or lose its reconciliation reference through reconnect. It remains `unknown_effect` until a separately qualified domain reconciliation path accounts for that same effect. This contract deliberately provides no reconciliation or retry operation. Passing these checks is neither permission for blind replay nor proof that an external mutation did not happen. Hosts must compare with durable canonical prior state on reconnect/replay, not with caller-supplied history. This guard is not a lifecycle transition scheduler, concurrency fence or journal.

## Trust and output boundary

Structural validation **cannot authenticate provider facts, receipt provenance, revocation facts or current authority**. A forged provider label is still a claim. The trusted host must verify the receipt's private provenance, actual intended account and capabilities, current provider prerequisites, credential/item status, grants, ACLs, cancellation and leases. Reauthorization requires fresh authorized verification; an old cached receipt cannot restore revoked authority. Recheck at dispatch and before releasing observations, including replay. Durable host records must preserve fixture provenance and receipt identity across all intermediate states. The host owns provider errors, retries, reconciliation, current tombstones and atomic persistence.

All objects use exact allowlisted data properties; unknown keys, symbols, hidden fields, accessors, raw errors and provider payloads are rejected. Lists contain 1–256 dense entries; references have the same 1–128 ASCII identifier syntax as the job contract. Failures are only `{ ok: false, code }`, with a fixed `ConnectionValidationCode`; no raw input, exception or provider text is returned. Even a valid identifier can contain a secret, so syntax is not secret detection. Hosts must apply qualified ingress/output filtering and use approved references. Pass decoded JSON/data records, not executable objects. Success returns the original value; readonly types do not freeze it. Hosts must keep canonical records immutable and revalidate atomically.

This follows the local [job contract](job-contract.md), [runtime concept](Handrail_Agent_Runtime_Concept.md), [Agent security boundary](agent-security-boundary.md), and published revision 1 of KB `handrail-ai-sdk-implementation-contract` (read for this item). The Agent policy forbids raw secret/provider-error output even to private diagnostic sinks. No claim is made about the completeness of Marketing's verification path from any individual method.

Focused synthetic acceptance and checkout evidence are recorded in [connection contract evidence](evidence/connection-contract.md). Persistence, live provider proof, integration, orchestration and independent runtime QA remain separate checklist items.
