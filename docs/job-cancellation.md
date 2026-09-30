# Job cancellation fence

`createJobCancellation.stop` is an explicit, authenticated Stop operation. The
host checks the actor and original tenant, user, account, environment, grant and
native holds, and keeps that authority stable through the store commit. Closing
an observation, disconnecting a client or stopping a worker process does not
call Stop.

The PostgreSQL reference store locks the job row, validates the journal, writes
the cancelled event and checkpoint, clears lease ownership, and advances both
the lease and cancellation epochs in one transaction. Claims, appends, and
`admitEffect` lock that same row. A committed Stop therefore wins against later
work, including a callback from a step that started earlier. A repeated
authorized Stop returns the original cancelled snapshot.

An effectful adapter must call `admitEffect` before making a remote mutation.
Only a newly committed, unknown effect may be dispatched; `replayed: true`
means the original effect must be reconciled instead. Cancellation preserves
that unknown effect. `attachEvidence` stores an immutable, nonsecret reference
to reconciliation evidence against the cancelled job without changing its
terminal state or claiming the remote mutation was rolled back. The later
effect reconciler owns final outcome resolution.

The trusted host must implement the authority callbacks with a transaction or
equivalent lock that covers the database commit. A policy check followed by an
unprotected callback is insufficient. The OpenAI Agents runtime checks the lease before every model/tool call and after
each callback. Its process shutdown preserves recoverable checkpoints; explicit
Stop is durable and terminal. See [agent-runtime.md](agent-runtime.md).

`node tests/run-local-postgres.mjs test:cancel` runs the boundary cases against
an isolated PostgreSQL cluster with separate connections and a deterministic
row-lock wait.
