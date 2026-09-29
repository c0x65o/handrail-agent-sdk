# Vault contract acceptance evidence

Selected checklist item: `72441a23-cd54-4705-8310-80b6c105153c` (Milestone 1 only).
Owner Task: `7ccb807a-4e38-42c7-bf23-73d62adec118`.
Owner Goal: `1b13c4ab-38c2-4d78-a5cb-238e2f257c62`.

## Checkout and workflow

Inspected 2026-09-27 before editing:

- Workspace: `/opt/handrail/repos/handrail/handrail-agent-sdk/.handrail/worktrees/convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e/handrail-agent-sdk`.
- Lane: `convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e`; branch: `lane/agent-sdk-v1`.
- Exact base HEAD: `1b3dfd6d19265b4e71607474b246d5e73783fd8e`; initial `git status --short` empty. No intervening changes were present.
- Read job/connection source, their tests, consumer fixture, package scripts, job contract and security boundary before implementation.
- Tool discovery exposed no `handrail_current_context`, `handrail_owner_task_update_item`, scoped KB reader or source-discovery reader. Required context verification and start/complete ledger calls could not be made. No database/queue workaround was used. This document is repository evidence for the same selected item, not a claim that its external ledger was updated. An equipped reviewer/runner must attach this evidence and settle the item.
- No commit, push, PR, version bump, runtime configuration, credential handling, deployment, purchase or live-provider action. Intended changes remain uncommitted for the worker's post-agent controls.

## Changed files

- `src/contracts/vault.ts`: four metadata/reference families, secure-entry completion/replay, scoped broker operations, redacted receipts and strict validation.
- `src/server/vault-policy.ts`: server-only trusted policy/context types; separate human permissions and disabled Agent reveal/export.
- `src/index.ts`, `src/server/index.ts`: public contract and server type exports.
- `tests/contracts/vault.test.ts`: executable synthetic schema acceptance suite.
- `tests/contracts/vault.test.mjs`: TypeScript transpilation/registration wrapper; generated JavaScript is removed after import.
- `package.json`: explicitly enumerates the vault wrapper in `npm test`; dependencies and lockfile unchanged.
- `tests/fixtures/consumer.mts`: package-consumer positive/negative type assertions.
- `tests/packaging.test.mjs`: extends existing export/import-isolation tests to vault and type-only server policy.
- `docs/vault-contract.md`, `docs/evidence/vault-contract.md`: semantics, limitations and acceptance mapping.

## Verification

Environment: Node `v22.23.1`, repository TypeScript `5.9.3`. Tests use inert synthetic fixtures and host-context/clock data, no database harness; they make no persistence claim.

| Command | Outcome |
| --- | --- |
| `pwd`; `git status --short`; `git branch --show-current`; `git rev-parse HEAD` | Expected lane and exact revision above, initially clean |
| `npm run build` | Passed source TypeScript checking and declaration emission |
| `node --test --test-concurrency=1 --test-reporter=tap tests/contracts/vault.test.mjs` | 359 vault tests passed; explicitly executes `vault.test.ts` through the wrapper |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Passed |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Passed public/server declaration checks and all negative assertions |
| `npm test` | 489 tests passed, 0 failed/skipped: 359 vault plus 130 existing job, connection and packaging tests |
| `git diff --check` | Passed |

The `.ts` suite is transpiled using the existing TypeScript dependency and executed by Node's test runner; it does not depend on newer Node type stripping. Source and the consumer fixture are separately typechecked. Two intermediate test-authoring defects (a receipt-ID mutation incorrectly expected rejection and an AST-test parenthesis error) were corrected before final verification. No unrelated pre-existing failure was found.

## Acceptance-to-test mapping

Test names below are in `tests/contracts/vault.test.ts`, except the indicated consumer and packaging checks.

| Acceptance | Executable evidence |
| --- | --- |
| All four families; API and refresh variants; SSN classification | `vault TS suite: … metadata, reference-only completion, operation and receipt`; `synthetic field classification: …` |
| Reference-only completion and exact original identity | Family tests plus `completion independently binds original request: …` and `host job independently binds identity: …`, independently mutating every original job/native/route and all six scope leaves |
| Wrong actor, challenge, revision, origin and item | `… requires authenticated actor and item ACL`; original-request leaf tests; `completion binds answer, family, source, item identity and current item revision`; `stale completion: …` |
| Existing-item selection still needs item authorization | Both `new_input` and `existing_item` tested for every family with authentication, job authority and item ACL independently denied |
| Expiry, revoke, deleted item, cancellation and tighter lifetime policy | `entry/use expiry, revocation, cancellation, lifetime limits and narrower host policy`; exact maximum and deadline boundary checks |
| Identical authorized replay, conflicting duplicate, stale completion, no new effect | `authorized identical replay keeps all identities and the original effect; conflicts never reapply`; every completion leaf independently changed on replay; `stale completion: …` |
| Ungranted operations, grant and item revision | `current use authority rejects stale items, grants, jobs, unauthenticated callers and ungranted use` |
| Wrong scope, origin/frame/profile/lease/navigation/field/form, endpoint/method/resource, identity recipient/purpose, payment scope | `… use binds grant and destination: …`, independently mutating each leaf for every family; `operation/family and destination rules …`; normalized-origin/endpoint tests |
| Payment/generic reference substitution, no card fill or purchase | `payment references cannot substitute …`; operation/family tests; consumer negative payment/reference assignments |
| Agent reveal/export disabled, human reveal/export does not grant use | Ungranted-operation schema tests; consumer negative `broker.reveal`, `broker.export`, raw getter and export-operation assertions; disabled Agent permission type assertion |
| Redacted receipts and safe fixed errors; stable/unknown effects | `broker results are redacted, fixed-error and bound to stable effect identity`; `accounted effects never authorize another dispatch, including unknown outcomes` |
| Raw secrets/PAN/CVV, hidden/unknown/symbol properties, hostile accessors and malformed arrays at nested boundaries; no error echo | `all nested boundaries reject unknown raw values, hidden properties, symbols and hostile accessors without echo`; `malformed arrays, unsafe revisions and frozen inputs` |
| Requested `.ts` suite actually runs; compatibility and package boundaries | Named `vault TS suite` tests appear in TAP; explicit `.mjs` harness in `npm test`; packaging tests assert root exports, empty server runtime exports, type-only server source and private implementation paths |

## Evidence limits

This is **contract evidence only**. It proves neither storage security nor authenticated runtime behavior, browser secrecy, durable replay/race handling, provider qualification, live Meta behavior or production readiness. Context booleans and references are host-supplied facts, not cryptographic proof. Qualified adapters and durable native/reference-host integrations are later checklist items. Missing dev QA login is not a prerequisite for these pure tests. Publication, deployment and independent runtime QA remain outside this work request.
