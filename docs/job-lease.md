# Transactional runtime lease fencing

`createJobLease(host, store)` is a trusted **server-only** API. The host selects
one original `JobIdentity`; `claim(identity, ttlMs)` attempts that job without
scanning, scheduling or polling. A successful result contains a private fence;
`value: null` means the job is already leased or not runnable. Missing or mismatched
identity returns `not_authorized`. Importing modules or constructing factories
opens no connections and starts no work.

Handrail's native task owner remains authoritative. Implement `JobLeaseStore`
over native ownership there, and `JobLeaseHost` over native authentication,
instructions, holds, grants and cancellation. The PostgreSQL adapter is the
independent reference host, not a second Handrail controller. This change adds
no worker, cancellation orchestration, answer processing, scheduler, browser
ownership, effect dispatch or reconciliation.

## Host authority and clock contract

Every operation enters `host.withAuthority(identity, operation, run)` anew.
The host must authenticate the caller, authorize the exact original identity and
operation, and hold its native authority stable **through the awaited callback
and database commit**. Denial returns `{ ok: false, code: 'not_authorized' }`
without invoking `run`. Invoke and await `run` exactly once when authorized.
A host policy lock or a native transaction can implement this critical section.
A prior ACL lookup followed by an unprotected callback is insufficient. Use a
consistent lock order: native authority, then job row. If composing inside an
outer database transaction, authority protection must extend through that outer
commit; releasing it at a nested savepoint is insufficient.

The callback supplies the exact six-field host scope, positive `grantRevision`
and nonnegative `cancellationRevision`. These revisions are host-owned counters,
not the job journal revision. Changed revisions reject old fences. The host must
deny cancelled/held/revoked work, even if a caller knows its current revision.
A changed cancellation revision does not itself cancel a job, and a new claim
does not revive cancelled work. Full cancellation behavior is separate work.

`now()` supplies nonnegative safe-integer milliseconds on a nondecreasing clock
shared across owners. It is sampled **after** acquiring the row lock, not before
a potentially long wait, and checked again after writes. `newOwnerToken()`
supplies a unique opaque token for each attempt. Tokens must use the bounded
reference syntax, but are private ownership data: never model observations,
client receipts, logs or evidence. Identity equality alone is not authentication.

The core validates/detaches decoded identity, event, fence and authority data
before asynchronous use. It returns fixed codes (`invalid_payload`,
`not_authorized`, `lease_lost`, existing journal validation codes, `unavailable`)
without driver/host exceptions, SQL, raw data or causes. Fence data, low-level
store instances and `JobAppendFence` contexts stay inside the trusted server.
A context is executable trusted infrastructure, not a deserializable credential.

## Reference transactions

Compose `createJobLease(host, createJobLeaseStore(db, tables))`, using the shared
Drizzle `ReferenceDatabase` and optional `journalTables(namespace)`. The host owns
connection creation/disposal. Use a Pool or separate dedicated Clients for
concurrent operations; never overlap transactions on one Client.

The additive generated migration `0002_outgoing_night_thrasher.sql` adds owner,
expiry, epoch, grant revision and cancellation revision columns to `jobs`, with
safe-integer and complete/null ownership constraints. Existing rows begin with
epoch zero and no lease. Apply migrations only through the reference host's
explicitly authorized migration path. This task applies them only in disposable
fixtures. No destructive rollback is supplied; retain history and stop adoption
if reverting the application.

A claim locks the existing job row with `FOR UPDATE`, validates the complete
journal/checkpoint and immutable identity, then accepts only queued or running
jobs with no owner or an expired owner. A running job can be recovered without
creating another started event. Waiting and terminal jobs are never claimed.
The winner increments the durable epoch; renewal, release and expiry never reset
it. Epoch exhaustion fails closed. Claim changes no journal revision, admission
binding, task/request/instruction/native/channel identity or effect accounting.
Losing claims and denied checks do not repair checkpoints. Normal journal `load`
still repairs missing/stale checkpoints as before.

Renewal and release compare the current owner, epoch, complete identity, grant
and cancellation revisions and persisted expiry under the same row lock.
`expiresAt <= now` is expired: an expired owner cannot renew, even if no
replacement has claimed yet. Renewal never shortens an existing live lease;
old expiry values in a same-owner/same-epoch fence are informational. Release
clears ownership and revisions while retaining the epoch. A later claim always
gets a newer epoch, including after voluntary release.

`append(event, fence)` applies the existing journal validation, revision CAS,
delivery deduplication and checkpoint update under that same row lock. It checks
the fence before replay/append and again after writes. An old epoch therefore
cannot commit with a current journal revision or add delivery metadata to a
runtime event replay. Bare journal appends now require a `JobAppendFence` for
**every non-submitted event**, even before the first claim. Initial `submitted`
facts and their admission/delivery retries keep the original contract; they
cannot advance execution. Existing admission idempotency is unchanged.

`complete(event, fence)` requires a terminal event and atomically appends it and
clears ownership in one outer transaction. Any append, checkpoint or ownership
release failure rolls everything back. A lost completion response is recovered
through an authorized journal/admission read; a released fence cannot complete
again. Native acceptance and host receipt verification remain required before
publishing success. An unknown effect still forbids success and survives failure.

## Execution boundary and limitations

`check(fence)` verifies current host authority, durable owner/epoch/revisions,
unexpired storage expiry and a validated runnable job under the row lock. Later
executors must consume it immediately before dispatch and repeat the applicable
checks before output release. Waiting/terminal jobs fail even if their lease has
not expired. This is a point-in-time check, not a reusable permission or a generic
operation authorization. The executor still needs exact tool/destination/grant
checks and any downstream epoch enforcement.

A fence **cannot undo an external request already transmitted**. The lease may
expire or authority may change after the check. Preserve the original effect
identity and record uncertain outcomes; expiry never justifies replaying an
unknown effect. Provider idempotency/reconciliation and stopping or quarantining
unfenceable execution contexts belong to later qualified adapters.

## Executed acceptance

`node tests/run-local-postgres.mjs` creates its own PostgreSQL 15 cluster,
non-superuser role and disposable database, runs lease, admission, journal and
harness suites sequentially, then stops/removes only that cluster. It reads no
shared application credentials. `npm run test:lease` can also use the explicitly
disposable connection described in [the harness guide](local-postgres-testing.md).
Missing PostgreSQL fails rather than skipping acceptance.

The lease suite uses distinct backend connections, an injected clock and a real
lock-wait race observed through `pg_stat_activity`. It checks single-winner claim,
newer replacement epoch, old-owner rejection with unchanged durable tables,
current-owner success, exact expiry and post-lock time, transactional rollback,
wrong scope/owner/revisions, ineligible states, safe epoch bounds and original
job/effect/admission preservation. See [sanitized fixture evidence](evidence/job-lease.json).
These are local PostgreSQL fixture results, not deployed Handrail/native-adapter,
live-provider or broader SDK completion proof.
