# Payment-reference boundary

`src/server/payment-vault.ts` implements a server-only specialized session facade.
It exposes `issue`, `complete`, `deliver`, `withdraw` and `expire`. It exposes no
purchase, charge, raw capture, provider-token submission, reveal or export API.
The generic `createVaultEntry` path continues rejecting payment requests/grants.

A host supplies `PaymentVaultHost`, `SpecializedPaymentAdapter`, its exact
`PaymentAdapterRegistration`, and the existing `VaultEntryStore`. The reference
Node composition uses `createVaultEntryStore`, the existing encrypted vault,
item grants, job challenges and job-answer delivery. No new scheduler, job owner,
ACL service or database schema is introduced.

1. The authenticated host resolves the original job, actor, approved payment
   reference, consent and exact verify/attach destination. The request binds all
   scope dimensions, origin, challenge, expiry and effect. Registration includes
   adapter ID/version and environment; it is persisted in the session binding.
2. `issue` commits an opaque session then calls the adapter's idempotent `open`.
   An open failure leaves a retryable session, never an answer or credential.
   The adapter owns the hosted/tokenized surface and private provider mapping.
3. `complete` accepts only a session handle. The adapter independently resolves
   authenticated completion through `withCompletion`; it must not interpret a
   caller-supplied token string as authority. The SDK checks exact session,
   registration, binding and origin equality, and accepts only a host-approved
   nonsecret UUID custody alias. PAN, security codes and provider tokens never
   enter this interface. Security codes are transient within the adapter.
4. The reference store atomically persists the encrypted alias, consent and
   reference-only completion under job/session/item fences. Existing-item
   selection checks the authenticated alias against the stored alias. Payment
   completion replay is rejected; competing completions have one winner.
5. `deliver` rechecks adapter reference validity plus native authority, grant,
   lifecycle, expiry, cancellation and challenge revisions, then delivers one
   answer on the original job. Delivery retry returns the original receipt.
   The ordinary runtime owns subsequent resume. Closing a surface has no effect.

The host must hold its authority stable through each callback **and database
commit**. The adapter must similarly fence reference revocation/consent through
`withCompletion` and `withReference`. Its callbacks may supply only allowlisted
facts; errors must be fixed codes or thrown exceptions (the facade suppresses
exception details). Native hosts must implement equivalent transactional port
semantics. Adapter provider-token storage, callback signature verification,
CSRF/frame controls, telemetry and retention require actual adapter qualification.
They are not established by comparing fixture metadata.

## Capability and qualification status

| Capability | Status |
| --- | --- |
| SDK reference-session boundary and reference Node PostgreSQL behavior | Local synthetic boundary conformance only |
| Fixture adapter | `synthetic-payment-boundary`, `fixture-1`, in `tests/payment-vault.test.mjs`; handwritten external-boundary fake |
| Authorized selected adapter/version | Unverified; none established by repository prerequisite inventory |
| Provider callback authentication, hosted entry and retention | Adapter contract only; no selected implementation exercised |
| Production payment capability | Unsupported; only explicit host `synthetic_sandbox` plus `synthetic_boundary_only` registration is accepted |
| Payment network operations, customer creation, purchases, certification | Not performed or claimed |

The host owns the mode and registration; they must never come from request JSON.
A fixture declaration is not production qualification. See the per-version,
per-host, per-operation/channel policy in [security boundary section 8](agent-security-boundary.md#8-adapter-qualification-matrix-and-external-prerequisites).
The native capability inventory readers were unavailable in this worker; no fresh
host inventory verification is claimed. Selected-adapter qualification and the
broader v1 payment requirement remain unverified.

## Focused reproduction

Run from the SDK lane with the installed dependencies and PostgreSQL 15 binaries:

```sh
node tests/run-local-postgres.mjs test:payment-vault
node tests/run-local-postgres.mjs test:vault-entry
npm run build
node --test --test-concurrency=1 --test-reporter=tap tests/contracts/vault.test.mjs tests/packaging.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
```

The runner creates and removes its own disposable PostgreSQL cluster and uses a
non-superuser fixture role. It does not read `DATABASE_URL` or contact a shared
operator database. Tests exercise real migrations, locks, rollback, ciphertext,
grants and journal serialization. Only the external specialized adapter is fake.
Canaries are generated in disposable memory; scans cover persisted session,
vault, grant, challenge and job rows plus facade results/errors/receipts. Evidence
retains counts and source hashes, not canary values. This does not qualify browser,
network/APM sinks or another host. No full-repository acceptance is claimed.

See [the focused receipt](evidence/payment-vault.json) for commands, counts,
source binding and outstanding qualification prerequisites.
