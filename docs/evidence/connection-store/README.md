# Connection store acceptance

Selected item: `26112afc-09aa-42d2-8ec9-df98a00b07e7`; Owner Task: `7ccb807a-4e38-42c7-bf23-73d62adec118`; goal: `1b13c4ab-38c2-4d78-a5cb-238e2f257c62`; implementation work request: `b0cd16f7-dbcc-405a-b0d1-9110d30cca4b`.

Post-change CI repair: [repair evidence](ci-repair.md) and [final source manifest](ci-repair.json) extend the original evidence below. The Vault lifecycle migration-rewind fixture now removes the new connection tables before replay. The exact full PostgreSQL CI command passes 273 tests; the connection contract passes 63; all three requested builds pass. There are no failed or skipped tests in these final runs, and cleanup left no owned temporary directories. The original implementation hashes remain unchanged.

## Source and authority

Before editing, verified the requested isolated worktree, branch `lane/agent-sdk-v1`, HEAD `e3c0e6d5790cf02fcd9fbc005c705d09148ba3e3`, and empty tracked/untracked status. No applicable AGENTS.md was present. `handrail_current_context` confirmed the project, task, item and native SDK-only publication policy (`publication_denied=false`, `auto_commit=true`). Source is intentionally uncommitted; the queued worker's native workflow owns versioning/commit/push. No PR or deployment was performed.

Read the connection contract and its prerequisite evidence, journal and lease ports/implementation, Vault-use/grants/lifecycle boundaries, schema and migration helpers. Read published KB `handrail-ai-sdk-implementation-contract` revision 1, entry `664f7487-aeda-476a-8aed-35d93426b07b`. Applied its host authority and persistence requirements with the stricter Agent rule: raw sensitive diagnostics are never sent to any sink. No existing connection controller/caller was found; orchestration is a later item.

`candidate.json` binds every changed implementation/test/harness/metadata file to its SHA-256 and records a deterministic aggregate candidate digest. It separately records the implementation digest (unchanged between both SQL runs) and saved receipt hashes. The HEAD is a baseline, not a claim that this candidate is published.

## Implemented boundary

`src/server/connection-store.ts` defines the trusted server port and `reference/node/connection-store.ts` implements it over the injected, host-owned Drizzle database. Factory construction opens no database connection and starts no service. `withAuthority` must hold authenticated scope, native cancellation/ACL and external custody/grant authority stable through callback and commit. Hosts resolve approved opaque references and authenticate verification provenance; structural validation cannot prove provider facts. Optional reference job fences acquire the existing job row lock before the connection lock and recheck the existing lease/cancellation fence before transaction completion.

Admission preserves the entire original request separately from private credential state. The connection reference is a primary key; SQL also enforces a unique logical key of all six scope dimensions, provider, ordered capability-requirement digest, recipe/prerequisite version and evidence mode. A competing alias conflicts; changing admission content under an existing reference fails. A new admission cannot silently rebind an existing connection to another original task.

Each mutation appends its canonical command/snapshot and CAS-updates the current revision in one transaction. Identical retries at the current revision return the original fact (including original revocation time). Older mutation retries conflict after the head advances; admission retries return the original non-ready admission. Reads and ready retries check current time. Rotation can advance credential and/or grant revisions monotonically and atomically clears ready evidence. Revocation records a local fence before any cleanup; it does not claim remote revocation. A revoked connection needs an advanced grant revision before reauthorization. Ready publication requires current credential/grant bindings, active authority, current evidence and bounded credential/grant expiry.

Canonical receipt rows permanently bind receipt identity, evidence content/provenance, connection and credential/grant revisions. Intermediate states cannot erase these bindings or relabel fixture receipts as provider evidence. Unknown effects preserve their original effect and reconciliation reference through reconnect, rotation and revocation. Mutation errors roll back receipt/history/head together and expose only fixed error codes.

Migration `0012_connection_store.sql` adds three small tables (head, revision facts, receipts), constraints and foreign keys. Generated Drizzle journal and snapshot metadata are checked in. This is additive: existing job and Vault tables are unchanged. Hosts must apply the migration before using this port; rollback can stop using the new port while retaining the ledger. Never discard receipt/revision history or restore it from stale custody backups.

## Executed validation

Environment: Node `v22.23.1`, npm `10.9.8`, TypeScript `5.9.3`, disposable PostgreSQL 15. Checks ran sequentially; test concurrency was 1. Compiles are checks, not test coverage.

| Exact command | Result |
| --- | --- |
| `node node_modules/drizzle-kit/bin.cjs generate --name=connection_store` | Exit 0; one additive SQL migration plus journal/snapshot metadata |
| `npm run build` | Exit 0 |
| `npm run build:reference` | Exit 0 |
| `npm run build:test-reference` | Exit 0 |
| `node --test --test-concurrency=1 --test-reporter=tap tests/contracts/connection.test.mjs` | 63 passed, 0 failed, 0 skipped |
| `node tests/run-local-postgres.mjs test:connection-store test:journal test:vault-use` | Exit 0; connection 21/21, journal 14/14, Vault-use 41/41; 0 failed/skipped |
| `node tests/run-local-postgres.mjs test:connection-store` | Exit 0; final connection suite 23/23, 0 failed/skipped; recompiles all reference/test source |
| `git diff --check` | Exit 0 |

The final focused rerun followed two added acceptance cases and stronger constraint/cleanup assertions; implementation source was unchanged from the combined regression run. Final distinct coverage is 23 connection SQL tests + 14 journal + 41 Vault-use + 63 connection contract tests = **141 passed, 0 failed, 0 skipped**. Repeated execution is not counted as additional coverage. No unrelated pre-existing test/build failures were observed.

The SQL suites used `tests/helpers/postgres.ts`, `tests/helpers/migrations.mjs` and the existing disposable runner. Every fixture migrated an isolated schema under a dedicated non-superuser role. The new suite explicitly proves all 13 migrations rerun, SQL logical uniqueness/revision constraints, complete rollback after late SQL failure, schema removal, and preservation of an unrelated sentinel. Deterministic barriers and independent backend connections cover verification racing revocation/rotation, concurrent reconnect CAS, and expiry after a held SQL row lock. Fresh-connection restart restores the same reference, snapshot and receipt. Other cases cover successful current verification, all six wrong scope dimensions, stale grants, expiry, conflicting/identical retries, receipt/provenance conflicts, unknown effects, caller mutation, accessor rejection, redacted exceptions and composed SQL cancellation fences.

Saved redacted receipts: `disposable-run.txt` (combined run) and `final-connection-run.txt` (final focused run). Both runners stopped their owned clusters and exited 0. Post-run directory-only inspection found **0** remaining `postgres-*` directories and **0** migration temporary directories in `.reference-build`. No connection values, credentials or raw provider failures are in retained artifacts.

These are synthetic persistence fixtures, including synthetic provider-labelled metadata used only to prove provenance denial. No live provider proof, OAuth flow, connection workflow, browser/UI work, installed-host acceptance or independent QA is claimed. Those remain separate task-list items. No blocker or follow-up work is needed to finish this selected store item.
