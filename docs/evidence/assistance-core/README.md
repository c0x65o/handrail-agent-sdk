# Assistance core source milestone — 2026-09-30

Work request: `0050b080-ba49-5e6f-b9c6-035afcc0e6aa`, contributing to the still-open
Mills outcome `9fd48d7e-2e9d-49e7-976d-b852efe42b72`.

Implemented reusable SDK source, retained/reviewed the five inherited dirty files,
and left all intended changes uncommitted for the configured Handrail pipeline.
No Mills/Flutter/Handrail source was modified. No customer database/queue mutation,
deployment, notification, canonical feedback submission, real flight observation,
registry/tarball publication, version bump, commit or push was performed.

## Delivered source

- Structured Agent input and verified-effect result reads retained; current
  visible-tool filtering, per-model-call attachment resolution, authorized
  checkpoint inspection and draining of approval-resume work added.
- Transport and checkpoint projection compatible with the installed assistant
  gateway's actual protocol, durable wrapper and native approval observation.
  JSON-schema catalog and native tool-presentation adapters keep app tools reusable.
- Shared one-shot wall-clock schedules, DST ambiguity/gap checks, create/edit/
  cancel, paged reads, observation/retry/expiry/revocation state machine, atomic
  notification facts and a timer/queue lifecycle driver.
- Reusable PostgreSQL storage adapter, host-owned additive DDL and transaction
  ports. No 100-reminder or one-year product limit.
- Notification admission, leases and uncertain delivery through the existing
  effect ledger; original effect IDs retained across retries/reconstruction.
- Canonical MCP v2/reporter submission adapter, stable dedupe keys and canonical
  IDs, status/needs-input observation and strict verified-environment readiness.
  No worker-success-to-ready shortcut or developer Work Request substitution.

Runtime export names are retained in `exported-api.json`. The exported API
and concise adapter migration table are in
[the integration guide](../../assistance.md). Both clients retain the existing
backend gateway, conversation history, attachments, voice, renderers and usage
services. Their actual cutover and parity verification remain application work.

## Verification and retained evidence

All commands ran in the SDK workspace. Expensive checks ran sequentially.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm ci --include=dev --no-audit --no-fund` | Passed ordinary dependency installation and SDK prepare/build | `prepare.log` |
| `npm test` | 776 passed, no failures/skips; includes typed build, acceptance/reference builds, package exports and consumer compile | `final-contracts.log` |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Passed strict source API consumer compile | `verified-consumer-types.log` (empty successful output) |
| `node tests/run-local-postgres.mjs` | Executed all 17 suites: 338 tests, 337 passed, 1 failed in the newly added stream projection; all other 16 suites passed (320 tests) | `postgres-all.log` |
| Final `node tests/run-local-postgres.mjs test:assistance test:agents` | 20 assistance/gateway tests + 21 actual Agent/Runner tests passed, no failures/skips, after corrections | `verified-focused.log` |
| Dependency manifest/lock assertions | Public HTTPS full-SHA AI Assistant dependency matches in manifest/root lock/resolved lock | `dependency-pin.txt` |
| `node --check tests/verify-git-install.mjs`, `git diff --check` | Passed | Worker command evidence |
| Final public Git SHA fresh installation | **Unverified: final SHA does not exist until the pipeline commits/pushes** | Downstream command below |

Earlier failed logs are deliberately retained. `focused.log` found missing
notification queued-to-running transition and order-sensitive fixture scope
comparison. `focused-corrected.log` passed the then-current 14 tests.
`postgres-all.log` found the real assistant protocol's zero-based started-frame
requirement. `final-focused.log` additionally found an invalid wrapper test poll
interval. `final-assistance.log` exposed an invalid test request fingerprint and
fixture teardown ordering. These were repaired; `verified-focused.log` is the
final corrected result. Runtime shutdown now drains pending resume work as well
as model execution. No failed run was relabeled as passing.

The tests use a fresh loopback PostgreSQL 15 cluster with a dedicated disposable
database/non-superuser fixture role and per-test schemas. The runner reports its
owned cluster stopped. No managed or customer database URL is used. Tests cover
reconstruction, concurrent delivery, rollback of both record and inbox fact,
revoked scope/current identity, explicit cancellation, stable receipts, uncertain
effects, stale/wrong-subject/future flight observations, delayed/cancelled/landing
fixtures, timezone transitions and an industrial pump-inspection consumer.

The actual OpenAI Agents Runner, Zod dispatch, RunState, official OpenAI Responses
client and PostgreSQL lease/effect/encrypted-state stores execute. **External
model HTTP, sensor/flight data, notification provider and Handrail responses are
simulated fixtures.** The wrapper interoperability test additionally uses the
existing AI Assistant package's in-memory *outer turn store*; it does not claim
PostgreSQL qualification of Mills' conversation adapters. The Agent's underlying
execution/journal/effects in that test still use real disposable PostgreSQL.

## Public delivery boundary

Observed checkout and public HEAD: `8aeca62a2551c7900b7554e1ddbf0477cc83f220`,
version `0.1.4`; see `public-base.txt`. **This is the old published base, not a SHA
containing these changes.** The pipeline owns the next version, commit and push.
The worker cannot return a truthful final committed SHA before that step.

After the pipeline returns the new public full SHA, run:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

The verifier was extended to compile the new public APIs, explicitly declare the
pinned AI Assistant dependency used by the consumer type fixture, and exercise an
installed industrial observation/reconstruction in disposable PostgreSQL. It uses
normal public HTTPS Git installation and fresh-cache lockfile reinstall/prepare;
no copied SDK bytes, tarball, workspace link, registry release or separate
packaging job. Actual final-SHA installation remains pending, not implied by
local prepare/build or the previously qualified 0.1.4 public base.

## Remaining work and evidence limits

1. Pipeline commit/push and the above final-SHA installation gate. Avery then pins
   that exact revision plus lock in Mills; do not consume this dirty workspace.
2. Canonical feedback question/answer/approval interaction: the inspected public
   MCP v2 `src/feedback-schemas.js` at
   `eb879d767d05c7c2e15748f6fe7838294b980d82` has canonical submission, lookup and
   enhancement release status, but no canonical feedback question/answer or
   approval-response operation. Reporter lookup supports status/needs-attention
   indications; the SDK preserves canonical IDs and notifies needs-input, but
   cannot fabricate question IDs or send answers through developer `clarify`.
   Cause class: missing capability in the inspected source contract. Avery must
   qualify the actual runtime catalog and route the exact remaining operation to
   the Handrail integration owner if still absent. No live rejection was observed;
   this is not a claim that all deployed Handrail surfaces lack the capability.
3. Real flight use requires an approved actual-status adapter and precise
   occurrence/timestamp semantics, documented in the integration guide. Fixtures
   prove lifecycle behavior only. No purchase/account/real-person tracking occurs.
4. Mills adapter cutover, existing-row/receipt mapping, all 85 tools, native
   approvals, files/citations, voice and durable metering qualification; then
   independent actual web/Flutter QA and any separately authorized deployment.
   Source checks are not application acceptance; the original outcome stays open.
5. Handrail MCP tools were unavailable in this worker's tool catalog, including
   `handrail_current_context` and `handrail_read_work_request_context`. The required
   paginated frozen-source retrieval (brief `candidate_limit_count=2`) could not
   be performed. The complete supplied assignment, owner correction, empty saved
   decisions, SDK source and mounted Mills/Handrail reference contracts were used;
   unavailable instruction chunks were not invented or claimed read.

No owner choice is needed for these reported verification/platform boundaries.
