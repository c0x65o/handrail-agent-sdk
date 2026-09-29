# Reference Node vault persistence

`reference/node/vault-store.ts` is private reference-host custody, outside both
public SDK exports and the shipped `dist` package. It uses the shared
`ReferenceDatabase` Drizzle boundary and generated migrations `0003`–`0005`.
The host supplies the connection, authenticated storage policy and key service;
constructing the store starts no work. Never expose `readForExecutor` as a model,
HTTP or public SDK getter. Its private result is not a use grant or receipt.

`VaultStorageHost.authorize` must resolve current authenticated ownership and the
exact item/version ACL from trusted server state. It approves nonsecret item and
metadata aliases and synthetic identity provenance, and derives
all six existing scope dimensions: tenant, user, project, account, environment
and purpose. Callers supply no scope or authorization booleans. A null result,
throw or invalid scope denies access. Stored scope is compared before key access;
authority is checked again across asynchronous key operations and before private
output release. Hosts must not wire request JSON into this policy callback.
The store consults the authoritative lifecycle ledger before decryption and
before releasing private output. It supplies no item-use grant; already released
values still require host executor/grant fencing.

`create` admits only revision 1 and never overwrites an existing item. It returns
only the validated `VaultItem`. Duplicate or racing writes have one winner and a
bounded conflict result; this is not idempotent secure-entry consumption. The
private payload is exactly one password, API/refresh token, or synthetic identity
field (`ssn`, `legal_name`, `date_of_birth`, `tax_id`), with a 16 KiB UTF-8 limit.
Passwords have no minimum length. Identity bundles and unrecognized fields are
rejected. Metadata matches the existing public vault contract.

Credit-card custody accepts exactly `pan`, `cardholderName`, `expiryMonth` and
`expiryYear` through authenticated private entry. These fields are encrypted in
the same authenticated envelope and are never metadata or public results.
Security codes and unknown fields are rejected, including encrypted retention.
No provider, tokenization adapter, payment network, charge or purchase operation
is required or exposed. See [card integration](payment-vault.md). Old synthetic
adapter-alias rows/sessions fail closed under the corrected schema; no live
provider data or automatic migration of legacy aliases is supported.

Encryption uses Node's AES-256-GCM, random 96-bit nonces, 128-bit tags, envelope
version 1, and explicit algorithm, opaque key handle and positive key version.
Canonical sorted JSON AAD binds the domain, full scope, item reference, revision,
all type metadata, envelope version, algorithm and key reference. Only ciphertext,
nonce/tag and approved nonsecret metadata reach SQL. A database unique constraint
on key handle/version/nonce rejects a collision without overwriting a row. The
key service must use stable handles/versions for each actual key and resolve only
the requested authorized key; it must never trial keys or fall back. KeyObjects
must hold exactly 256-bit symmetric keys. No keys are persisted by the store.

Malformed envelopes, missing keys, unsupported versions, integrity failures and
SQL/key-service exceptions return fixed `unavailable` results, without causes.
Ownership failures return `not_authorized`; invalid input returns
`invalid_payload`. There is no logging or journal/event write path. Temporary
plaintext Buffers are erased, including unauthenticated GCM update output on
failure; JavaScript strings and host-owned KeyObjects still require a trusted
executor process and host memory/diagnostic policy. This is not a secure-memory
or production key-provider qualification claim.

## Local acceptance

Run `node tests/run-local-postgres.mjs test:vault` for the focused suite, or omit
the suite argument for vault, lease, admission, journal and harness regressions.
The runner creates only its own temporary PostgreSQL 15 cluster. `test:vault`
strictly compiles `tests/reference/*.ts` to ignored `.reference-build` before
executing Node TAP. Explicit disposable connection usage remains documented in
[local PostgreSQL testing](local-postgres-testing.md).

The harness applies generated migrations with the stock Drizzle migrator in an
owned schema. A separate writer process exits before a reader process loads all
eight variants and adds eight more entries. Each child uses the existing harness
for its own connection and empty helper schema; only the parent owns cleanup of
the migrated schema. The private deterministic key adapter uses a random per-run
seed carried through IPC, never command arguments, files, diagnostics or receipts.
It qualifies local mechanics only. Boolean-only scans cover persisted vault,
journal/event/checkpoint rows, reference receipts, captured output and bounded
errors for generated canaries and key encodings. Test failures are normalized
before TAP serialization. Cleanup verifies removal and an independent sentinel.

Secure entry, broker/grant enforcement, browser persistence,
external key services, native Handrail-host and live-provider acceptance remain
separate checklist work. See [recorded results](evidence/vault-store.json).

## Rotation, recovery and terminal fences

`reference/node/vault-lifecycle.ts` adds private `prepare`, `resume`, `terminate`
and `cleanup` operations. These are reference-host APIs, outside the public SDK.
The same host callback must separately authorize `rotate`, `recover`, `delete`,
`revoke` and `cleanup`, derive all six scope dimensions from current authenticated
server context, and reject unknown operations. A rotation receipt is only an item
and an opaque operation identifier; possessing it does not authorize recovery.

`prepare(item)` resolves the host's active target handle/version and the exact
source key, rechecks authority and durable state across both lookups, then saves
an encrypted replacement plus source generation/nonce in `vault_preparations`.
It does not change the public reference or item revision. `resume(receipt)`
requires fresh recovery authority and resolves only the saved target key. It
verifies authentication before atomically replacing the envelope and advancing
`vault_states` with a generation/nonce compare-and-swap. The transaction serializes
against terminal transitions. Competing/stale preparations cannot overwrite a
newer envelope. Replaying the last committed receipt re-verifies the current
key/envelope and returns the same reference; replay after a newer rotation fails.
An interrupted/failed commit leaves its preparation retryable. Preparation can
survive process exit without persisting a key or plaintext. The v1 AAD projection
is explicit and unchanged; lifecycle columns are not implicitly added to it.

`terminate(item, 'deleted' | 'revoked')` commits a durable terminal fence, including
for an authorized identity whose create has not yet committed. Reads, new creates,
preparations and recovery consult that fence. Reads recheck after key resolution,
before decrypting, and again after final authorization before output. A successful
read is linearized at its final durable check; values already delivered to a
trusted executor cannot be recalled by this store. The host must fence any later
use through current grants/leases. Concurrent create may return `conflict` when a
tombstone wins. Missing ledger records, unavailable SQL, malformed envelopes and
unavailable/wrong keys fail closed with bounded errors.

Call `cleanup(item)` separately after termination. Its transaction removes both
private ciphertext and preparations; an interruption rolls back cleanup without
undoing the earlier fence. Retry safely. The retained tombstone allowlist is item
ID, host scope, public revision, terminal status and monotonic generation (nonce
and last rotation are null). There is no free-text audit payload or secret-bearing
log/event path. Terminal states cannot be reversed or changed into another state.

The authoritative `vault_states` ledger and migration ledger **must not be restored
from ciphertext backups**. Hosts must establish their freshness independently and
deny authorization if current tombstones cannot be established. Restoring only
old ciphertext/preparation rows cannot revive a tombstoned item or bypass the
current nonce fence. Restoring the entire authority database to an older point is
outside this local mechanism: a host that cannot attest current state must keep
custody disabled. Migration `0005` is a one-time upgrade of existing immutable v1
rows, not a recovery/bootstrap-on-read facility. Deployment requires stopping old
writers that do not consult the new ledger; no live migration is performed here.

No key is retired or destroyed by these APIs. Even verified completion of one
item does not prove that all other items/preparations using a shared key are
migrated. A qualified host owns any later retirement proof. This implementation
makes no claim to erase external backups, provider credentials, or already
released executor memory. Production key-service and native host qualification
remain unverified.

Run `node tests/run-local-postgres.mjs test:vault-lifecycle test:vault` for the
focused real PostgreSQL acceptance. Evidence and exact source identities are in
[evidence/vault-lifecycle.json](evidence/vault-lifecycle.json).
