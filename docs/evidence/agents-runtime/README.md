# OpenAI Agents replacement readiness — 2026-09-30

**Verdict:** ready for a bounded trusted-server integration trial after the
pipeline delivers and verifies the new Git revision. **Not qualified for a
general unattended/browser-sensitive application rollout.** No pilot application
has been selected or migrated. Execution and persistence are implemented, not
merely proposed; the original deterministic executor and copied distribution
candidate are removed.

## Verified

| Check | Result | Evidence |
| --- | --- | --- |
| Normal `npm ci --include=dev` / prepare | Passed; ordinary TypeScript build | [prepare.log](prepare.log) |
| `npm test` plus explicit consumer `tsc -p tests/fixtures/tsconfig.json` | 773 passed; compile exit 0 | [package-final.log](package-final.log) |
| `node tests/run-local-postgres.mjs` | 315 passed, 0 failed/skipped across 16 suites | [postgres-final.log](postgres-final.log) |
| Final focused Runner/provider + journal checks | 17 runtime and 14 journal tests passed | [agents-final.log](agents-final.log) |
| Anonymous public Git full-SHA install, prepare, installed exports/types and matching lockfile | Passed for **pre-change baseline only**, `32ac1c88d02c3e5434ec1094e1e0e5724fdbce9c` | [git-install-baseline.log](git-install-baseline.log) |
| Runtime dependency audit | 0 reported findings (`--omit=dev`) | [runtime-audit.json](runtime-audit.json) |

Environment: Linux, Node 22.23.1, npm 10.9.8, TypeScript 5.9.3,
PostgreSQL 15.19, OpenAI Agents SDK 0.18.0, Zod 4.3.6. Checks ran sequentially
with test concurrency 1. The existing `tests/run-local-postgres.mjs` created a
fresh localhost cluster, disposable database, non-superuser fixture role and
isolated per-test schemas, applied real migrations, then stopped and removed its
cluster. No existing application database was used.

The actual Runner executed stock lookup → protected reservation → receipt
verification, and a materially different research/fallback-price → quote task.
Coverage includes deliberate tool failure/recovery, provider failure/recovery,
current authorization, cross-process approval/answer/input resume, reordered JSON
identity, Stop, lost lease, revoked grant, tenant isolation, duplicate delivery,
context bounds, unknown effects, and SIGKILL after a synthetic mutation commits.
A separate provider ledger counts dispatch attempts; recovery asserts one attempt,
not just one idempotent row. The Vault composition test uses real custody,
grants and effects with a synthetic private token and checks that the value never
enters RunState/public output. Existing card/password/SSN/token and browser-profile
regressions remain covered by the broader suite.

These are **simulated external boundaries**, not live model qualification.
Most runtime cases inject the documented `Model` boundary; the additional test
uses the official OpenAIProvider and OpenAI client with only HTTP/SSE replaced.
The real Runner, tools, RunState, authority ports, SQL stores, leases and effect
reconciler run in both. This does not prove a real model can plan the tasks.

The first full database run had one failed Vault upgrade fixture, retained in
[postgres-initial.log](postgres-initial.log). Its rewind-to-v1 cleanup omitted the
new state table. The fixture now drops that table before replay; the generated
migration and snapshot are included as source, and the clean full rerun passes.
Earlier implementation checks also caught TypeScript generic inference, a
fixture's order-sensitive identity comparison, and packaging trace output buffer
overflow. These were repaired; package checks now compile normally and use the
TypeScript resolver API instead of dumping transitive resolution traces.

## Remaining gates and host work

1. **Pipeline delivery:** this worker must not commit/push or bump versions.
   After delivery, run `node tests/verify-git-install.mjs <delivered-full-SHA>`.
   Candidate self-export/type checks and a baseline Git install do not prove
   installation of the new unpublished revision.
2. **Live model check unavailable (missing configured capability):** scoped
   Handrail context reports zero SDK dev capabilities, generated/explicit env
   bindings and dev services. No provider credential was retrieved or substituted.
   A bounded synthetic smoke through an authorized host connection remains.
3. **Chosen-host integration:** implement/verify current-principal authority,
   private state/key custody, admission/journal/lease/effect ports, answer routing,
   Stop, output-evidence verification, durable inbox and scheduler delivery in the
   eventual application. The PostgreSQL reference is tested but intentionally
   not a native Handrail adapter. Paused new input is supported; active-run inbox
   ownership remains with the host. Exact native boundaries are listed in the
   [migration guide](../../agent-runtime.md#native-integration-boundaries).
4. **Browser/native adapters:** general browser control/takeover, restoration,
   confidential observations/artifacts, native Vault and Marketing composition
   require application-level qualification. The secure Vault composition preserves
   private filling and does not add charging/payment-gateway behavior. No Dots/Muse
   parity or live iMessage claim follows from this replacement.
5. **Sustained operation:** the existing journal replays full history under a row
   lock and retains at most 256 effects. The runtime caps context/state/turns/tools
   and fails closed, with a 64 KiB reference state limit. Long-horizon compaction,
   load/recovery soak, state-format upgrades and host key rotation/retention remain
   unqualified. Usage reflects completed SDK checkpoints; interrupted provider
   attempts without usage responses are unmeasured, not zero-cost.

No production writes, provider account mutations, customer effects, deployment,
queue changes, PR, Git commit or push were performed. All intended source changes
are left on main for the configured delivery pipeline.

## Reference sources

The local OpenAI documentation skill was absent. Implementation was checked
against the pinned package's declarations/implementation and the official
[Runner](https://openai.github.io/openai-agents-js/guides/running-agents/),
[human-in-the-loop/state](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
and [session](https://openai.github.io/openai-agents-js/guides/sessions/) documentation.
RunState owns this logical job's history; no second conversation engine or
parallel session store was introduced.
