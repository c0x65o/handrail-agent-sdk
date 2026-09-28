# Durable authenticated vault entry

`createVaultEntry` in the server entrypoint composes a trusted host with a durable
session port. `reference/node/vault-entry.ts` implements that port using the shared
Drizzle database, vault custody, item-grant administration and answer service.
Importing either factory performs no I/O. There are no HTTP handlers or UI here.

The host authenticates independently of the opaque session link on **every**
operation. Its authority callback resolves the current actor, exact original job
scope, native grant/cancellation revisions, item ACL and explicit permitted use.
The host issues a unique nonsecret item alias for new input, or selects an existing
item after native item-level authorization. It returns the exact approved use
operation, including destination, effect/action, purpose, future job revision,
item revision and consent revision. These are trusted host facts, never client
policy flags. Host/native authority must remain stable until the database commit.
The reference custody and grant owner callbacks retain their existing independent
item-policy responsibilities. Native Handrail must implement the port using its
existing services; this reference store is not a competing native controller.

1. `issue(request)` validates a host-approved request and mints 256 random bits as
   an opaque hexadecimal session reference. It binds the complete request and use
   grant to the current waiting job/challenge, actor and native authority. Reissuing
   the identical open session returns its original handle. A different binding for
   that job revision conflicts. Lifetimes cannot exceed the entry contract's
   15-minute cap or the permitted-use grant (currently at most five minutes).
2. `capture(handle, privateValue)` stores a login password, API/refresh token or
   synthetic identity field in the existing encrypted vault. Selecting an existing
   item uses `capture(handle)` without private input. The existing grant `put` CAS
   validates owner/item permission and records consent before a completion exists.
   Ciphertext/lifecycle state, grant revision and the stable completion/outbox fact
   commit in **one transaction**. Any failure rolls all of them back. A retry
   returns the same completion; changed private input conflicts inside the private
   custody boundary, without storing a secret-derived digest. Payment input is
   rejected here pending the specialized payment adapter task.
3. `deliver(handle)` needs no private input or encryption key. It authenticates
   again, verifies the current job/challenge and exact persisted item/grant revision,
   and calls `createJobAnswer(...).complete` on the same transaction. The answer
   service owns deduplication; the session reference is the stable delivery key and
   approved response reference. The answer event and delivered outbox state commit
   together. After a crash, retry this handle to consume the existing fact. No
   second item, grant revision or job is created. This task supplies the durable
   fact and retry operation; host scheduling of pending deliveries is separate.
4. `withdraw(handle)` and `expire(handle)` persist terminal state and advance the
   session revision. Expiry is also materialized on capture/delivery attempts.
   Dismissing a surface performs no operation. Capture and delivery both reject
   expired, withdrawn, superseded, cancelled, unauthorized or revoked bindings.

Delivery leaves the same original job **waiting with an answer**. A separately
host-authorized resume command queues it. The scoped SQL acceptance retains a
valid host lease to prove one journaled original-job resume under duplicate
requests; session delivery itself never resumes or submits work. Replaying a
session after a later job transition is rejected. Captured items remain linked to
their completion fact if authorization is withdrawn before delivery; they are not
orphaned, deleted automatically or usable through expired/revoked consent.

The reference lock order is job, session, vault lifecycle, item grant. `check` on
the existing item-grant administration port validates current owner permission,
item metadata/lifecycle nonce and the exact durable use revision without reading
plaintext or advancing consent. Capture and delivery recheck time after external
awaits and before commit. Raw values, keys, exception causes and driver payloads
never enter completion, answer, audit or error output.

## Focused acceptance

Run in the existing dedicated disposable PostgreSQL 15 harness:

```sh
node tests/run-local-postgres.mjs test:vault-entry test:vault-use test:answer
node tests/run-local-postgres.mjs test:vault-lifecycle
npm run build
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node --test --test-concurrency=1 --test-reporter=tap tests/packaging.test.mjs
```

Entry tests cover two independent SQL connections, concurrent identical captures
and deliveries, private conflicts, exact item consent, wrong actor/scope/destination/
frame/revision, expiry/withdrawal/cancellation/supersession, transaction fault
injection, real lock contention, private canary scans, and a killed capture process
followed by keyless delivery/replay in fresh processes. Only synthetic values are
used. Migration 0010's SQL is extracted from Drizzle Kit's schema export; its Kit
journal entry and current full schema snapshot are checked in. The existing v1
upgrade fixture removes the new session table when rewinding its owned schema.
See [evidence](evidence/vault-entry.json) for candidate identity and local receipts.
These are reference-host fixture results, not native Handrail, live-provider,
independent QA, browser or deployment proof.
