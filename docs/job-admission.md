# Authorized job admission

`createJobAdmission(host, store)` is exported by `handrail-agent-sdk/server`.
It implements submission and inspection only. The injected host authenticates and
authorizes; the injected store owns atomic persistence. Importing or constructing
the API opens no connection and starts no services, effects, claims or scheduler.
Handrail must implement the persistence port over its native task owner. The
reference Node store is an independently composable PostgreSQL implementation,
not another Handrail controller.

## Trusted host boundary

A submission contains only `requestKey`, `originTaskRef`, `instructionRevision`
and `operation: { operationRef, inputRefs }`. `inputRefs` is a bounded record of
named nonsecret references, not arbitrary arguments or instructions. The host
must approve each reference and the exact original task/instruction binding.
Raw sensitive inputs belong on qualified private routes. Identifier syntax alone
cannot distinguish a nonsecret reference from an identifier-shaped secret.

`authorizeSubmit` resolves current authenticated tenant, actor (`userRef`),
project, account, environment, purpose, namespace and positive grant revision. It
also resolves the original native and channel/route/correlation references. The
callback must derive these from trusted request context and native ownership,
not copy claims from the caller. Omit native references when no native object
exists. Keep original identities stable on retries; do not substitute the new
request's delivery or turn identity. `newJobId` generates a globally unique
nonsecret candidate ID; a successful replay discards that candidate.

`authorizeInspect({ jobId })` must authorize access to that exact job using current
host ACLs, original instruction ownership and grants, and approve release of its
original task reference. Possession of a job ID or previous receipt is not
permission. It returns the current host scope, namespace and grant revision.
A fresh grant revision may authorize inspection without replacing the original
admission. Both callbacks run anew before persistence and again before receipt release,
including retries. Changed or revoked authority suppresses the output without
undoing committed admission. Hosts remain responsible for policy changes and any stronger transactional authority
fencing required by their native authorization owner.

Decoded records are validated and detached synchronously before asynchronous
work. Unknown fields (including caller identity/grants), symbols, hidden
properties, accessors, executable objects, cycles, arrays and nonreference
operation values are rejected. The host gets a separate copy so neither later
caller mutation nor host mutation of its argument changes the binding. Trusted
host outputs are also detached and validated. Host denial/exception is
`not_authorized`; invalid input is `invalid_payload`; conflicting admission is
`conflict`; persistence failures are `unavailable`. No driver/host exception,
SQL, raw payload or error cause is returned.

## Reservation namespace and immutable content

The durable reservation key is the exact tuple:

```
(tenantRef, userRef, namespaceRef, requestKey)
```

`namespaceRef` is a **host-derived stable partition**, not a caller escape hatch.
Tenant and actor namespaces are independently isolated. A host may allocate
independent namespaces for account/environment/project workflows; the same
request key can then identify separate authorized jobs in those namespaces.
Within an existing namespace, changing account, environment or project must
conflict. Do not derive a new namespace merely to evade a conflict.

The SHA-256 digest covers version 1 of canonical JSON containing:

- The complete immutable `JobIdentity` except the proposed `jobId`: original
  task, request key, instruction revision, all six host scope fields, every
  native reference and all original channel/route/correlation fields.
- The complete approved operation reference and named input references.
- The host's original grant revision.

Object keys are sorted recursively; array order and scalar values remain exact.
Account, project, environment, purpose, instruction, operation and grant changes
therefore conflict within the reservation. Grant revisions are deliberately
conservative: a revised grant cannot silently redefine an old submission.
Reauthorize and use the original job for inspection; a genuinely new operation
needs a new host-approved request key. Digests are private binding metadata,
never credentials or public receipts. Operation references remain host-owned;
this API does not provide executable argument storage or operation dispatch.

## PostgreSQL transaction and recovery

`createJobAdmissionStore(referenceDatabase(client), journalTables())` uses the
existing shared Drizzle database and `createJobJournal`. A transaction-scoped
PostgreSQL advisory lock serializes the exact reservation key; a lock-hash
collision can only cause extra contention. The exact composite primary key is
still the durable authority. A unique job-ID constraint and foreign key bind each
reservation to one logical job. There is no process-local deduplication cache.

Under the lock, an existing matching digest returns the original revision-one
submitted event after validating its identity and journal history. Conflicting
content fails without writes. A new reservation appends the initial submitted
event through the journal and inserts the reservation in the same outer
transaction. The journal's nested savepoint does not commit the outer transaction.
Any later failure rolls back job, event, checkpoint and reservation together.
Candidate ID collisions fail safely without adopting unrelated existing jobs.
The additive generated migration is `0001_round_garia.sql`; apply it only through
the reference host's explicitly authorized migration path.

Independent connections racing identical calls get one original job, one event,
and one reservation. A lost response or a new client retries the same key and
content against current authority and recovers that job. The submit receipt
always represents queued revision 1, even if the job has since advanced.
Inspection validates the current journal and returns only:

```
{ jobId, originTaskRef, instructionRevision, state, eventCursor }
```

The submission receipt adds `replayed`. Neither output includes host scope,
grants, operation input references, native/origin internals, requirement/answer
references, effects, errors, checkpoints or raw events. Missing and inaccessible
jobs both return `not_authorized`. Closing a client or discarding this API has no
job lifecycle effect; there is no cancellation-on-close operation. The host owns
client disposal. Use a Pool or one dedicated Client per concurrent transaction.

## Executed fixture acceptance

`npm run test:submit` executes the admission suite with the explicitly disposable
PostgreSQL variables described in [local PostgreSQL testing](local-postgres-testing.md).
`node tests/run-local-postgres.mjs` creates a fresh PostgreSQL 15 cluster and runs
admission, journal and harness suites sequentially, then stops/removes its owned
cluster. Migrations use the shared helper and harness-owned schemas; cleanup
preserves an independent sentinel. No existing database credentials are read.

See [sanitized evidence](evidence/job-admission.json) for source identity, exact
commands, counts and original synthetic job/task receipts. Compilation is
reported separately from executed SQL tests. This proves PostgreSQL fixture
behavior only, not deployed Handrail, live providers or later runtime milestones.
