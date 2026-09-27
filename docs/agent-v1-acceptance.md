# Agent SDK v1 acceptance baseline

The **revised Owner Goal** `1b13c4ab-38c2-4d78-a5cb-238e2f257c62` and accepted Owner Task `7ccb807a-4e38-42c7-bf23-73d62adec118` govern v1 acceptance. This baseline implements only item `f0881bfd-7aec-41d3-96d2-f8c82b536efb`. The [historical runtime concept](Handrail_Agent_Runtime_Concept.md) remains an unchanged, explicitly unimplemented proposal. The existing README packaging guidance remains intact. Live Avery iMessage replacement is deferred; v1 retains channel-neutral identity mapping.

The [manifest](../fixtures/convergence-v1.json) enumerates 42 stable acceptance IDs. Each case identifies its owning surface and host, expected proof class, required evidence, precise failure conditions and separate observed results. **Every case starts `unverified` with no evidence.** This does not deny existing contract implementation; it means this baseline has not independently accepted an entire v1 promise. A successful validator or fixture receipt cannot change that status.

## Source and policy authority

Inspected source baseline: `lane/agent-sdk-v1` at `04e8a72b4e5093753d9b03aa4adc62e2b3292383`, initially clean. The source identity in the manifest is the baseline before this uncommitted change, not a release or installed-runtime revision. The queued work request is `8959ebf0-a5f6-421c-a5fc-34277b01e47d`, in Convergence lane `convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e`.

The current [job](job-contract.md), [connection](connection-contract.md), [vault](vault-contract.md) and [browser](browser-contract.md) contracts and their focused tests define actual APIs. [Security boundaries](agent-security-boundary.md) define normative qualification requirements. Its section 1 records the ownership map's provenance in **Handrail**, including source revision and content digest; there is no ownership-map file in this SDK checkout. That recorded provenance is not fresh native runtime verification.

Published revision 1 of KB `handrail-ai-sdk-implementation-contract` (entry `664f7487-aeda-476a-8aed-35d93426b07b`) was read through MCP for this work. Its host-authority, original-identity, typecheck and public HTTPS full-SHA Git-install policies apply. Its separate AI Assistant SDK APIs do not replace the Agent contracts. The Agent security policy remains stricter: no raw secret/provider-error output even to private diagnostic sinks. Node >=22 and pinned TypeScript 5.9.3 remain unchanged.

Current MCP context confirmed the project, repository lane, Owner Goal, task and selected item. The queued execution decision disables CI/CD and automatic publication for the worker, while the broader goal publication-policy metadata permits post-worker handling. The explicit source-only request governs this change: no worker commit, push, PR, provider call, deployment, credentials/configuration change or queue/database mutation outside the requested checklist ledger tools.

## Case index and proof classes

IDs have the form `ASDK-V1-Mn-NAME`; do not renumber existing IDs. The validator maintains a coverage floor for every named promise, not merely one case per milestone. Changes to this baseline require review of the manifest, coverage floor and documentation together.

| Milestone | Case suffixes | Primary owners |
| --- | --- | --- |
| M1 | CONTRACTS, OWNERSHIP, BOUNDARIES, QUALIFICATION, BASELINE | SDK contracts, native owners, boundary reviewers |
| M2 | ADMISSION, IDEMPOTENCY, LEASES, ANSWERS, CANCELLATION, UNKNOWN | Durable job host and original domain effect owner |
| M3 | LOGIN, API, IDENTITY, PAYMENT, SHARING, REVOCATION, CUSTODY, ISOLATION, RESTORE, TAKEOVER, FILL, CAPTURE, TRANSFERS, REDACTION | Vault, browser, qualified executor, transfer gate and independent security reviewer |
| M4 | PREREQUISITES, CONNECT, RESUME, RECOVERY, UNKNOWN | Marketing SDK, authorized Meta provider owner and original native Task |
| M5 | PORTABILITY, TOOLS, EVENTS, SCHEDULES, CHANNELS | Shared core and injected native/reference host adapters |
| M6 | CONFORMANCE, REFERENCE, RUNTIME-QA, SECURITY-QA, INSTALL, OPERATIONS, RELEASE | Both hosts, independent QA, operator and native acceptance owner |

`handrail` means the native Handrail host; `reference-node` means an independently runnable Node host; `handrail-marketing` means Marketing SDK integrated with the native host and authorized Meta provider owner. These names identify intended execution surfaces, not implemented or qualified adapters.

| Expected proof class | Required interpretation |
| --- | --- |
| `source_review` | Revision-bound source/design/caller review; cannot prove execution. |
| `structural_fixture` | Compiler and deterministic synthetic contract checks; cannot prove persistence, security qualification or provider facts. |
| `synthetic_runtime` | Future actual host execution with synthetic inputs, a real supported durable harness, interruption/race tests and retained safe receipts. Static fixtures do not meet this class. |
| `authorized_provider` | Future real, explicitly authorized provider verification on the intended account/environment with exact capabilities, versioned prerequisites and authenticated receipt provenance. A provider-shaped object is insufficient. |
| `independent_runtime_qa` | Independent execution/review of both hosts' durability and lifecycle behavior at exact revisions. |
| `independent_security_qa` | Independent synthetic qualification of exact adapter/policy versions and every secret ingress/output/custody boundary. |
| `clean_git_install` | Clean public HTTPS Git installation at a full 40-character SHA, matching lockfile and normal install/build compilation. |
| `installed_runtime_release` | Native acceptance assembled from exact installed SDK/host revisions, capability matrix, both-host conformance, independent QA and authorized installed Meta workflow evidence. |

Expected proof is a requirement, never an observed result. Future evidence artifacts must name case ID, exact source/installed revision, host, adapter/policy/prerequisite versions, evidence class, safe receipt references, reviewer and outcome (including failures and unverified gaps). Preserve fixture provenance permanently; do not relabel or reuse a fixture receipt as provider proof. The baseline validator intentionally rejects **all** pass claims and evidence attachments in `observed`. Future release acceptance needs separately reviewed evidence tooling; adding a receipt string here is insufficient.

Wrong tenant, user, project, account, environment or purpose must deny reads/use/continuation. Wrong origin, full frame ancestry, document generation, field or form destination must deny protected browser operations. Stale requirement/job/grant revisions, concurrent or expired leases, cancellation, revocation, widened scope and conflicting idempotency must fail closed at dispatch and output release. These are explicit per-case runtime expectations, not claims that this fixture exercises actual authorization, browser isolation or races. Any raw sensitive value or secret-derived data reaching model observations, chat, history, retained evidence, DOM output, screenshots, logs or errors fails acceptance, including private diagnostics.

## Deterministic representative workflow

[convergence-v1.ts](../tests/fixtures/convergence-v1.ts) imports `JobIdentity`, `JobEvent`, `JobSnapshot`, `JobAnswer`, `ConnectionEnsureInput` and `ConnectionEnsureResult` through the current public package exports. Literal objects use TypeScript `satisfies`; they are not JSON cast to contract types. `tsc` strictly checks the complete workflow and emits an ignored `.acceptance-build` module for the Node >=22 validator, outside the package's shipped `dist` tree. No type stripping or transpile-only check substitutes for this compile.

The JSON workflow must deep-equal that compiled typed value, including approved synthetic aliases and fixed Unix-millisecond timestamps. This detects edits to JSON alone, whole-workflow identity rewrites and unexpected retained data. It is a reviewed finite fixture, not a generic secret detector. If the fixture changes intentionally, update the TypeScript source, regenerate the JSON workflow, review its nonsecret references and rerun checks. Case prose also requires human review; string syntax cannot certify secrecy or the quality of acceptance requirements.

| Step | Job revision/state | Connection assertion | Meaning |
| --- | --- | --- | --- |
| submit | 1 / queued | requested; unverified authorization | Original immutable admission |
| start | 2 / running | inspecting; unverified authorization | No API proof yet |
| missing | 3 / waiting | waiting_for_user | `fixture.challenge`, requirement revision 1 |
| duplicate | 3 / waiting | Same missing assertion | New delivery attempt, no journal append |
| restart | 3 / waiting | Same missing assertion | Simulated reload of the exact snapshot; no process or database recovery claim |
| answer | 4 / waiting | verifying; unverified authorization | `fixture.private-response` bound to challenge revision 1; no secret bytes |
| resume | 5 / queued | ready, fixture API evidence | Synthetic resolution receipt and active fixture authorization only |
| continue | 6 / running | Same fixture API evidence | Same original task/job continues |
| unknown | 7 / running | unknown_effect | Original action/operation/effect accounted as unknown |
| restart-unknown | 7 / running | Same unknown effect and reconciliation reference | No new dispatch, result relabelling or resolution |

All steps retain the original task, job, request key, instruction revision, native request/root-task/source-queue identities, six-dimensional scope, channel/route/correlation and action/operation/effect. Delivery `attemptRef` changes independently; journal revisions advance only for canonical appended events. The challenge reference/revision survives duplicate delivery, restart, answer and resume. Answer and resume are distinct commands; receipt possession is not authorization.

Both admitted mode and receipt provenance are `fixture`. `fixture.provider`, `fixture.account`, `fixture.api.read` and `fixture.prerequisites-v1` are synthetic aliases, not Meta selections or capability claims. Fixed timestamps exercise validity intervals and are not measured latency or a trusted live clock. The simulated ready result precedes a deliberately injected uncertain outcome; it never establishes end-to-end task completion. The final journal and connection preserve the original unknown effect. Current contracts provide no reconciliation transition; M2/M4 reconciliation remains a future acceptance expectation requiring its own reviewed domain contract. No success event is invented.

The validator calls the existing job transition and connection result/reconnect guards, checks replay equality and challenge bindings, then compares the complete workflow to the compiled fixture. Logs and errors contain only fixed result codes/counts, never submitted data. The workflow stores only reviewed synthetic nonsecret references. It contains no passwords, tokens, cookies, SSNs, payment material, provider handles, raw bodies or secret-derived hashes. No database, fake repository, browser or provider harness is introduced.

## Reproducible manual baseline procedure

This is a procedure for later authorized measurement, not a provider execution instruction for this source task. **No baseline measurements have been taken.** Missing values mean unmeasured, not zero, failure or success. Synthetic workflow time constants are never measurements.

1. Freeze the comparison protocol before a run: selected case IDs, completion criteria, exact requested capability ceiling, initial missing-connection condition, account/environment scope aliases, intervention taxonomy, retry/time budget and recovery variants. Record the operator/reviewer, exact SDK/host/model/browser/adapter/policy/prerequisite versions, installed Git pin/lockfile, clock source and evidence class. Preserve separate manual and assisted cohorts. Set run count in advance; record all attempts, including failures and refusals.
2. Use a qualified private surface and synthetic sensitive inputs for qualification. The manual comparator is an authorized operator performing the same setup and original-task continuation on the same frozen scope. Real Meta measurement waits for the unresolved authorization/prerequisite inputs below. Establish/reset the missing condition only through an explicitly approved procedure; do not erase shared data or revoke credentials as an incidental baseline setup.
3. Start a monotonic timer at original request admission (manual comparator: start of the same assigned task). Record only approved nonsecret references and sanitized status events. Label human-only consent/identity/authentication requirements separately from missing authority, provider review, technical recovery and avoidable operator work. Count each discrete request for human action once, with its reason and blocking duration. Never record entered values, page output or sensitive screenshots as evidence.
4. Stop at independently verified capability completion **and** continuation of the original task, or at a classified terminal failure/time budget. Record outcome, applicable case failures and original-identity preservation. An unresolved unknown effect is not completion. Do not infer acceptance from worker exit, browser login, a receipt-shaped object or a ready boolean.
5. Repeat controlled restart, duplicate delivery, expiry, revocation and lost-acknowledgment variants within the exact authorized test scope. Keep original identities. Measure recovery from the injected interruption to verified original-task continuation; record unresolved cases without blind retry. These variants require actual runtime/domain support and are not implemented by the JSON trace.
6. Independently review possible unnecessary refusals against the authority and qualified capabilities available at that time. Required human consent, missing permissions and unavailable/unqualified adapters are legitimate constraints; record them separately. Record only bounded reason classifications and safe references, never raw model/provider errors.
7. Collect actual token usage, host/browser compute and provider billing from approved sanitized meters. Separate measured, estimated and unavailable amounts, specify currency and pricing version, and avoid inventing missing charges. Compare manual versus assisted completion, interventions, time and recovery across the predefined runs; include sample count and failures. Keep unresolved results visible.

Copy this initially unmeasured worksheet per cohort and recovery variant. Each populated metric must carry `runRef`, case IDs, evidence class, source/installed revisions, measurement method, safe evidence references, collector/reviewer and capture time. Those provenance fields are also initially `null`.

| Field | Initial value | Unit / definition | Required provenance when measured |
| --- | --- | --- | --- |
| run count / cohort / variant | `null` | attempts; manual or assisted; nominal/restart/duplicate/expiry/revoke/unknown | Frozen protocol and safe run references |
| completion outcomes | `null` | completed / failed / unresolved per attempt, with reason code | Independently verified API capability and original-task continuation receipts |
| completion rate | `null` | completed attempts / all admitted attempts, reported as count and percent | Outcome set and explicit denominator; no excluded failures |
| interventions | `null` | count of discrete human actions per attempt | Sanitized intervention event references and reviewer |
| intervention reasons | `null` | counts by consent, identity, authentication, missing authority, provider prerequisite, technical recovery, avoidable operator work | Reviewed reason classification; no free-form sensitive input |
| unnecessary refusals | `null` | count per attempt and fraction of eligible authorized opportunities | Independent authority/capability review and explicit denominator |
| end-to-end latency | `null` | milliseconds from admission/start to verified continuation or terminal outcome | Monotonic clock intervals, run boundaries and clock method |
| active / human-wait / provider-wait time | `null` | milliseconds, separately recorded without double counting | Safe timestamped phase boundaries; wall-clock time remains reported |
| recovery | `null` | recovered / unresolved per variant; milliseconds from interruption to verified same-task continuation | Interruption and restart/event receipts with original identities and effect counts |
| token usage | `null` | input/output/cached token counts, per model/version | Sanitized usage meter; missing dimensions remain unknown |
| host/browser compute | `null` | seconds of billed or metered usage, labelled by source | Meter reference and allocation method |
| total cost | `null` | USD per attempt and per completed attempt; measured/estimated components separate | Billing or rate-card revision, currency, attribution and explicit excluded/unknown charges |

## Unresolved inputs and deferred evidence

The following remain unresolved inputs to later checklist work. They do not block creating this synthetic baseline:

- Explicitly authorized Meta account selection and environment; synthetic account aliases are not a selection.
- Exact minimum API capabilities and original Marketing task action ceiling; `fixture.api.read` is not a Meta capability inventory.
- Versioned Meta provider prerequisites, including approved application, consent path, account roles, review and access levels, discovered from authoritative provider documentation when that task runs.
- Trusted browser/Vault/provider/model adapter selection, exact versions, fail-closed capabilities and independent qualification.
- Durable runtime, domain reconciliation, both-host conformance, independent QA, clean public Git install and installed-runtime release evidence, as already assigned to later task-list items.

No new provider action, deployment, release, ad, spending, purchase, consent bypass, production mutation or live iMessage replacement is authorized by this baseline. Native action-specific gates and task acceptance continue to apply.

## Validation and review evidence

Run sequentially from the repository root (Node >=22; locked TypeScript 5.9.3 installed):

```sh
npm run check:acceptance
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
git diff --check
```

`check:acceptance` builds current contracts, runs a real strict fixture compile, validates JSON, and runs focused negative tests using `node:test` with concurrency 1. `npm test` also compiles the fixture before including its tests alongside the existing job/connection/vault/browser/packaging suites. The consumer no-emit typecheck includes the representative fixture too. No dependency or lockfile change is needed.

Observed source-only results are recorded below after execution. They prove **manifest consistency and contract compatibility only**, not persistence, authorization truth, adapter qualification, live-provider verification, implementation acceptance or release readiness. The case `observed` fields intentionally remain unverified.

Recorded 2026-09-27 on the source baseline above plus this uncommitted patch, using Node `v22.23.1`, npm `10.9.8` and TypeScript `5.9.3`:

| Command | Observed result |
| --- | --- |
| `npm run check:acceptance` | Exit 0; 42 cases accepted for manifest consistency; 60 focused tests passed, 0 failed/skipped. Includes real `tsc -p tests/fixtures/tsconfig.acceptance.json`. |
| `npm test` | Exit 0; 770 tests passed, 0 failed/skipped across acceptance, existing job/connection/vault/browser contracts and packaging. |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Exit 0; no-emit consumer and representative fixture typecheck against public exported declarations. |
| `node scripts/validate-convergence-v1.mjs` | Exit 0; exactly `{"ok":true,"caseCount":42,"proof":"manifest_consistency_only"}`. |
| `git diff --check` and added-file whitespace/local-link review | Passed. Historical concept, README, current contract implementations, package version and lockfile unchanged. |

The negative checks reject duplicate IDs; each missing milestone; a missing individual promise or conformance host; unsupported pass/ready claims; downgraded provider proof; fixture receipt promotion (including coordinated whole-workflow promotion); every original identity field changed at restart; changed action/operation/effect; stale answers; changed challenges; duplicate append; restart revision drift; wrong tenant/account/environment; stale evidence; changed capability ceiling; missing unknown-effect accounting; unsupported reconciliation; and undeclared retained payload fields. They use nonsecret test markers and fixed error codes.

No unrelated pre-existing failures were observed in the executed checks. No runtime database/browser harness or live provider was exercised; process durability, security execution, provider verification and installed-runtime release evidence remain unverified. Source changes remain uncommitted for native review and post-agent handling of this same checklist item.
