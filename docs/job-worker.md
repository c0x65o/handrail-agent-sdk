# Reference Node worker

`createReferenceWorker` is an explicitly started, reference-host component. The
host supplies `recover()` candidates, current `authorize()` scope, a qualified
`JobLease`, an admission store, a journal and a deterministic, effect-free step
adapter. The host calls `wake(identity)` when it receives a durable wake; the
worker installs no timer, queue consumer or scheduler and is not a Handrail
worker or controller. Imports and construction perform no IO.

`start()` reauthorizes each candidate, checks the original admission binding,
reloads canonical journal state and claims only queued or running work. A queued
job gets a fenced `started` checkpoint before its first step. A running job
continues with the same job, origin task, request key, host scope and native
logical effect references. A `checkpoint` step appends a fenced, empty
`effects_recorded` event; a `succeeded` step appends a host asserted receipt and
atomically releases the lease. The trusted step adapter may only compute from
the snapshot and return one of these two results. The worker refuses jobs with
recorded effects until effect reconciliation is implemented separately.

Waiting work is inert. Only the host's durable answer/resume path can append a
valid `resumed` event and queue it for a later wake. Terminal work is never
dispatched again. `stop()` aborts the active step, waits for dispatches to end
and releases live leases. A crashed process leaves its lease until expiry; a
new process then claims a higher epoch. Late writes from the prior epoch fail.

The host configures positive `maxSteps`, `maxElapsedMs`, `maxStepMs` and
`leaseTtlMs`, plus nonnegative `maxRetries`. Committed checkpoint count comes
from validated journal history, so process restarts and unrelated lifecycle
revisions do not reset or consume the step budget. Elapsed time and adapter
retries are bounded per dispatch. Exhaustion appends `failed` with
`execution_failed` and the original correlation reference. The adapter receives
an `AbortSignal`; an ignored late result cannot append after the deadline.

Run `node tests/run-local-postgres.mjs test:worker` for the disposable PostgreSQL
acceptance case. It kills a child after revision 3 commits, waits for lease
expiry, and starts a fresh child against the same isolated schema. The journal
must contain one submitted, one started, one checkpoint and one success event,
with distinct child PIDs and the original identity on every revision. Other
cases prove waiting does not dispatch, limits yield a precise terminal state,
current authorization is required, and graceful shutdown releases the lease.
This is a synthetic, no-provider fixture; it does not qualify external effects
or the future Handrail native adapter.
