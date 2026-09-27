# Job lifecycle contract acceptance evidence

Selected Owner Task item: `691d1bd9-a268-4d93-8d71-706d812dbaa3`.

Baseline: clean `lane/agent-sdk-v1` at `374c276df67bd25e5d8f0ee2fbafb5f0b955d056`. Validated 2026-09-27 with Node `v22.23.1` and TypeScript `5.9.3`. Source is an uncommitted patch; no resulting commit SHA is claimed. Current-context MCP verified goal `1b13c4ab-38c2-4d78-a5cb-238e2f257c62`, task `7ccb807a-4e38-42c7-bf23-73d62adec118`, project and selected lane. Owner Task start/progress/completion use the scoped ledger tool.

## Compile, separately from test counters

| Exact command | Exit | Compile result |
| --- | --- | --- |
| `npm run build` | 0 | Strict NodeNext source compile and declaration emission passed. |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | 0 | Public consumer typecheck passed, including expected compile errors for identity/route mutation, success without receipt, unbound resume event, UI dispose command and private imports. |

Dependencies were installed using `npm ci --include=dev --ignore-scripts` (exit 0); the existing lockfile is unchanged. An intermediate compile caught TS2352 after the event type was tightened; the guarded cast was corrected before the final successful compile. This was not a test failure or an unrelated baseline failure.

## Node tests

| Exact command | Exit | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- | --- |
| `node --test --test-concurrency=1 --test-reporter=tap tests/contracts/job.test.mjs` | 0 | 62 | 62 | 0 | 0 |
| `node --test --test-concurrency=1 --test-reporter=tap tests/packaging.test.mjs` | 0 | 5 | 5 | 0 | 0 |
| `npm test` | 0 | 67 | 67 | 0 | 0 |

All runs also report 0 cancelled and 0 todo. `npm test` successfully runs its build pretest before both Node suites; that compilation is not included in the test count. `git diff --check` exits 0.

## Acceptance mapping

| Requirement | Evidence |
| --- | --- |
| Six states, valid/rejected transitions | Six snapshot cases, all 36 source/destination state pairs, initial admission, same-state answer and effect-accounting cases. |
| Verified success | Missing/wrong receipt verification, job, revision and unknown-effect success are rejected. Validation checks the host assertion's contract, not external truth. |
| Same original task through waiting/answer/resume and attempts | Synthetic end-to-end contract trace; every identity leaf is independently changed and rejected, including routes, host scope and native references. Delivery callback/queue remains separate. |
| Revisions and current waiting requirement | Invalid numeric revisions, duplicate/stale/skipped events, stale/consumed answers, changed requirement, command substitution and internally inconsistent event batches are rejected. All waiting/actor kinds and missing references covered. |
| Cancellation and observation separation | All terminal outgoing transitions fail; resume/answer/repeated cancel after cancellation fail. Inspect/events do not mutate input; dispose/view-close cancellation payloads fail. Compile-time observation interface is covered; no UI runtime behavior is claimed. |
| Unknown effects | Original entries survive waiting, failure and cancellation; deletion, replacement, duplicate identity and implicit resolution fail. Reconciliation remains outside scope. |
| Safe runtime payloads | Recursive unknown-field injection across snapshot/command/event/result boundaries, including arrays, is rejected with no synthetic value in validation errors. Malformed records, accessors, symbols, hidden fields, unsafe references and unbounded/raw errors are rejected. |
| Public exports and packaging | Root exports resolve; import processes exit naturally; static import graph checks reject startup calls/imports; declarations resolve through package exports; implementation deep imports remain private. |

Changed files: `src/contracts/job.ts`, `src/index.ts`, `package.json`, `tests/contracts/job.test.mjs`, `tests/fixtures/consumer.mts`, `tests/packaging.test.mjs`, `docs/job-contract.md`, and this evidence file. Generated `dist` and installed dependencies are ignored. No dependency or version change.

These are pure synthetic contract tests. No datastore/fake database, workers, scheduler, adapter, provider, credentials, browser or live integration was used. No QA campaign was launched. Runtime durability, external receipt verification, cancellation fencing and provider proof remain separate items. No commit, push, PR, deployment, publication, or runtime/configuration change was performed. Only the selected contract item is complete, not the broader runtime or Convergence goal.
