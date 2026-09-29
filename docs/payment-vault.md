# Scoped credit-card Vault entry and private use

The September 28 owner correction replaces the former provider-alias boundary.
The user adds or selects a credit card securely and permits private use at an
exact destination. No payment provider, tokenization adapter, provider account
or provider qualification is required. The SDK exposes no charge, purchase,
form submission, payment-network or card export operation.

`createPaymentVault` in `src/server/payment-vault.ts` delegates to the existing
`createVaultEntry` session service. The host must authenticate the actor and the
private route's origin/CSRF separately from the opaque handle on **every** phase.
Its authority callback holds current native scope and consent stable through the
storage transaction. Route mounting and web entry UI remain separately owned
items `c4d1d59e-4fc1-4090-9558-9ccb23e71374` and
`9eddac50-875c-419c-a6e9-5bafd4b9244d`; this server API is not a public model tool.

Private custody has exactly four string fields: `pan`, `cardholderName`,
`expiryMonth`, `expiryYear`. Security codes are unsupported and rejected, even
for encrypted retention. Unknown fields, provider tokens and adapter aliases
are rejected. Card fields are never public metadata, session bindings, hashes,
job answers or receipts. Public metadata is `{kind: 'payment_method', instrument:
'credit_card'}` and an opaque payment reference/revision. The host owns item
aliases, authentication, key management and approval of all public references.

The reference host encrypts the record with its existing AES-256-GCM envelope,
binding item/revision and all six host scope dimensions. The existing transaction
atomically creates ciphertext, consent and the completion outbox. Existing-item
selection accepts no private input and requires current owner ACL and item state.
Concurrent card completions have one winner. Duplicate delivery returns the
original receipt only; stale answers cannot resume a different challenge/job.
Old synthetic adapter-alias rows/sessions fail closed; no live data migration is
implied. Generic secret references remain incompatible with card references.

`createPaymentFillExecutor` projects only the single granted card field into
`PrivateCardDestination`, the existing trusted-executor extension point. Each
request binds profile/lease, document/navigation, complete frame ancestry,
origin, field reference/kind, form endpoint and purpose. `createVaultUse` and the
reference grant store recheck actor, tenant, account, project, environment,
purpose, item/grant revisions, cancellation, expiry and revocation under the
existing job/lifecycle/grant locks. Durable effects prevent duplicate dispatch;
timeout/error remains unknown and needs read-only reconciliation.

The browser owner must resolve actual target facts independently, fence navigation
and lease changes through the write, check live renderer facts immediately before
assignment, honor the provided current/abort check after awaits, and suppress
private observations, screenshots, traces, HAR and video. This is a server port,
not a production browser implementation. Full browser-owner integration remains
with item `1568eb02-a6e9-4692-aea8-b6448e4d0968`; do not count its implementation
or independent native browser QA as completed by these local tests.

## Reproduce local verification

Run commands sequentially from the lane checkout:

```sh
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node tests/run-local-postgres.mjs test:payment-vault test:vault-use test:vault-entry test:vault test:vault-lifecycle test:vault-request
npm run build:test-browser
node --test --test-concurrency=1 tests/payment-browser.test.mjs
```

The PostgreSQL runner creates and removes its own PostgreSQL 15 cluster and
non-superuser disposable database. It never reads `DATABASE_URL`. Card data is
privately generated synthetic data. `tests/payment-vault.test.mjs` covers entry,
selection, encrypted persistence, rollback, scope changes, revocation, duplicate
completion/delivery and fresh-process reference recovery. The shared
`tests/vault-use.test.mjs` runs its durable use/race/reconciliation cases for both
tokens and cards. Store/lifecycle suites also include encrypted card fixtures.

`tests/helpers/browser-card.ts` is a narrow fixture inside the existing private
browser child/output gate. Its two HTTPS pages are fulfilled locally, with the
existing transport proxy denying egress. It exercises field assignment, wrong
live target denial and privately reflected text withheld from observations.
No screenshots are captured. Set `HANDRAIL_TEST_BROWSER_EXECUTABLE` to an
existing authorized Chromium binary when running the final command. Missing
Chromium is an explicit failure, never a skip or substitute DOM mock.

For subsequent native dev QA, bind the candidate source hashes and post-worker
commit SHA, rerun the commands on the declared disposable browser executor, and
retain only fixed receipts. Verify authenticated host route/UI and the production
browser owner when their linked items are available. Local worker tests do not
establish installed/native acceptance. Historical `docs/evidence/payment-vault.json`
retains the original adapter-only result and work request provenance; the current
correction receipt is `docs/evidence/payment-vault-card.json`.
