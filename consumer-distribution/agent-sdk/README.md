# Handrail Agent SDK consumer candidate

This package exposes the Agent job wire contract and two inert server factories:
`createJobAdmission` and `createJobLease`. It has no database, queue, browser,
credential store, provider client, worker, or background process. Importing it
does not start a service.

The package root exports job types and validators. The `/server` entrypoint
exports the admission and lease factories and their host/store ports. A trusted
server must authenticate the caller, derive every identity and scope reference,
authorize every operation, and implement atomic reservation, revision, and lease
storage. Reference syntax validation cannot establish authority or detect a
secret disguised as a reference. Never put credentials, URLs, raw user input, or
secret-derived hashes in job references.

For a synthetic host demonstration, submit only a host-approved operation such
as `preview.synthetic.v1` with no provider effect. Keep its input references
empty. The host reserves the request key and initial `submitted` event in one
transaction, returns only the admission receipt, and reauthorizes inspection.
A worker may claim a host-fenced lease, append `started`, then complete with a
host-verified receipt. The host must check current authority and the lease in
the same transaction as each write. A retry returns the original admission;
job ID or lease possession alone grants no access. The host chooses its own
durable store and transport. This package does not define a Preview route or
database schema.

`npm ci --include=dev` runs `prepare` and builds `dist` using the locked local
TypeScript compiler. A future public Git consumer install must pin a full commit
SHA and record the same SHA in the consumer lockfile.
