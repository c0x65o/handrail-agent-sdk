# Durable challenge answers

`createJobAnswer.issue` records the current waiting requirement, original job
revision, expiry, intended resolver, and authority revisions. The host must
authenticate the resolver, check the original tenant, account, environment,
instruction and route, and keep that authority stable through the database
transaction. The identity and route remain in the existing journal job row.

Completion accepts only a host-approved opaque response reference and the typed
`verified` status. It locks the same job row used by cancellation and lease
operations, checks the current waiting requirement and all fences, then writes
one `answered` event, checkpoint, consumed challenge and delivery digest in one
transaction. The job remains `waiting` with an answer; a separate host-verified
`resumed` command may queue that same job. Completion never submits a task.

The digest covers only approved nonsecret references. Raw vault entries and
provider authorization codes must stay in their respective custody services
and never become response references. Repeating the same delivery key and
content returns its original receipt. Changing the content conflicts. Denied
operations return fixed error codes, without database causes or answer values.

`events(identity, resolverRef, afterRevision, limit)` reauthorizes and returns
bounded event kind, revision and original job ID projections. It advances by
the durable journal revision. The caller pages with the last returned revision;
the query never creates a new job or event.

Run `node tests/run-local-postgres.mjs test:answer` against the owned disposable
PostgreSQL cluster. These are synthetic fixture cases, not native Handrail or
live provider proof.
