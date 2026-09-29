# Agent SDK consumer distribution candidate for Preview

## Intended outcome and boundary

The existing Handrail Preview **dev** app needs a usable Agent SDK alongside its
five installed SDKs. This review prepares a public-Git-only Node package
candidate in `consumer-distribution/agent-sdk/`. It does not install the SDK in
Preview or publish a repository. The current Agent SDK checkout was clean at
`969cef9b48b5185dafe10d6b44337be6f617715e` before this work. Its package
is `handrail-agent-sdk@0.1.1` with `private: true`; its configured remote in this
checkout is HTTPS, although the saved brief described SSH. The remote URL alone
does not establish public visibility.

The Preview server is Express 5 on Node 22. `src/app.ts` already protects `/api`
with origin and custom-header checks, session resolution, and per-user limits;
`src/auth.ts` resolves active sessions from PostgreSQL. Its `package.json` and
`sdk-sources.json` contain the other five full-SHA HTTPS Git pins and no Agent
SDK. The Agent integration belongs in that existing authenticated server and
the existing Preview app flow. It must not accept caller-supplied host identity,
scope, grant, or lease fields.

## Exact candidate manifest

Only the following files are proposed for a future public SDK repository root.
SHA-256 values identify the reviewed local bytes. `dist/` and `node_modules/`
are generated and excluded. The review document itself stays in the private
source checkout.

| File under `consumer-distribution/agent-sdk/` | SHA-256 |
| --- | --- |
| `.gitignore` | `790e3169bc19b046fe55ba1da6d13b976c28363c8c00462a2195fe5faf260910` |
| `README.md` | `518cfe2cb01a77fa9c4db99f7e063e4edd4e0c22dc4556d8f16ba47e3bee092b` |
| `package-lock.json` | `3fcb03af60ed4eebb09e040d2d07a882d87fd2621c3bceb625a8642c842e5a1e` |
| `package.json` | `1ee3f27a70ed323740b6811bdf437984ac9d2f4cd69fd011f4acaadbad839f9e` |
| `src/contracts/job.ts` | `912feddb1b2827cf5cf3b4b242c1695f882cbcce9cb32e82667f6ee08bd05777` |
| `src/index.ts` | `0f555b76c02b35c333380796375bf753349885b97ef74e65c53fa5054fcd437b` |
| `src/server/index.ts` | `d00177b3e75642743238630ea6721850596aac6296115fa770e753521afda700` |
| `src/server/job-lease.ts` | `96ee19e34987b1748b9d19d9eec7e87c95bbdb27b51f2aab2a20f5203d7e4239` |
| `src/server/job-store.ts` | `4602bfbfa53d44bdc9f20326d4ad42628cfafc76a664d9bb6325e8be334c3327` |
| `src/server/submit.ts` | `def18c74ca1d4b16b4c457899ef132100829c9d48977cfd9acd1803c2f909fa5` |
| `tsconfig.json` | `b632554574c04df2d36df403e65b62b39e0ac3d7cc4f62f9d2e5afc2a77c478f` |

`src/server/submit.ts` and `src/server/job-lease.ts` are byte-for-byte copies
of the current private source. `src/contracts/job.ts` changes only an internal
documentation link in its opening comment. The two entrypoints and the narrowed
type-only `job-store.ts` were reviewed for this candidate. No `reference/`,
`fixtures/`, `tests/`, operational `docs/`, database migrations, credentials,
provider adapters, browser/vault/payment modules, or private full-repo files
belong in the public manifest.

## Public API and synthetic Preview flow

The package root exports five job validators and their types. `/server` exports
`createJobAdmission` and `createJobLease` plus the necessary host/store types.
Import and construction perform no I/O. There are no runtime dependencies. The
package is ESM-only, Node `>=22`, and uses NodeNext TypeScript declarations.

For an initial authenticated synthetic demonstration, Preview can add bounded
POST/GET routes under its existing `/api` middleware. A POST submits a
host-approved `preview.synthetic.v1` operation with empty `inputRefs`, a
request key, and an instruction revision. The server re-resolves the session,
derives all job host and origin references, and reserves the request key plus
initial event atomically in its own PostgreSQL store. GET inspection rechecks
the same user's current authority. A host worker claims a lease, appends
`started`, then commits `succeeded` with a host-verified receipt; all writes
check current authority and fence in the same transaction. The synthetic job
has no provider call, vault, browser action, or external effect. Preview must
implement this host, store, routes, UI entry point, and migration; none are in
the candidate.

## Code and security review

- The candidate source graph has only relative imports. No source file reads
  environment variables, contacts a provider, starts a worker, or imports
  PostgreSQL or the private reference server. The only locked dependency is
  TypeScript 5.9.3 for install-time compilation.
- The job validators require exact plain data shapes, bounded references and
  revision transitions. Admission copies untrusted input before awaiting the
  host, requires current authorization on submit, retry and inspect, and emits
  bounded receipts. Lease operations require the host's current authority and
  a store-checked fence. Existing tests cover malformed data, replay, scope
  isolation, revocation, concurrent claims and transaction rollback.
- Reference syntax validation cannot prove a string is nonsecret or authorize
  an operation. Preview must allowlist operation and input references, derive
  scope from the active session, and keep tokens/fences off client responses.
  The `JobAdmissionStore` and `JobLeaseStore` ports are trusted boundaries;
  incorrect transaction, replay, or ownership handling would defeat the SDK's
  checks. No Preview adapter or migration has been reviewed in this task.
- The candidate has no license file. Public source licensing and distribution
  approval are separate owner decisions. `private: true` intentionally blocks
  registry publishing; the intended consumer channel is public HTTPS Git.

No embedded credential, operational document, fixture, proprietary reference
implementation, or external runtime import was found in the candidate file
allowlist. This is a source and package review, not a security audit of a future
public repository or Preview integration.

## Version, SHA, and compatibility plan

`handrail-agent-sdk@0.2.0` is a proposed candidate version because the public
surface narrows the private `0.1.1` package's broad server exports. It does not
replace the current private package. A later approved public SDK-only Git
repository must contain exactly the reviewed candidate files, receive its own
commit, and provide a full 40-character commit SHA. That SHA does not exist yet
and must never be substituted with the private main SHA above. Preview should
then pin `git+https://<approved-public-repo>.git#<full-public-commit-sha>` in
`package.json`, record the same SHA in `package-lock.json` and
`sdk-sources.json`, and let normal install run `prepare`/`build`. Consumer
installation via private SSH, file, tarball, registry, branch, or tag is outside
the policy. The public Git URL, commit, lockfile match, and Preview build remain
unverified until distribution approval and integration.

Existing imports of `handrail-agent-sdk` and `handrail-agent-sdk/server` keep
their names. The candidate omits connection, vault, browser, payment, effect,
answer, and cancellation exports. Consumers requiring them need a separately
reviewed public scope or must keep their current private package; the Preview
synthetic flow only requires job admission and lease. The package has no
Flutter/Dart API, so Flutter will consume Preview's authenticated routes.

## Verification

| Check | Result |
| --- | --- |
| Candidate `npm ci --include=dev --no-audit --no-fund` | Passed; `prepare` compiled with its own locked TypeScript installation. The worker sets `NODE_ENV=production`, so `--include=dev` was explicit. |
| Candidate package self-import | Passed; root exports exactly five validators and `/server` exactly two factories. |
| Candidate TypeScript consumer import/typecheck | Passed with NodeNext, strict mode and `--noEmit`. |
| Private source `npm test` | Passed, 772/772 including contract and packaging tests. |
| `node tests/run-local-postgres.mjs test:submit test:lease test:journal` | Passed using an isolated disposable PostgreSQL 15 cluster; it was stopped and removed. This proves the private reference persistence path, not a future Preview adapter. |

No public-Git install, consumer lockfile, Preview compile, Preview database
exercise, or app-level route test was possible within this preparation scope.
After the owner decides on distribution, the next work is to create and review
the public SDK-only repository, obtain its SHA, install it in Preview via the
required Git pin, implement the authenticated synthetic host, and verify that
the existing dev app can submit, inspect, and complete one synthetic job.
