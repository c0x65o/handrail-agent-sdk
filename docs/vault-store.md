# Reference Node vault persistence

`reference/node/vault-store.ts` is private reference-host custody, outside both
public SDK exports and the shipped `dist` package. It uses the shared
`ReferenceDatabase` Drizzle boundary and generated migration `0003_vault_items`.
The host supplies the connection, authenticated storage policy and key service;
constructing the store starts no work. Never expose `readForExecutor` as a model,
HTTP or public SDK getter. Its private result is not a use grant or receipt.

`VaultStorageHost.authorize` must resolve current authenticated ownership and the
exact item/version ACL from trusted server state. It approves nonsecret item and
metadata aliases, synthetic provenance, and payment adapter aliases, and derives
all six existing scope dimensions: tenant, user, project, account, environment
and purpose. Callers supply no scope or authorization booleans. A null result,
throw or invalid scope denies access. Stored scope is compared before key access;
authority is checked again across asynchronous key operations and before private
output release. Hosts must not wire request JSON into this policy callback.
Concurrent grant/lifecycle orchestration remains the responsibility of its own
host layer; this store supplies no revocation transaction or item-use grant.

`create` admits only revision 1 and never overwrites an existing item. It returns
only the validated `VaultItem`. Duplicate or racing writes have one winner and a
bounded conflict result; this is not idempotent secure-entry consumption. The
private payload is exactly one password, API/refresh token, or synthetic identity
field (`ssn`, `legal_name`, `date_of_birth`, `tax_id`), with a 16 KiB UTF-8 limit.
Passwords have no minimum length. Identity bundles and unrecognized fields are
rejected. Metadata matches the existing public vault contract.

Payment custody accepts only `{ adapterRef }`, a host-approved opaque UUIDv4
alias to a specialized payment adapter. It never accepts raw card fields, PAN,
CVV, provider tokens, or generic payment secret payloads. The alias is encrypted
too. Syntax alone cannot prove a reference's provenance or distinguish a password
from deliberately mislabeled data; authenticated host admission must approve
classification and aliases. No payment provider operation is implemented.

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

Rotation/deletion, secure entry, broker/grant enforcement, browser persistence,
external key services, native Handrail-host and live-provider acceptance remain
separate checklist work. See [recorded results](evidence/vault-store.json).
