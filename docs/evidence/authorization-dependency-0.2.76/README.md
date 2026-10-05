# Assistant authorization dependency qualification

Work request `9b90d4bd-c2a2-4543-8463-4411eeeadb82`, 2026-10-05 UTC.
Handrail current context confirmed this project/request and the supplied
authentication requirements. The initial tree was clean at Agent SDK **0.2.11**,
`fea9fe776b42d97f2a61d08f21cbe4422d077915`.

The candidate changes only this dependency in the manifest and npm lock:

```json
{
  "@handrail/ai-assistant": "git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#704b6599f37dce7255e345c8132bf81856bdb6bf"
}
```

The installed package identifies itself as **0.2.76**. The literal public `git`
username preserves HTTPS resolution with npm 10; it is not a credential.
`inputs.json` records manifest/lock hashes and verifies that no other lock
entries changed. Agent's version remains 0.2.11 pending the native release step.
There is **no newly delivered Agent version or SHA in this evidence**.

## Correction and qualification scope

The old dependency was Assistant 0.2.75 at
`5c59f2f71830eb1f23cec28d56db51ca23d7cc3e`. The installed 0.2.76
`dist/server/assistant.js` synchronization authorizer catches catalog
`not_found`/`forbidden` and returns false, preserving other exceptions as
retryable failures. This is the requested upstream correction; no Assistant
source or declarations were patched here. The original 12 upstream denial
failures and upstream JS/PGlite/Dart aggregates were not independently rerun.

The existing `--candidate-source` verifier needed to support dependency edits:
installing the old public Agent base would retain its old nested Assistant pin.
Candidate mode now installs/reinstalls the candidate dependencies normally,
then copies Agent source (never local dist or node_modules) into the external
consumer package and invokes normal `prepare`. Source/scripts are removed
before runtime tests. Its lock deliberately contains no Agent installation
claim, and results identify the SHA as the **source baseline**. This is explicit
unpublished source qualification, not evidence of a public Agent installation.
The ordinary public Git verification path retains its Agent manifest/lock checks.

The lock verifier now requires exactly one Assistant installation and rejects
duplicate copies even at the same SHA. Import checks also assert that Agent and
the direct consumer resolve Assistant to the same file. The strict consumer
fixture exercises the public attachment-download `fetch` declaration in both
directions against `globalThis.fetch`, without invoking it.

Assistant's reported repository lint/public-surface failures are not waived as
consumer success. They are separate upstream checks, not rerun from the packaged
dependency. The supported installed-consumer compilation results below determine
whether the attachment declaration affects this Agent composition. No
`skipLibCheck` relaxation, override, or vendored Assistant copy is used.

## Verification

Node 22.23.1, npm 10.9.8, TypeScript 5.9.3, Agents 0.18.0.
NodeNext uses Node declarations 22.20.4; Bundler uses 22.18.0 and additionally
compiles explicit provider/model composition. Both use `strict: true` and
`skipLibCheck: false`, public imports, and current application/conversation
examples. Checks run sequentially with the existing single-worker limits.

| Check | Result |
| --- | --- |
| `npm install --include=dev --no-audit --no-fund --foreground-scripts` | Passed; Assistant Git prepare and Agent prepare/build succeeded. Only the intended dependency changed. |
| `npm test` | 778 passed, no failures/skips; includes builds, acceptance compilation, packaging and lock regression checks. |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Exit 0, including current examples and the attachment-fetch declaration. |
| `node tests/run-local-postgres.mjs` | 428 passed across all 19 suites; no failures/skips. |
| `node tests/verify-git-install.mjs fea9fe776b42d97f2a61d08f21cbe4422d077915 --candidate-source` | Exit 0; both fresh external profiles passed install, fresh-cache `npm ci`, unchanged locks, normal prepare, strict compilation, all 11 Agent public imports and shared Assistant runtime resolution. |
| Installed candidate runtime/PostgreSQL boundary suite | 97 passed, no failures/skips; owned cluster stopped and removed. |

Consumer manifest/lock snapshots are evidence, not live installation manifests.
Temporary paths are normalized to `<external-consumers>` and `<agent-repository>`
in retained consumer records. Both locks and installed metadata contain exactly
one Assistant 0.2.76 at the requested canonical HTTPS Git SHA. Git credential
helpers/global rewrites and non-HTTPS protocols were disabled during external
qualification. Assistant's attachment-fetch declaration compiled successfully in
both supported profiles; no installed-consumer defect was reproduced.

The PostgreSQL runner creates an isolated local PostgreSQL 15 cluster and
non-superuser database role, runs real migrations, persistence, transactions and
recovery tests, and stops/removes its owned cluster. Installed runtime tests
deny repository/reference/source fallback using the existing filesystem and
module boundary guard. Model/provider/native-executor boundaries are simulated.

## Publication handoff

Changes are intentionally uncommitted. Handrail owns the Agent version bump,
commit and push. After publication, the parent must verify the resulting exact
version/SHA with:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

Only that fresh public Git qualification can establish the delivered Agent pair
for Mills. Mills must use that Agent SHA and the exact Assistant SHA above.
No runtime architecture, historical evidence, Flutter/mobile, Mills, Avery or
platform source was changed. No application secrets, access changes, live
provider calls, deployments, messages, or production effects were introduced.
