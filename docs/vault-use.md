# Fenced vault use and item grants

`createVaultUse` is a server-only facade over the existing effect service. Construct
it with a trusted host authority port, custody/grant port and registered executors.
Only the operation and current job lease fence are passed at execution. There is
no value getter, reveal/export method or caller-provided executor callback.

The operation's registered `operationRef` selects trusted code. The executor's
`bind` must produce a canonical digest of the complete approved request and its
scope, with a stable provider/account/environment idempotency namespace. The
reference helper `vaultEffectRequest` hashes only public operation metadata and
approved references. No credential or secret-derived digest is stored. Host
implementations must approve references and destinations as nonsecret aliases;
structural validation cannot certify that an arbitrary string is nonsecret.

The executor receives a private custody value only within dispatch. Its result is
an enum; a verified result uses the already-bound effect reference as its receipt.
Thrown errors, payload-shaped returns, fabricated receipts and timeout results
produce `unknown`, without logging or returning the error. Reconciliation accepts
only fixed outcomes, never reads a private value and remains available after
revocation or cancellation when the host authorizes the factual read. A
`not_applied` observation must prove an old/in-flight call cannot later apply.
Unknown never grants permission to retry on its own.

## Reference host

`createVaultGrants` supplies the `VaultItemGrantPort` and `VaultUsePort<VaultValue>`
using the existing Drizzle database, custody store, lifecycle ledger, job journal
and effect store. Apply migration `0009_vault_item_grants` through the normal
migration path. No service starts on import or factory construction.

- `put(grant, expectedRevision)` creates revision 1 or compare-and-swaps to the
  next revision. The authenticated item's owner must authorize the operation
  through `withOwner`; group/project membership alone is insufficient. A grant
  binds the full operation, item/version, actor, tenant, project, account,
  environment, purpose, job identity/revision, action, effect and destination.
- A personal owner also needs an explicit grant. Sharing permits a different
  recipient user only; every other custody scope dimension must match. Shared
  recipients do not gain grant administration or access-history rights. Native
  hosts may apply stricter item ACLs through their own authority port.
- `revoke(item, grantRef, expectedRevision)` atomically changes the state to
  revoked and advances the revision. This is local authorization revocation,
  **not remote credential revocation**. A new/revised grant requires owner
  authorization again. `use`, `reveal` and `export` are independent permissions;
  reveal/export permissions never create an agent reveal/export capability.
- `history(item, limit)` reauthorizes the owner and returns at most 100 fixed
  facts (default 50): generated access receipt, timestamp, phase and outcome.
  It excludes actor input, request/destination, private values, headers, provider
  replies and exceptions. Valid-request denials, expiry and revocation outcomes
  are recorded. Malformed payloads are rejected before recording caller data.
  Records are append-only; this change does not introduce a retention scheduler.

Execution acquires locks in job → lifecycle → item grant order. It checks the
current job lease/authority and lifecycle, then the current grant and exact
request. The effect service commits unknown admission before dispatch. Dispatch
reacquires the locks and revalidates; a revoke or scope narrowing committed in
between therefore prevents both custody resolution and use. Only an exact durable
effect request binding allows validation to normalize that effect's own journal
admission/replay revisions. Unbound unknown effects cannot be adopted.

The lifecycle/grant locks remain held during the registered executor and effect
commit. If dispatch acquires them first, a concurrent revoke waits; revocation
cannot undo an already-started remote effect. A timed-out executor may still have
an in-flight effect, which remains unknown for the existing reconciler. A timeout
while awaiting custody cannot start the executor later. Time and lease fences are
checked after private key resolution and immediately before executor entry.

The host must hold authenticated native authority stable through each callback
and commit. This contract is not a replacement for Handrail's native authority.
HTTP/browser/payment executor implementations and live-provider proof remain
separate dependent items; the tests use synthetic credentials and trusted fixture
executors, with no network effects.

## Focused verification

```sh
node tests/run-local-postgres.mjs test:vault-use
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node --test --test-concurrency=1 --test-reporter=tap tests/contracts/vault.test.mjs tests/packaging.test.mjs
```

The SQL suite uses the established isolated PostgreSQL 15 harness, checked-in
migrations, per-test schemas, and independent connections. It covers personal and
shared grants, all scope dimensions, actor/purpose/action/destination mismatch,
origin/frame mismatch, reveal/export denial, grant CAS, revoke/narrowing races,
real lock contention, cancellation, stale leases, lifecycle revocation, expiry at
private dispatch, unknown reconciliation, malicious errors/receipts, and timeout
fencing. See `docs/evidence/vault-use.json` for exact candidate source binding,
fixture receipt references and TAP totals.
