# Reference Node job journal

`src/server/job-store.ts` exports the injected `JobStore` type through the server
entrypoint. `src/server/postgres/job-journal.ts` implements it; the reference host reuses
that implementation. Public Pool-based composition is documented in
[the PostgreSQL runtime guide](postgres-runtime.md). It opens no connection on import.
The host supplies an owned Pool (or one dedicated Client per concurrent caller),
then `createJobJournal(referenceDatabase(client))`. Do not overlap transactions on
one Client. The application namespace is `agent_reference`; tests explicitly pass
`journalTables(harness.schema)`.

The authenticated host must authorize **both** reads and appends and supply
approved nonsecret references. Equality checks fence identities; they do not
verify principal authority, receipt truth, grant scope or instruction ownership.
An identifier-shaped secret is still forbidden. Handrail will implement this port
over native authoritative task services, not deploy this reference journal as a
second controller. [Admission](job-admission.md) now composes this journal with
atomic request-key reservations. [Lease fencing](job-lease.md) now protects runtime appends. Scheduling,
cancellation orchestration, answers, effect reconciliation and execution remain
separate work.

## Canonical facts and atomic revisions

The full immutable `JobIdentity` is stored in `jobs.identity`: six host scope
references, original task/request/instruction revision, every optional native
reference and original channel/route/correlation. The database primary key is
`jobId`; choosing IDs is the host's responsibility.

Canonical identity is `(jobId, snapshot.revision)`. Comparison includes kind,
previousRevision, the complete snapshot and any embedded command, with exact
scalar values and array order but independent of object property order. Delivery
is excluded. `append` returns that original canonical event with no delivery,
including when retrying an older revision after the job has advanced. Every
non-submitted append now also requires a current server-only `JobAppendFence`;
prefer `createJobLease(...).append/complete` to establish host authority around
the whole transaction. The initial admission append signature is unchanged. Changed
canonical content conflicts. It never merges or replaces a persisted fact.

`job_deliveries` separately retains the validated attempt/callback/queue identity,
keyed by job, canonical revision and attemptRef. A new delivery of the same fact
adds only a delivery row. Reusing an attempt with changed delivery content
conflicts. Rejected events add no delivery row. The origin's native source queue
is immutable and remains separate from these later delivery queues.

A transaction first inserts an initial revision-zero job row if needed, locks the
job row, validates canonical history and checkpoint, checks the immutable
identity and expected predecessor, and applies `validateJobTransition`. It then
inserts the event, advances the head with an explicit revision CAS, records the
delivery and writes the checkpoint. Unique keys, foreign keys and safe-integer
CHECK constraints reinforce the transaction. A late error rolls back every write,
including initial job creation. Driver errors and validation failures return only
fixed `JobStoreResult` codes, without payload, SQL, driver messages or causes.
An ambiguous commit is retried with the same canonical content and identity.

Inputs must be decoded data. Exact lifecycle allowlists reject unsupported raw
fields, accessors, hidden properties and symbols before serialization. Validated
input is detached synchronously before awaiting SQL and validated again; later
caller mutation cannot change the admitted write. Cancellation remains terminal;
unknown effects cannot disappear, be relabelled or authorize success.

## Checkpoints and recovery

`job_checkpoints` holds version **1**, revision and a validated snapshot. A
checkpoint is a disposable projection, never a source of facts. `load` locks the
job, reads the ordered canonical log and validates every event, contiguous
transition, immutable identity and head revision. It compares any checkpoint to
the actual canonical snapshot at that exact revision. Missing or valid stale
checkpoints are rebuilt atomically; ahead, incompatible, malformed or fabricated
checkpoints return `invalid_checkpoint` without changes. Invalid canonical
history returns `invalid_history`, even if a checkpoint agrees with the corruption.

This reference implementation deliberately verifies the entire chain on reads and
appends (linear history cost), rather than trusting a cached prefix. Checkpoints
are retained for recovery/projection consumers and future verified replay
acceleration; they currently do not bypass validation or reduce its cost.
The host must resolve rejected checkpoint corruption before further work; silently
ignoring an inconsistent checkpoint could accept fabricated progress.

## Migrations and verification

Typed schema, generated Drizzle SQL, snapshot and journal metadata live in
`src/server/postgres/migrations/`. `npm run db:generate` generates artifacts from
`drizzle.config.ts`. `npm run db:migrate` is an explicit operator command reading
`DATABASE_URL`; it uses Drizzle's standard transactional migrator with an
`agent_reference.journal_migrations` ledger. It must only be invoked against an
authorized reference-host database. It is not called by build, import or tests,
and no deployment or automatic migration is configured by this change. Apply the
additive migration before composing the reference host. To roll back application
adoption, stop using the port and retain the journal for recovery; no destructive
down migration is supplied.

Tests use the [disposable PostgreSQL harness](local-postgres-testing.md), relocating
only the generated migration's quoted namespace into the harness-owned schema.
The standard Drizzle migrator, its ledger and its table-owned sequence stay there.
The existing ownership/OID checks and `RESTRICT` cleanup remove the owned tables
and their owned sequence; no standalone objects or external schemas are created.
An independent schema sentinel proves isolation. Failed migration execution
rolls back all generated application tables and the ledger insertion.

With the documented disposable variables privately injected, run
`npm run test:journal` and `npm run test:postgres`. Without them these commands
fail; missing SQL execution is never a skip or passing acceptance. Linux workers
with PostgreSQL 15 binaries can instead run `node tests/run-local-postgres.mjs` as
a non-root user. It creates a new temporary cluster, database and non-superuser
fixture role, privately injects only its own connection, runs lease, admission, journal and harness commands, then
stops and removes that cluster. It does not read or modify an existing database.

`npm test` compiles both reference code and the helper, and runs the existing
contract/package regressions. `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` checks public consumers. Drizzle-backed compilation
uses `skipLibCheck` for third-party declarations; repository source stays strict.
See [scoped SQL evidence](evidence/job-journal.json) for exact commands and counts.
