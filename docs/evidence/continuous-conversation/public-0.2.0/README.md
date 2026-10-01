# Continuous conversation foundation — public 0.2.0 qualification

The shared SDK implementation is qualified at public commit
`8f72cef9d459567acbc54f62e1175081617ab20d`, version **0.2.0**. This continuation
closes the earlier candidate-overlay qualification limitation. It does not accept
Mills integration or authorize Avery migration/cutover.

Work request: `628cc5f3-d13d-58b6-8839-594c4a093961`.
Qualification run: `22a3abd5-f3a4-4102-892d-e7d5cb27b4b2`, 2026-10-01 UTC.
Current-context MCP confirmed the same project/request; the complete frozen
instruction sources were read (offset 0, next=null). No new owner decision was
needed. The checkout was clean at this already-existing commit when resumed.
This worker did not commit, push, deploy, modify Handrail state, or call a live
provider/native executor. Only evidence files were added in this continuation.

## Delivered implementation

The usable destination remains the reusable trusted-server SDK foundation before
application migration. It supplies direct injected-model chat and streaming using
the upstream OpenAI Runner, canonical role-preserving transcript with bounded
retrieval and staged upstream compaction, exact-source obligation/correction
pins, scoped memory revision/forget/staleness, durable native-work bindings and
once-only canonical result insertion, and opt-in encrypted paged RunState.
Existing effects, approvals, leases, recovery, schedules, watches, notifications,
tools and application transport remain the execution mechanisms.

The [integration guide](../../../continuous-conversation.md) and
[runnable headless host](../../../../examples/continuous-conversation.mts) are
packaged with the SDK. The [original source report](../README.md) retains the
first-party Dots/Muse/Agents comparison, Avery contract inventory, authority
matrix, implementation rationale and initial failed/corrected test evidence.
Its candidate/publication statements describe that earlier run, not the current
public qualification.

## Fresh verification

Checks ran sequentially with Node 22.23.1, npm 10.9.8, TypeScript 5.9.3,
OpenAI Agents 0.18.0 and real disposable PostgreSQL 15.

| Check | Result |
| --- | --- |
| `node tests/verify-git-install.mjs 8f72cef9d459567acbc54f62e1175081617ab20d` | Passed, **no candidate overlay**. Two fresh public HTTPS installs and separate empty-cache lockfile reinstalls, ordinary prepare/build. |
| Installed NodeNext consumer, Node types 22.20.4 | Strict compilation passed, `skipLibCheck:false`. |
| Installed Bundler/explicit-provider consumer, Node types 22.18.0 | Strict compilation passed, `skipLibCheck:false`. |
| Installed runtime suite | **87 passed**, zero failed/skipped; filesystem and module guards prohibit repository/reference/source fallback, including recovery children. |
| `npm test` | Build and acceptance/reference/Postgres compilation passed; **777 passed**, zero failed/skipped. |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Strict consumer/example compilation passed. |
| `node tests/run-local-postgres.mjs` | All 18 suites completed: **401 passed**, zero failed/skipped. Owned temporary cluster stopped and removed. |
| Source/build binding | All **63** implementation/migration files match the previous candidate hashes. All **110** local distribution files match the fresh public install byte-for-byte. Only the package manifest/lock differ from the prior candidate's recorded hashes. |

The full PostgreSQL run includes both previously corrected migration fixtures;
their current results pass. The earlier 397/399 result is preserved in the
historical report rather than overwritten. The current suite has 401 checks,
including the final additional conversation recovery/race coverage.

Public install and lock use
`git+https://git@github.com/c0x65o/handrail-agent-sdk.git#8f72cef9d459567acbc54f62e1175081617ab20d`.
The assistant dependency retains its frozen public SHA
`921a5650f1937504a124574ad795ea222555a684`, with matching HTTPS resolution.
No SSH protocol or credential helper was available to the qualification process.

Runtime coverage includes actual Runner multi-turn context/compaction,
memory isolation/revision/forget, two materially different tool consumers through
the same exported composition, responsive replies while native work remains
active, cold-process replay, original result/receipt identity, uncertain effects,
correction/revocation, pause/cancel callbacks and paged checkpoints beyond 64 KiB.
Provider/compaction responses and native executor receipts are simulated;
PostgreSQL, encryption, transactions, Runner, tools, effects and process restart
are real. These tests do not measure live model quality or provider latency.

## Evidence and remaining acceptance

[Validation summary](validation-summary.json),
[public verifier log](qualification.log),
[installed runtime log](installed-runtime.log),
[local contracts log](npm-test.log),
[full PostgreSQL log](postgres-all.log),
[consumer compile log](consumer-typecheck.log),
[installed profile metadata](installed-profiles.json),
[source comparison](source-comparison.json) and
[distribution comparison](build-comparison.json) are retained here.
Both profile subdirectories retain install/reinstall/typecheck logs and the exact
consumer manifest/lock. The evidence index records their SHA-256 hashes.

SDK publication availability and installed-only qualification are now verified.
Application acceptance remains open: canonical-store mapping/migration, native
executor/callback adapters, current authentication/approval/tool/attachment
bindings, provider metering, independent Mills web/Flutter acceptance, rollback
and an explicitly authorized Avery cutover. Host authority still owns business
acceptance and native pause/cancel. Canonical result insertion is not proof of
exactly-once external delivery. Memory forget does not erase backups or admitted
snapshots. No infrastructure, production migration or application modification
was performed. Avery should review this evidence under the same original request.
