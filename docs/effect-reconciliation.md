# Durable effect reconciliation

`createEffects` in `handrail-agent-sdk/server` composes an injected `EffectHost`,
`EffectStore` and qualified `EffectAdapter`. Imports and construction perform no
IO. `reference/node/effects.ts` implements the persistence port using the shared
Drizzle database and migration `0008_job_effects.sql`. Handrail must implement
this port over its existing native task/action/provider recovery service; this
module does not copy its campaign controller or launch a scheduler.

The trusted host supplies an `EffectRequest` binding the original job/task and
complete host scope, action, operation, logical effect reference, scoped request
SHA-256 digest, provider namespace and provider idempotency reference. The digest
must cover the exact canonical private request and authorized scope; clients do
not choose it. `providerRef` must identify the adapter, provider account and
environment consistently. A unique database constraint prevents rebinding a
provider/idempotency pair to a different job or logical effect. The adapter
resolves private inputs through host custody; only approved opaque references
and safe receipts cross this port.

`execute(request, fence)` commits an unknown journal entry and ledger binding
before any provider IO. The ledger retains the original admission authority,
latest execution authority/lease epoch, safe read evidence and original receipt.
A separate host authorization encloses the dispatch transaction. The host must
hold current native scope, limits and confirmed side-effect gates stable through
that callback and commit, as for `JobLeaseHost`. Authorization is not a cached
boolean or permission inferred from possession of an ID.

Within the job row lock, the store reads/reconciles the original provider identity
before dispatch, including on the first execution. A verified existing result
records its original receipt. Only a definitive `not_applied` read permits a call
with that same identity. A missing eventually consistent record, a timed-out
lookup, or unsupported reconciliation returns unknown. No timeout, process crash,
ambiguous response or cached `not_applied` evidence authorizes a retry. Provider
idempotency and the adapter's guarantee that an older in-flight call cannot later
apply are required. A provider without that guarantee must return unknown.

The row lock serializes concurrent dispatches, read/reconcile operations and Stop.
The current fence is checked after lock acquisition, after the provider read,
immediately before dispatch and before the final commit. Calls have bounded
adapter deadlines (default 10 seconds each); the host should choose deadlines
within its lease and database transaction limits. Unknown results remain durable
and wait for a later host-directed reconciliation; there is no background retry
loop. An abort is not proof that a remote effect did not happen. Late adapter
results are ignored, and exceptions, arbitrary payloads and malformed results
become unknown without exposing error text.

A dispatch transaction rollback leaves the separately committed unknown record.
Recovery reauthorizes the same request under a fresh lease and reads the provider
before another attempt. A verified ledger receipt enables one narrow,
receipt-backed `effects_recorded` journal transition from unknown to verified.
Canonical history checks its exact ledger/revision proof; generic lifecycle
append still cannot resolve an effect. `not_applied` is retained as read evidence,
not as a durable retry grant or a terminal success claim.

`reconcile(request)` performs read-only provider recovery without launching an
effect. Its host permission may remain available after cancellation. It records
facts in the ledger while preserving the cancelled journal and its original
unknown snapshot. Calling `execute` after Stop fails the lease/cancellation fence.
Standalone reconciliation also leaves a running snapshot unchanged; a subsequent
fenced `execute` projects a verified receipt into that journal without dispatch.

The deterministic `createReferenceWorker` continues to reject external effects.
Hosts compose this effect service explicitly with their trusted effect execution
path; the broader runnable-host task owns that composition. The focused fresh
worker fixture in `tests/helpers/effect-process.mjs` demonstrates the full path:
claim, execute/recover, preserve the receipt, and complete the same original job.

Run:

```sh
node tests/run-local-postgres.mjs test:effects
```

This creates a disposable real PostgreSQL 15 cluster and applies the checked-in
Drizzle migrations. The synthetic provider uses a separate connection and commits
success before the first worker is killed with SIGKILL. A fresh worker recovers
after lease expiry. Assertions require distinct worker PIDs, one actual provider
dispatch, one provider effect, one logical ledger entry, the original receipt and
the same original job/task/scope. Other cases cover conflicts, unknown recovery,
verified-not-applied retry, current authority, expiry, cancellation, concurrency,
secret-safe failures and rejection of forged journal resolution.

These are synthetic provider fixture recovery results on real PostgreSQL, never
live provider or native Handrail integration proof. See
[`docs/evidence/effect-reconciliation.json`](evidence/effect-reconciliation.json)
for the tested source hashes and outcomes.
