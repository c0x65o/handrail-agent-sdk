# Shared observer recovery source repair

This is the bounded source prerequisite for Mills outcome
`9fd48d7e-2e9d-49e7-976d-b852efe42b72`, worker request
`80ab92d4-d25e-55a7-891a-afe29ea53487`. It is not installed-canary acceptance or
completion of the reminder/feedback/mobile outcome.

## Inspected baseline and authority

- Agent main: `ad039f6fc606e678eaba030d5491b06e1235f0d8`, package 0.2.8.
- AI SDK main: `5a15f47318d08447d4a91faeada1ba6c11222955`, package 0.2.74.
- Both worktrees were clean at entry. No existing changes were restored or replaced.
- Read `handrail_current_context` and the complete frozen instruction chunk (next
  offset null); scope confirmed this source assignment. No owner question needed.
- Mounted Mills diagnostic SHA-256 verified as
  `9d1f8845e75351a022c58b316d9018e6c71f94e7ba6e75a6fd9282d460f36d90`.
  `diagnose-before.mjs` is its exact retained copy. Other historical artifact
  hashes in the assignment are Main's supplied evidence, not newly fetched here.
- Agent still pins AI to public HTTPS Git SHA
  `d5995c32707979ac975c70211c79407f1ce4c765`. Dependency versions, pins and
  lockfiles were not changed. Source package versions were not bumped.

## Exact correction

Agent `src/server/agent-transport.ts`, `createAgentConversationTransport`:
`startTurn` and `resumeTurn` now connect their resume/wake promise to observation.
After that attempt resolves or rejects, observation performs a fresh authorized
lookup/read. A read started before exit cannot be treated as that final read.
Canonical completion, failure, cancellation, and approval wait are projected
unchanged. With no canonical outcome the iterator and result finish as
`disconnected`, retaining the checkpoint. Exit wakes the poll immediately; no
new timeout or retry loop was added. This covers retryable, busy, shutdown,
store/authority errors, and thrown exceptions. Resume failures other than the
normal non-waiting `invalid_transition` no longer trigger a wake.

AI `src/transports/durable.ts`, `createDurableApplicationTransport`:
`settle` now retains a disconnected delegate as pending with null terminal and
lease, under the existing owner/attempt CAS fence. Accepted Stop retains its
cancellation precedence; unacknowledged Stop remains recoverable. `observe`
closes client observation for a settled pending attempt without a lease.
Existing `recoverTurn`, `resumeTurn`, and pending scans can recover the original
idempotent start through the existing authorization and attempt budget. The
wrapper still calls delegate `startTurn` with original turn/mutation/request
keys; Agent admission reuses its persisted job. Stable replayed frames are
validated by the existing canonical projector.

Diagnostics use existing `durable_turn` events with
`code=observation_disconnected`, `retryable=true`; no provider cause or private
payload is added. The event's `failed` phase describes the observation attempt,
not a terminal job state. `TurnObservationDisconnected` and existing SDK docs
now describe these semantics. No execution engine, journal/effect persistence,
lease implementation, public type shape, or schema changed.

A direct consumer can now receive disconnection for a busy duplicate while the
original execution continues. Its same-turn reconnect must retain the cursor;
the pre-existing installed application fixture now exercises that behavior.

## Evidence and verification

`original-before.log`: the original composed diagnostic reproduced one retryable
wake, 52 reads, renewed outer lease, and recovery `already_running`.
`regression-before.log`: the new regression failed before the fix because the
observer worker did not settle; direct exit tests hit their test-only bounds.
`regression-after.log`: initial candidate composition passed all six tests.

`postgres-final.log`: final targeted rerun includes the full new regression and
existing assistance/application suites. The new suite's 17 tests cover:

- Actual Agent/Runner, PostgreSQL journal/encrypted checkpoints/effects, and the
  real AI PostgreSQL durable store. A simulated provider failure occurs after
  one verified mutation. The Agent remains running while the gateway becomes
  pending with no lease or false terminal; no subsequent heartbeat changes it.
- A fresh Node process reconstructs both layers, recovers the original job and
  turn, and completes with exactly one effect dispatch. Duplicate recovery after
  completion remains terminal. The actual gateway reconciler writes and replays
  PostgreSQL canonical conversation events; repeated projection adds no revision.
- A materially different research consumer exits on process shutdown and
  recovers a quote with zero mutation calls; concurrent recovery requests yield
  started/already_running under the existing fence.
- An unknown mutation receipt survives a requirement-adapter outage. Recovery
  retains unknown state and waits for reconciliation without a second dispatch.
  Explicit Stop after the disconnected attempt still settles cancellation.
- Stop and grant-change races, denied/foreign scope, terminal/wait precedence,
  rejected resume without wake, final-read authority loss, and retryable/busy/
  stopped/error exits. A changed grant may leave the old lease busy until expiry;
  tests assert no additional model invocation and denied private-state access.

Other retained checks:

| Check | Result |
| --- | --- |
| Agent `npm test` (build, acceptance types, exports/contracts) | 777 passed |
| Agent `tsc -p tests/fixtures/tsconfig.json` | Passed |
| Full disposable PostgreSQL runner, initial pass | 426/428 passed; two expectation failures retained |
| Corrected suites, final PostgreSQL rerun | 82/82 passed; both initial failures explicitly rechecked |
| AI build and full TypeScript typecheck | Passed |
| AI changed-source/test ESLint | Passed |
| AI durable/recovery/authorization/projection tests, one worker, no file parallelism | 129 passed across 10 files |
| AI public package/import contracts | 30 passed; dry-pack test excluded (no packaging step) |
| AI repository-wide lint | FAILED: 38 errors in unchanged paths; `ai-lint.log` |
| AI static public-surface scanner | FAILED: pre-existing `fetch` declarations, including attachments/downloader and transcription-http; `ai-public-surface.log` |

The full PostgreSQL run's two failures were the old busy-observer completion
expectation and a new overly narrow grant-loss assertion (`not_authorized` vs a
still-live busy lease). They were corrected without changing execution fences;
the initial nonzero result remains in `agent-postgres-initial.log`. All other
full-run tests passed. Broad lint/static-scanner findings were not repaired as
unrelated source changes. Agent has no lint script.

Tests ran sequentially with one Node/Vitest test worker. The existing fixture
runner created and removed its own PostgreSQL 15 cluster and dedicated
non-superuser database role; it never reads DATABASE_URL or selects an operator
DB. Node was v22.23.1, npm 10.9.8. No external provider/model calls occurred;
model and business-provider boundaries are explicitly simulated. Some existing
AI regression suites use their supported PGlite harness; the composed recovery
and canonical projection proof uses real disposable PostgreSQL.

## Boundaries and Main handoff

Candidate composition imports the AI checkout's normally built exported entry
via `HANDRAIL_OBSERVER_AI_ENTRY`; it is a test harness selection, not a dependency
installation or a file/workspace dependency. Agent resolves its public package
exports. The canonical projection test additionally invokes the AI gateway's
existing built internal reconciler. This proves source composition, not an
installed public candidate SHA. `agent-only-old-ai.log` deliberately tests the corrected Agent against its
frozen installed AI pin: the regression fails with actual `failed` vs expected
`pending`. Both fixes must be consumed together.

After Main reviews and uses the existing publication path:

1. Publish the reviewed AI correction first. If no intervening version changes,
   the next patch would be 0.2.75. Retain its full public Git SHA.
2. Pin Agent to that AI SHA with matching lockfile using normal install/prepare/
   build, review the dependency change, and run checks. Then publish Agent's
   correction (next patch would be 0.2.9 absent intervening changes).
3. Original Mills qualifier `8bcf3fc1` consumes both committed public HTTPS SHAs,
   regenerates its npm lock and exact `allowScripts` entries, and performs its
   authorized installed qualification. Use Mills' declared Node 22/npm 12
   toolchain. Keep its existing AI override. No tarball, file, registry or
   workspace SDK dependency and no separate packaging step.

Executable source handoff (NOT RUN by this worker):

```sh
node docs/evidence/observer-recovery/consume-public-shas.mjs agent /path/to/handrail-agent-sdk "$AI_SHA"
# Main reviews/tests/publishes Agent through its existing path, then:
node docs/evidence/observer-recovery/consume-public-shas.mjs mills /path/to/mills-family-erp-v4 "$AI_SHA" "$AGENT_SHA"
```

The script requires full 40-character SHAs, validates the target package,
updates only the requested SDK pins/allowances, runs normal npm install/build,
and checks matching lock resolutions. It has no commit/push/deploy commands.
It was syntax-checked only because no candidate publication is authorized here.

Repeat source checks before publication:

```sh
# First build the linked AI SDK with its normal npm run build.
HANDRAIL_OBSERVER_AI_ENTRY=file:///path/to/handrail-sdk-ai-assistant-js/dist/index.js \
  node tests/run-local-postgres.mjs test:observer-recovery test:assistance
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
# After Agent's committed AI pin is updated, omit the candidate-entry variable.
```

No commit, push, release, deployment, runtime request, staging restart, owner
feedback submission, credentials change, app write, or Handrail database/queue
mutation was performed. Read-only Mills/Handrail and Flutter were untouched.
The historical live provider error remains unproven; this local reproduction
does not establish that original provider cause.

The original qualifier remains responsible for the authorized installed update
at isolated web target `ddbef4c4` / service `126f4da2`, retaining image/config/
database `7de7fb65`, storage `b9e89b6c`, profile `a2ca2303` until that update.
Then authenticated SAME-turn recovery of conversation
`f87ec068-dc01-4c36-9dd5-aac1886d1f62`, turn
`turn_assistant-143360f27cfc5733f27ecf87fed5ddc70be4`, job
`a1a63823-8a2f-4e91-8090-764c4d711528` must reuse the verified effect receipt.
Never resurrect/repeat the soft-deleted vehicle effect. Natural-language
reminder proposal/approval/due/cancel exactly-once return, feedback
reconstruction on web/Flutter, and mobile readiness remain unverified here.
Preserve historical QA `a9480373` / `mills-auth-policy-beb0f9d0-v1`, DEV storage
`712f7b61`, recovery `3c7e4a85`, and migrations 0106/0107/0111 holds. Flight source
and TestFlight owner eligibility remain open on the original outcome.

`SHA256SUMS.json` binds the corrected source, tests, built seams and retained
artifacts in both SDK worktrees. The original diagnostic hash is included.
