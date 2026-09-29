# Private scoped browser-profile persistence

`reference/node/browser-profile-store.ts` provides PostgreSQL-backed custody for
selected Owner Task `61fbfd09-2617-4b36-91a3-2f3bae1d55c1`. It launches no browser,
performs no provider logout/revocation and is absent from the public package
exports. This is reference-host persistence proof; browser execution, control
leases, observation filtering and independent runtime QA remain separate tasks.

## Host boundary and state format

The host implements `BrowserProfileHost.authorize` from authenticated server
context. For every exact opaque profile ID and operation it must enforce the
profile ACL and return all six scope dimensions (tenant, user, project, provider
account, environment, purpose), exact approved HTTPS origins, current authority
epoch and absolute expiry in Unix milliseconds. Caller-provided scope, possession
of an ID and model claims cannot supply that authority. The implementation checks
a detached grant again after external awaits and at the persistence/output fence.
The optional clock is trusted host/test infrastructure, never caller input.

Version 1 supports bounded secure host-only cookies and origin-scoped
localStorage/sessionStorage entries. Cookie expiry uses Unix seconds (`-1` for a
session cookie). Domain cookies, partitioned cookies, IndexedDB and other browser
state are unsupported. Adapters must reject unsupported capture/restore formats
rather than silently discard state. Cookies cannot themselves enforce port
isolation: a future qualified browser adapter must restrict actual context
traffic to the approved origins, including redirects, popups and frames, and
check the provider account. This store does not prove that browser behavior.

Inputs are detached before the first await, reject accessors/hidden properties,
use exact shapes and are limited to 64 KiB encoded state. Arrays have at most 256
entries, with a total 4096-node and depth-8 budget; individual strings are at most
16 KiB. Profile policy allows 1–32 unique origins. Storage keys and cookie
origin/name/path tuples are unique. Plaintext is returned only by
`loadForExecutor`; never send its successful result to model tools, logs, job
history or evidence. Metadata IDs must be host-approved nonsecret aliases.
JavaScript object/string copies cannot be reliably zeroized; transient byte
buffers are wiped, and the private executor owns object lifetime and sinks.

## Persistence and authority

Migration `0011_browser_profiles.sql` adds two tables. Snapshots contain metadata
and ciphertext; the independent state ledger retains scope, revision, authority
epoch, active nonce and terminal status. There is no generic Vault item or job
record containing browser state.

The shared private AES-256-GCM primitive and existing exact handle/version key
resolver are reused. Browser authenticated data uses the distinct
`handrail-reference-browser-profile` domain and binds profile ID, all scope
fields, allowed origins, revision, state-format version, authority epoch, expiry,
envelope version, algorithm and key handle/version. The vault's v1 AAD projection
and encoding remain unchanged. Keys are private `KeyObject`s supplied by the host;
there is no key discovery, alternative account/profile lookup or fallback.

- `create(id, state)` starts revision 1 under the host epoch. It atomically inserts
  the ledger and snapshot. Existing ciphertext or any existing ledger prevents
  identity reuse. Reserve a new host-approved ID for reauthentication.
- `loadForExecutor(id, origin)` checks current host policy, ledger, exact origin,
  versions and expiry, decrypts/authenticates and validates supported state, then
  repeats authorization, nonce/revision/epoch and expiry checks before returning.
- `save(expectedMetadata, state)` compares all expected metadata and locks the
  ledger. It checks current revision/epoch and updates ciphertext plus revision
  atomically. Exactly one same-revision writer can win. Active epoch changes are
  not granted by this API; future browser control code must coordinate its own
  host-owned fencing integration. A stale or changed host epoch is rejected.
- `terminate(id, 'revoked' | 'deleted')` commits a durable higher epoch and clears
  the active nonce before cleanup. It also fences an initial create still
  resolving keys. Terminal identities are permanent and retries are idempotent.
- `cleanup(id)` separately deletes only ciphertext for a terminal identity.
  Retry it after interruption or restored ciphertext. It never deletes the ledger.

Termination/cleanup receipts distinguish local state and cleanup status from
remote `{ state: 'not_requested' }`. No result claims provider logout.
Revocation must be coordinated with browser command/output fencing by the host;
this persistence task does not stop a running browser.

The ledger is the authority and must not be restored from ciphertext backups.
Restoring an old snapshot cannot reverse a retained terminal fence or active
revision. If the ledger itself has been rolled back or its freshness cannot be
attested, the host must deny authorization until separately reconciled. An
application-level store cannot detect rollback of every authoritative database
and host policy together.

## Fixed recovery results

| Code | Host response |
| --- | --- |
| `invalid_payload` | Correct unsupported or malformed private input; no write occurred. |
| `not_authorized`, `origin_not_allowed` | Deny; authenticate/authorize the exact scope, policy and origin. |
| `conflict` | Discard stale authority; reacquire current authorized metadata. Do not retry stale writes. |
| `profile_missing` | Authenticate/setup this exact identity; never search another profile. |
| `profile_revoked`, `profile_deleted` | Keep the terminal fence; require new authorized profile setup. |
| `reauthentication_required` | Expiry reached; require fresh authorization and profile setup. |
| `key_unavailable` | Recover the exact referenced host key or require fresh setup. No fallback. |
| `incompatible_state` | Unsupported format/envelope/algorithm; require host migration or fresh setup. |
| `corrupt_state` | Authentication/state validation failed, including wrong key; quarantine and recover or reauthenticate. |
| `unavailable` | Database/service failure; inspect private host health without exposing exception details. |

A lost database response can make mutation completion unknown; read the retained
ledger through authorized operations before retrying. These statuses contain no
raw errors, ciphertext, key bytes or state values.

## Reproduce the scoped proof

```sh
node tests/run-local-postgres.mjs test:browser-profile test:vault-lifecycle test:vault
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
```

The existing runner creates and removes its own PostgreSQL 15 cluster, dedicated
database and non-superuser role. It ignores host database credentials and uses
one test worker. Tests migrate isolated schemas using the checked-in Drizzle
migration, including reruns and sentinel cleanup checks. Separate exited
processes restore exact private state and retain terminal fences. SQL fault
injection proves interrupted cleanup and atomic save rollback. A two-client
key-resolution barrier exercises concurrent CAS saves. Bidirectional legacy vault
crypto compatibility and the existing vault suites cover the shared extraction.

Private fixtures use fresh random seeds passed over IPC, never argv or evidence.
The suite checks cookie/storage canaries and key encodings against populated
durable job/event tables, custody rows, redacted receipts and captured child
stdout/stderr. Only counts/digests are retained. Assertion and driver errors are
caught before test diagnostics can serialize private values.

See [redacted candidate evidence](evidence/browser-profile-store.json) for exact
commands, exits, TAP totals and file hashes. The candidate contains pre-existing
uncommitted work; the source HEAD alone does not identify this implementation.
No commit, push, deployment, host database or provider-account mutation was made.
