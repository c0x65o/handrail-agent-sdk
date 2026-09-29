# Browser contract acceptance evidence

Selected item: `9b63d8fe-df2e-423e-b200-c106fa5c24d8` (Milestone 1 contracts only).
Owner Task: `7ccb807a-4e38-42c7-bf23-73d62adec118`.
Owner Goal: `1b13c4ab-38c2-4d78-a5cb-238e2f257c62`.
Project: `acc927b7-48c7-46b2-a8d3-09e33e2e84e6`; repository: `e22dd818-166e-4646-b83f-423861de18a6`.

## Source identity and workflow

Inspected 2026-09-27: branch `lane/agent-sdk-v1`, base HEAD `887b47e93a4027474867c547cee62291f2310df3`, initially clean (`git status --short` returned no entries). Retained change lane `convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e`. Workspace: `/opt/handrail/repos/handrail/handrail-agent-sdk/.handrail/worktrees/convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e/handrail-agent-sdk`; this path was not converted into a repository routing identity.

Read the existing job/vault contracts, vault server policy, job/vault documentation, security boundary (especially sections 5–7), package scripts, contract tests and packaging/consumer checks. The native ownership inventory remains a linked Handrail artifact with provenance in the security document, not an invented local file. No applicable `AGENTS.md` was found along the workspace ancestry.

The callable tool catalog exposed neither `handrail_current_context` nor `handrail_owner_task_update_item`, nor a tool-discovery tool to load them. Required MCP context/start/progress/complete calls could not be made. No database/queue workaround was attempted. This artifact is review evidence, **not a claim that the external checklist was updated**. An equipped runner/reviewer must attach it and settle this selected item.

Changes remain uncommitted. No version bump, commit, push, PR, runtime configuration, CI/CD, deployment, provider action, credentials, dev Vault profile, real browser or QA campaign was used. There is no `qa_campaign_id`. No unrelated pre-existing changes or failures were found.

## Implementation

- `src/contracts/browser.ts`: scoped opaque profile and encrypted-custody metadata; lease ownership/revision/epoch/expiry; bounded operations; vault grant references; protected observation/attestation shapes; original-job/challenge takeover and fresh handback binding; separate local/remote revocation results; strict runtime validators and fixed errors.
- `src/server/browser-policy.ts`: trusted current operation/takeover/handback context types, exported only as types through the server entrypoint.
- `src/index.ts`, `src/server/index.ts`: public contract and server-only type exports.
- `tests/contracts/browser.test.mjs`: synthetic acceptance and negative tests; registered in `package.json`'s explicit list.
- `tests/fixtures/consumer.mts`, `tests/packaging.test.mjs`: declaration compatibility, readonly/forbidden API assertions, import isolation and exact export checks.
- `docs/browser-contract.md`: host ownership, validation semantics and explicit qualification/execution limits.

## Verification

Node `v22.23.1`; TypeScript `5.9.3`. No database harness is needed: these are pure schema/binding tests using inert synthetic fixtures and fixed host-context/clock data, with no persistence claims. Expensive checks ran sequentially with test concurrency 1.

| Exact command | Final outcome |
| --- | --- |
| `pwd`; `git status --short`; `git branch --show-current`; `git rev-parse HEAD` | Expected clean lane and base identity above |
| `npm run build` | Passed TypeScript checking and declaration emission |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Passed source typecheck |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Passed package consumer typecheck and negative type assertions |
| `node --test --test-concurrency=1 --test-reporter=tap tests/contracts/browser.test.mjs` | 221 passed, 0 failed/skipped |
| `npm test` | Build plus all 710 tests passed, 0 failed/skipped: 221 browser and 489 existing contract/packaging tests |
| `git diff --check` | Passed |

TAP outputs were captured under the worker's allowed temporary directory and summarized by test/pass/fail lines. One intermediate source compile reported TS2367 for a redundant union comparison; the comparison was reordered, then build and all final checks passed. The command guard reported exit 1, 203 MiB peak memory, zero swap and zero OOM kills for that compile; there was no resource failure or unrelated failure.

## Acceptance mapping

Names below refer to `tests/contracts/browser.test.mjs` unless otherwise stated.

| Acceptance | Test evidence |
| --- | --- |
| Representative bounded operations, encrypted metadata and exclusive lease contract | `accept representative action …` for all actions/wait conditions; `profile, lease and fenced successor shapes` |
| Each tenant/user/project/account/environment/purpose mismatch | `independent scope rejection: …` independently exercises profile, operation, lease successor, transfer and handback scope |
| Original job/task/request/instruction, native and routing identity | `original job binding: …`; `operation binds admitted request leaf: …` |
| Exact admitted actions, alias resolution authority, grants and transfers | `action authorization binds …`; `current authority, lease, cancellation and unknown effects fail closed`; `text labels, raw transfers, URLs and malformed destinations cannot grant authority` |
| Stale/expired leases, revision/epoch and safe-integer exhaustion | `profile, lease and fenced successor shapes`; current authority test; exact expiry equality and future issuance cases |
| Existing vault policy, origin/frame/document/navigation/profile/epoch and effect binding | `existing vault policy required: vault_fill/vault_capture`; `vault token capture and synthetic identity fill reuse destination policy` |
| Sanitized attestation bound to current request/session/epoch/operation, redacted/takeover alternatives | `sanitized attestation, redaction, takeover and unknown-effect observations`; strict nested observation variants |
| Requested/leased/handed-back/expired; wrong original job/challenge; stale or renewed handback; fresh authorization/fencing | `requested, leased, fresh handback and expired transitions`; `handback current binding: …`; `handback requires fresh authorized context and proven fencing`; original-job tests |
| Cancellation and unknown-effect preservation/no blind retry | Current authority test rejects cancelled dispatch and every accounted effect outcome; handback authority test rejects cancelled jobs; unknown observation requires reconciliation |
| Forbidden eval/shell/CDP/export/debug/screenshot/clipboard/reveal | `forbidden operation: …`; consumer negative action/type assertions |
| No nested raw cookies/storage/ciphertext/path/key/DOM/debug/output fields; unknown/accessor/hidden/symbol rejection | `strict nested data boundaries: …` covers every operation and all observation/takeover variants, custody/lease/revocation; `trusted contexts reject nested extra fields and accessors before reading them` |
| Malformed arrays, safe fixed errors, exceptions and immutable fixtures | `malformed arrays, throwing proxies, fixed errors and frozen input`; nested-boundary tests assert accessors were never invoked |
| Local cleanup cannot imply remote logout | `local deletion does not imply remote provider logout` exercises every local/remote combination, separate remote receipt and wrong profile |
| Public exports, server type-only context, readonly types and package compatibility | Consumer fixture and all existing packaging tests, extended for browser entrypoints/import graph |

## Limits

This evidence proves structural and trusted-context comparison behavior only. It does not prove authenticated context/adapter provenance, actual encryption, sanitization, target verification, concurrent lease exclusivity, durable fencing, browser isolation, persistence, remote logout or runtime security. Exact scope/target/account checks, approved nonsecret alias provenance, qualified adapters, atomic durable ownership and output gates remain host responsibilities. No Playwright, persistence, filtering, UI or provider runtime was implemented. Overall SDK completion and live-provider proof are not claimed.

## Reviewed source fingerprints

SHA-256 of the uncommitted implementation/test inputs above (generated build output excluded):

| File | SHA-256 |
| --- | --- |
| `src/contracts/browser.ts` | `eea74706815e4b85b42ac8d27b44f8d6c403d1dfd0836c5087cfb91cce18bb36` |
| `src/server/browser-policy.ts` | `3fb19ed0140fb40d7a1b0577f5bbbee866768883eb5f61166bfd82fbac164cc7` |
| `src/index.ts` | `ef9242941d31db80ec4fb97a6466c438b1fb644ba16afe18e4c1ccf8512e1fc0` |
| `src/server/index.ts` | `5707e900647a137b271aa247501a975134e34b5abb7b2628f499ea726f287a70` |
| `tests/contracts/browser.test.mjs` | `f4b5c89b299d3671641ee08b1923fabf4252663688e4c05762cbd682683ef2a3` |
| `tests/fixtures/consumer.mts` | `ea9ab19715ca2d889e8d2b1a76b60158acc683c88af975bf964361b50465a050` |
| `tests/packaging.test.mjs` | `23aa3c2abc73c6fed468f1d90f2bdb8698691970f87291c95b91a1d0eea47ce1` |
| `package.json` | `55a46f82b402b5e571a6be6385728c3a9a3586b3046ab1de31a95abe4b7a0453` |
| `docs/browser-contract.md` | `abd2881b5a9188683dded6ae76b38448c9acaca523998a2b6ac9e94ab7d60938` |
