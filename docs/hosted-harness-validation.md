# Hosted harness validation — 2026-10-13

This records SDK-level proof for the 0.4.0 hosted runtime. It does not establish
that Handrail/Avery or Mills has installed or deployed this revision.

The official OpenAI 7.32.0 client and actual configured account accepted Agents
API sessions. An OpenAI-hosted browser opened `https://example.com`, reported its
page title, and produced a real screenshot which was retained and visually
inspected. A separate-process follow-up returned a replacement context marker
that was absent from its new prompt and static instructions. Reopening a completed
turn retained its original turn ID and did not submit another message.

A second browser-disabled session retained an original pending function call
across process exit. Recovery executed that call once. A subsequent waiting turn
was cancelled and the exact turn was observed in terminal `cancelled` state;
request acceptance alone was not counted. Test sessions were deleted afterward.

A separate live environment-file probe uploaded 27 synthetic bytes, reconciled
its saved destination without a second copy, and acknowledged deletion of the
provider session. No production application conversation or database was used for
these SDK-level probes.

Local validation:

- 914 contract/unit/package tests passed with concurrency 1.
- 55 runtime/native PostgreSQL regression tests passed in a freshly created,
  disposable PostgreSQL cluster, including parallel reads, exclusive ordered
  effects, cross-process SIGKILL recovery, image/file retention and native scope.
- 7 managed private-entry PostgreSQL tests passed, including hosted sign-in after
  restart, same-job continuation, encrypted values and scope/CSRF/Stop rejection.
- The SDK build and strict typed consumer/examples compile passed.
- Official-client HTTP tests check Agents session/event endpoints, subscription
  before input, provider idempotency headers, hosted browser defaults and omission
  of application inference sampling/token allowances.

Remaining delivery proof belongs to each consumer's installed release: original
conversation screenshot/artifact delivery, retained context across native turns,
interruption/Stop/cleanup, disabled-browser policy and existing user/project
permissions. Avery additionally needs exact incoming iMessage reaction before work
and a result reply in the originating thread. Source test success is not release
or live consumer evidence.

## Consumer integration preparation (0.4.1)

Consumer inspection found two additional integration requirements. Mills applied
post-install edits to the old SDK to preserve its bounded chat window and reading
position and reduce idle display/activity polling. Those fixes now live in SDK
source, with hidden-window reads explicitly cancelled while the retained view
survives; denial, generation changes and account disposal still evict it. Consumers
can remove the frozen dist-file patch once they adopt this revision.

Private access links can now restore their original registered runtime after
process restart or observer disposal (`restoreRuntime`). An `onAnswered` hook lets
the host's existing canonical scheduler resume the saved job after the SDK persists
the verified answer. The conversation wrapper accepts the managed runtime factory.
Published outputs can be downloaded through `retainHostedArtifacts` with original
session/turn/environment validation, bounded reads and SHA-256 custody before
application delivery. This complements live screenshot events; it does not itself
send anything to an end-user conversation.

Validation: 100 scoped display/polling checks; 8 disposable-PostgreSQL private-input
checks; 12 disposable-PostgreSQL conversation checks; 38 hosted boundary checks;
TypeScript build. The fake hosted provider now emits upstream-shaped text deltas,
so canonical recovery checks exercise both live observation and saved output.
These are SDK checks. Handrail and Mills installed-consumer adoption and live
originating-conversation delivery remain required before the overall goal is done.

Full assistant regression: 2,669 tests passed initially; four old cadence/view-clearing assertions failed. Updated the assertions for bounded retained views and idle backoff, preserving active polling and per-reader Retry-After checks. Both affected files then passed all 13 tests. No production source changes were needed after the full run. Installed-consumer fixture typecheck passed. Logs: `/tmp/handrail-sdk-041-assistant-tests.log`, `/tmp/handrail-sdk-041-final-recheck.log`, `/tmp/handrail-sdk-041-fixture-types.log`.
