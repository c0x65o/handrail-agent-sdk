# Local PostgreSQL harness

This is a real PostgreSQL fixture for the independent reference Node host. It adds
no application schema, migration framework or Handrail persistence adapter. Read
[security boundaries](agent-security-boundary.md) and
[acceptance proof classes](agent-v1-acceptance.md). Published revision 1 of KB
`handrail-node-postgres-drizzle-contract` governs later application persistence;
this scoped test harness uses `pg` directly. The reference journal now uses
Drizzle with `pg` as its application driver; see [journal storage](job-journal.md).

## Explicit disposable connection

Supply `HANDRAIL_TEST_POSTGRES_URL` privately through the test runner environment,
and set `HANDRAIL_TEST_POSTGRES_DISPOSABLE=1` to attest that the target is a
dedicated, disposable PostgreSQL database. The URL must explicitly contain a
host, port, database, user, nonempty password and exactly one query parameter:
`sslmode=disable` for an isolated local fixture, or `sslmode=verify-full` for a
verified TLS connection. Percent-encode credentials. Other URL options, Unix
sockets and implicit authentication are unsupported. Never print the URL, put it
in command arguments, retain it in evidence, or commit it.

The fixture role needs CONNECT and CREATE on this disposable database. It must
not have access to application databases. At least five connections must be
available (two schema administrators, two subject clients and a sentinel client).
The caller, not a database name heuristic, is responsible for supplying an
authorized disposable target. No database is selected, created or reset by the
harness. Never use production/shared databases or Handrail's
`scripts/prepare-test-db.mjs`.

`DATABASE_URL` is ignored. Any `PG*` setting or `NODE_PG_FORCE_NATIVE` makes setup
fail before opening a client; use a clean runner environment. There is no
credential discovery, `.env` loading, pgpass fallback or default connection.

## Run

Use Node >=22. Install locked development dependencies through the authorized
worker preparation path (locally: `npm ci --include=dev`). With the two dedicated
variables injected privately, run:

```sh
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
npm run test:postgres
```

`npm test` runs the existing contract suite and also strictly compiles the helper.
It does not claim database acceptance. `test:postgres` strictly compiles
`tests/helpers/postgres.ts` to ignored `.postgres-build/postgres.js`, then executes
the single `.mjs` Node TAP smoke test with concurrency 1. There is no implicit
TypeScript execution and nothing is added to shipped `dist`.

The smoke test checks distinct PostgreSQL backend IDs, invisible uncommitted
writes, visible committed writes, rollback after a callback failure, disconnection
with an open transaction, removal of the subject schema, and preservation of a
second independently owned schema and synthetic sentinel row. Both fixtures
register their own teardown immediately after creation. A passing database run
must report 1 test passed, 0 failed and 0 skipped.

## Ownership and failure behavior

Each harness creates a UUID-named schema without `IF NOT EXISTS`, retains its OID
privately, and exposes qualified table identifiers and independent clients.
Always use qualified identifiers; the session search path is `pg_catalog`.
Register `t.after(() => harness.cleanup())` immediately. Transactions commit on
callback success and roll back on failure. Do not share a client across concurrent
transactions or mix manual transaction commands with `transaction()`.

Cleanup closes every subject client first (rolling back outstanding transactions),
checks the exact schema/OID, then transactionally drops its ordinary tables and
schema with `RESTRICT`. It never drops databases or scans by schema-name prefix,
and never uses `CASCADE`, which could remove unrelated dependent objects. The
sentinel's separate teardown owns only its own schema. Use ordinary fixture
tables and their local indexes/constraints; do not attach objects across schemas.
Additional objects such as views, standalone sequences, functions or partitioned
tables require their own explicit teardown before harness cleanup. Dependencies
or remaining objects cause cleanup to roll back and fail, preserving the schema.
This trusted fixture helper is not a sandbox for arbitrary SQL.

Missing configuration fails with `POSTGRES_DISPOSABLE_CONNECTION_REQUIRED`;
invalid/ambient configuration and unavailable PostgreSQL also fail with fixed
codes. Driver exceptions, notices, connection fields and causes are never logged
or returned. Query/lock/connect timeouts are bounded. Failed teardown reports
`POSTGRES_CLEANUP_FAILED` and closes the administrator; it does not broaden cleanup
or silently retry. A network outage, ambiguous commit or killed process may leave
an owned schema. Dispose of the dedicated fixture database through its original
fixture owner after the run; never infer authority to reset a shared database.
Missing/unavailable database failures are not skipped tests or PostgreSQL proof.

## Native verification handoff

Save the candidate and install dependencies before calling
`handrail_run_read_only_tests` with `profile=sdk`. Its inspect and run calls need
the same explicit commands: build, acceptance fixture compile, PostgreSQL helper
compile, consumer typecheck, the existing TAP suite, and the PostgreSQL TAP test.
Run only with the inspected `candidate_sha256` and a unique `request_key`. The
verifier cannot download dependencies or access host databases/credentials. Verify
its supported disposable PostgreSQL supply before any connection; do not pass a
host connection into it. Retain native receipts, candidate identity, TAP totals
and unverified checks separately from local results. This writer run's initial
inspection was rejected because the tool requires its own active read-only
validation work request; that restriction must be resolved in the verification
handoff, not bypassed with host SQL.

## Reference journal acceptance

`npm run test:journal` builds the separate reference target and exercises generated
Drizzle migrations and the journal using this same harness. `TestClient.database()`
is a trusted-test Drizzle boundary over the owned client; never log its internals
or raw Drizzle exceptions. The journal normalizes failures, and migration tests
catch exceptions without retaining payloads or causes. SQL names remain qualified
and the search path remains `pg_catalog`. Cleanup rules above are unchanged.

On a non-root Linux worker with `/usr/lib/postgresql/15/bin`,
`node tests/run-local-postgres.mjs` can create a fresh temporary cluster and run
vault, lease, admission, journal and smoke suites. This optional fixture runner uses only its own
random credentials and database, then stops/removes the owned cluster. It does
not discover credentials or select an existing database. Missing binaries or
startup/test failures fail the command. These are real PostgreSQL fixture results,
not live provider or deployed Handrail-host acceptance.

## Authorized admission acceptance

`npm run test:submit` uses the same real PostgreSQL harness and generated Drizzle
migrations for atomic request reservations and initial journal writes. It runs
only against the explicitly disposable connection above. The local fixture
runner now includes this suite before journal/harness regressions. See
[job admission](job-admission.md) for namespace, digest and authorization rules,
and [fixture evidence](evidence/job-admission.json) for actual results.

## Runtime lease acceptance

`npm run test:lease` executes real PostgreSQL races through the shared Drizzle
boundary and generated migrations. It is included first in the disposable runner.
Distinct backend IDs and observed lock waits establish concurrency; injected
host time controls expiry. See [lease fencing](job-lease.md) and
[local fixture evidence](evidence/job-lease.json) for scope and results.

## Reference vault acceptance

`node tests/run-local-postgres.mjs test:vault` selects only the encrypted custody
suite; omitting arguments runs all persistence suites sequentially.
`npm run test:vault` strictly compiles the TypeScript suite and uses the explicit
disposable connection above. See [vault storage](vault-store.md) for fresh-process
proof, private key fixtures, canary scans and the limits of local acceptance.

## Reference vault lifecycle acceptance

`node tests/run-local-postgres.mjs test:vault-lifecycle test:vault` strictly compiles
reference source and private fixtures, then runs only lifecycle and existing vault
TAP suites with concurrency 1. The disposable cluster and schema ownership rules
above apply unchanged. Lifecycle coverage includes exited-process preparation and
recovery, exact versioned key resolution, rotation CAS/rollback, terminal fencing,
interrupted cleanup, restored ciphertext rejection and a one-time migration of
existing v1 envelopes. See [vault lifecycle](vault-store.md#rotation-recovery-and-terminal-fences)
and [local evidence](evidence/vault-lifecycle.json); neither is a native verifier
receipt or production key-service qualification.

## Reference browser-profile persistence acceptance

`node tests/run-local-postgres.mjs test:browser-profile test:vault-lifecycle test:vault`
selects profile persistence plus the shared-encryption vault regressions. The
profile suite builds the private TypeScript reference target and runs serially
against the same isolated PostgreSQL harness. It launches fresh Node processes,
not browsers or an application service. See [profile custody](browser-profile-store.md)
for supported state, exact scope, CAS, durable fences and fixed recovery results;
[redacted evidence](evidence/browser-profile-store.json) binds results to the dirty
candidate as well as the source HEAD. This is local SQL proof, not independent
runtime QA or a native release receipt.
