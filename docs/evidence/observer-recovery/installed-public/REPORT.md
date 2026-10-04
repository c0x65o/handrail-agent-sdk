# Installed public AI prerequisite qualified

Continuation run `62d0ba59-5132-4c77-a5b1-fd910fe35c64` of the same work request
`80ab92d4-d25e-55a7-891a-afe29ea53487` is ready for Main's Agent publication
review. This qualifies the source prerequisite, not the Mills runtime outcome.

## Changes from the reviewed source candidate

Agent's AI dependency and generated npm lock now use AI SDK **0.2.75** at:

```text
git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#5c59f2f71830eb1f23cec28d56db51ca23d7cc3e
```

The same exact URL appears in package.json, the lock's root dependency, the
lock's installed resolution, and node_modules/.package-lock.json. The literal
`git@` username is the repository-documented npm HTTPS transport selector, not
an SSH URL or a new credential. No credential configuration changed.

The reviewed Agent repair, regression tests, and earlier evidence were preserved.
Before installation, all 33 Agent entries in the prior 43-file manifest matched.
Agent remains version **0.2.8**, based on main
`ad039f6fc606e678eaba030d5491b06e1235f0d8`; no release version was assigned here.
The AI checkout is clean at the already-published SHA above. It was not edited
or republished.

The existing handoff initially allowed npm 10 to canonicalize a bare GitHub
HTTPS URL to SSH. The stricter qualification rejected that resolution. Merely
changing the manifest URL retained npm's stale metadata, so normal npm
uninstall/reinstall regenerated the dependency's resolution. No lockfile URL
was hand-edited. The final lock diff changes only the AI pin, version and
integrity. Initial install logs and its passing runtime tests remain labeled
`*-bare-*`; they are not the final lock qualification.

A revised `consume-public-shas.mjs` is retained here. It uses the documented
HTTPS selector, restricts Git to HTTPS, and verifies exact URLs rather than only
SHA suffixes. The original historical handoff remains unchanged.

## Final checks

All commands ran sequentially. Test concurrency remained one. The source override
was explicitly absent, including in child recovery processes.

| Check | Final result | Evidence |
| --- | --- | --- |
| Normal npm install / prepare / TypeScript build | Passed | install-final.log |
| Separate empty-cache npm ci / prepare / build, Git HTTPS-only | Passed | locked-install.log |
| Exact manifest/root lock/installed lock and public module resolution | Passed | resolution.json, verify-installed.mjs |
| Disposable PostgreSQL recovery suite | 17/17 passed | postgres.log |
| Disposable PostgreSQL assistance/application suite | 65/65 passed | postgres.log |
| npm test, including compiled source, acceptance types, contracts and export checks | 777/777 passed | contracts.log |
| Strict consumer TypeScript fixture | Passed, exit 0 | consumer-types.log |
| git diff --check | Passed | final-checks.txt |

Execution commands used for final runtime qualification:

```sh
env -u HANDRAIL_OBSERVER_AI_ENTRY node docs/evidence/observer-recovery/installed-public/verify-installed.mjs
env -u HANDRAIL_OBSERVER_AI_ENTRY node tests/run-local-postgres.mjs test:observer-recovery test:assistance
env -u HANDRAIL_OBSERVER_AI_ENTRY npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
```

The verifier resolves AI's root, server/application, and persistence/postgres
public exports from Agent's installed node_modules, never the sibling checkout.
Agent's public application, agents, and postgres exports resolve to its normal
built dist. Installed AI durable.js exactly matches the previously reviewed
runtime hash. The final PostgreSQL tests prove:

- A simulated provider failure after a verified effect closes observation,
  leaves the same turn pending without an idle lease, and permits recovery.
- A fresh Node process reconstructs the real Agent/Runner and PostgreSQL stores;
  the original job, turn, mutation and effect identities remain stable. The
  verified effect dispatch count stays **one**.
- The actual installed gateway reconciler produces a completed answer in the
  same PostgreSQL conversation; duplicate projection does not append revisions.
- An unknown receipt stays unknown and is not replayed; reconciliation wait and
  explicit Stop remain truthful.
- A different research consumer recovers from process shutdown with no mutation.
  Duplicate recovery, scope denial, grant loss and Stop races retain their fences.

Real PostgreSQL 15 was created only by the existing disposable harness. Its
owned cluster was stopped and removed. External model and business-provider
faults were simulated; no customer/model/provider runtime was called. The
canonical-projection assertion additionally invokes the existing internal
reconciler from the installed package; it does not replace public transport or
persistence entry points. Agent itself is still unpublished source, not a new
installed Agent release. The original failing-before evidence remains in the
parent evidence directory and was not replayed against the fixed dependency.

## Source identity and remaining steps

- Agent transport source SHA-256:
  `5e01eeb1264b352a24052bddf2be09fc3f9f3c9f7fd9b19f4340093819a379f5`
- package.json SHA-256:
  `99429c19b6a2255569814654852f7e29eeb628a4ec0fe3a10d32be220bb88788`
- package-lock.json SHA-256:
  `9d622aac997ebc845c7afad5c3d556c146c96027a3d36ac8c0478a5df3d67abc`
- Installed AI durable.js SHA-256:
  `e1013f11ffd54faf394bdd46c4c891d4e24b86ab10a48653edb57ee3fef787f8`

`SHA256SUMS.json` binds the current source, tests, build seams, lock and logs.
The prior manifest/report remains historical evidence; its old dependency hashes
are intentionally superseded by this qualification.

Previously recorded AI repository-wide lint (38 errors) and static
public-surface scanner failures outside the changed files remain separate
failed findings. They were not rerun or claimed passed. Prior scoped AI lint,
types, and recovery tests retain their reported results.

Main can now publish Agent through the existing publication path, preserving
this reviewed repair plus the exact dependency/lock update. No AI republication
is needed. After Agent has a committed public SHA, reuse original Mills
qualifier `8bcf3fc1`, with its declared Node 22/npm 12 toolchain and existing AI
override. The revised executable source handoff is:

```sh
node docs/evidence/observer-recovery/installed-public/consume-public-shas.mjs mills /path/to/mills-family-erp-v4 5c59f2f71830eb1f23cec28d56db51ca23d7cc3e "$AGENT_SHA"
```

That future Mills command was syntax-checked only and was not executed. Its
normal install/build must be followed by Main's authorized installed qualification.
No commit, push, release, deploy, Mills write, staging restart, live turn action,
Handrail database/queue mutation, or historical effect replay occurred here.

The intended operational destination remains the existing isolated Mills web
target `ddbef4c4` / service `126f4da2`, retaining image/config/database `7de7fb65`,
storage `b9e89b6c`, and profile `a2ca2303` until the authorized update. Original
same-turn recovery must reuse the verified receipt without resurrecting the
deleted vehicle. Actual reminder proposal/approval/due/cancel returns, feedback
reconstruction on web/Flutter, and mobile readiness remain with the original
qualifier. Historical QA `a9480373` / `mills-auth-policy-beb0f9d0-v1`, DEV storage
`712f7b61`, recovery `3c7e4a85`, and migrations 0106/0107/0111 holds remain intact.
Flight source and TestFlight owner eligibility remain open. Local qualification
does not establish the original provider failure cause or outcome acceptance.
