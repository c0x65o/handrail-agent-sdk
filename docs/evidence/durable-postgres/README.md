# Durable PostgreSQL package qualification — 2026-09-30

**SDK source prerequisite qualified; Mills adoption and the original owner outcome
remain open.** Base: public `0.1.5`,
`715495490a9ab868dd55f486c1a9349c29ca852d`. Changes are on main, uncommitted for
Handrail's normal version/commit/push pipeline. No application, service, queue,
Handrail database, provider account/model, or deployment was changed.

The defect was confirmed in the original package manifest/exports and installed
fixture: concrete stores and schema/encryption helpers came from unpackaged
`reference/node`, through repository callbacks. The repaired fixture constructs
all seven durable stores, runtime, transport, checkpoint reader, application tool
adapter, assistance and notification delivery through public exports. Its module
loads and filesystem access cannot fall back to the repository. Separate child
processes use the same installed package and host-held fixture key.

| Final check (sequential) | Result | Evidence |
| --- | --- | --- |
| `npm test` (includes build, acceptance compile, reference compile, exports) | 777 passed, 0 failed/skipped | [contracts.log](contracts.log) |
| `tsc -p tests/fixtures/tsconfig.json` | Passed; complete application composition included | [consumer-types.log](consumer-types.log) |
| `node tests/run-local-postgres.mjs` | 350 passed across 17 suites, 0 failed/skipped | [postgres-all.log](postgres-all.log), [checks.json](checks.json) |
| Normal public HTTPS base install and fresh empty-cache lock reinstall, NodeNext and Bundler | Passed, full manifest/root/resolved/installed lock agreement | [installed-consumers.json](installed-consumers.json), [NodeNext install receipt](node-next-install-receipt.log), [Bundler install receipt](bundler-explicit-provider-install-receipt.log) |
| Final candidate `prepare`, strict installed consumer compile, both profiles | Passed, `skipLibCheck:false` | [NodeNext](node-next-final-prepare.log), [NodeNext types](node-next-final-types.log), [Bundler](bundler-explicit-provider-final-prepare.log), [Bundler types](bundler-explicit-provider-final-types.log) |
| Final external package-only runtime with real disposable PostgreSQL and actual Agents Runner | 36 passed, 0 failed/skipped | [installed-runtime.log](installed-runtime.log) |
| Ordinary package file dry run | Includes public PostgreSQL code, SQL, guide and example; excludes source/reference/tests | [package-dry-run.json](package-dry-run.json) |
| Relocation/preservation audit | Historical SQL and metadata byte-identical; nine relocated algorithms unchanged except imports/type names/comment | [move-audit.json](move-audit.json) |
| Final implementation/test fingerprint | Retained for review against pipeline output | [source-sha256.json](source-sha256.json), [fixture-sha256.json](fixture-sha256.json) |

Environment: Node 22.23.1, npm 10.9.8, TypeScript 5.9.3, PostgreSQL 15.19,
Agents 0.18.0. Consumer Node declarations: 22.20.4/NodeNext and 22.18.0/Bundler.
All test clusters were stopped and removed. No live provider credentials or spend.

The 36 external tests include read/effect/read, failed-read research/calculation,
structured history, transient attachment resolution, native answer completion and
same-job resume in a new process, SIGKILL after a provider mutation and safe
reconciliation, Stop/late output, same-job concurrent delivery, concurrent tenant
scopes, revoked/current authority, stale instruction identity, duplicate answers,
uncertain effects, key rotation/wrong/missing keys, repeatable/concurrent/failed
migrations, real catalog dispatch, native protocol projection/replay and shared
notification delivery without duplicate sends. Negative controls reject a planted
`.reference-build` module and deny a repository filesystem read. The official
OpenAI client and Responses adapter run against simulated SSE, including a model
boundary rejecting temperature and another asserting configured sampling. Model,
sensor, notification provider and host domain authorization inputs are simulated;
PostgreSQL, encryption, transaction algorithms, Agent and Runner are real.

Initial failures are retained: the example initially supplied lease authority to
the effect service's different authority port ([diagnostic](initial-example-type-failure.log));
the example now exposes the correct typed host port. A later reference compile
caught removal of a still-used Drizzle index import ([diagnostic](contracts-initial-reference-compile.log));
that import was restored. Initial source compilation also exposed upstream
Drizzle declaration errors for unrelated drivers. Internal build uses
skipLibCheck (as the old reference build already did); public declarations avoid
Drizzle and both external consumers compile strictly without skipping libraries.
These preliminary failures are not final passes; the table above records reruns.

## Delivery and remaining limitations

The external fixture starts from an **ordinarily installed public HTTPS base**, then
uses a clearly recorded **uncommitted candidate source overlay** compiled by normal
`prepare`. Source/scripts are removed before runtime testing. It is not a fresh
public install of the repaired revision, which cannot exist before the owning
pipeline commits and pushes. No tarball dependency, alternate publication route,
manual version bump, commit or push was used. The package dry run created no
publication. After publication, Avery must run:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_PIPELINE_SHA
```

Use no `--candidate-source` flag for that gate. Verify the final public commit and
then adopt that frozen SHA/lock through Mills' own authorized work.

The [public migration/key contract](../../postgres-runtime.md) and
[complete compilable composition](../../../examples/postgres-application.mts)
map the actual inspected Mills provider, history, tools, approvals, attachments,
metering and notification seams. Mills uses postgres.js/BetaSeedDatabase today;
this supported adapter requires a host-owned pg.Pool with the same approved
connection settings and an appropriate connection budget, not a cast of that
wrapper. No application store engine needs copying. Nonextractable remote KMS
operations are not implemented; the supplied encryption adapter takes host-owned
Node AES KeyObjects with old-key resolution. Durable per-invocation metering stays
at the approved provider wrapper/outbox; the runtime observer is best effort.

Avery still owns Mills engine, native approval, attachment, metering and notification
integration, original uncertain-delivery reconciliation, real approved-model
verification and independent web/Flutter QA. No live `gpt-6-astra`, deployed app,
full mobile parity, configured canonical reporter, flight source, object storage
repair, real reminders/travel/feedback or original-outcome completion is claimed.
