# Agent SDK 0.2.10 consumer compatibility

Qualified pair for Mills to pin:

```json
{
  "handrail-agent-sdk": "git+https://git@github.com/c0x65o/handrail-agent-sdk.git#0faf5214f0413886884e2f59e74a9b5ca0ba385e",
  "@handrail/ai-assistant": "git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#5c59f2f71830eb1f23cec28d56db51ca23d7cc3e"
}
```

These are Agent SDK **0.2.10** and Assistant SDK **0.2.75**. The checkout and
public main both identified the Agent SHA above before edits. Handrail context
confirmed work request `65956981-7208-4aed-9c08-67f0db56acf9`, with no other running
project work request. The tree was clean. Qualification ran on 2026-10-05 UTC.
The previous-result MCP reader required an owner-goal scope unavailable to this
worker; repository evidence and direct reproduction established the failure.

## Reproduction and corrections

Both existing archived consumers under
`continuous-conversation/public-0.2.0` install Agent **0.2.0** at
`8f72cef9d459567acbc54f62e1175081617ab20d`. Its nested Assistant is **0.2.64** at
`921a5650f1937504a124574ad795ea222555a684`, while their direct Assistant pin has
already been upgraded to **0.2.75**. Compiling the current consumer/PG example
against those existing installations reproduced exit **2** in both NodeNext and
Bundler: incompatible branded conversation/citation identities and transport
types. The `stale-*.log` files retain these failures. Temporary reproduction
directories referenced the existing modules; this was diagnosis, not fresh
installation proof. No archived file was changed.

The active verifier also failed before installing: it accepted only an Assistant
URL containing `git@`, whereas the committed manifest uses bare public HTTPS.
The corrected verifier accepts either public HTTPS spelling, preserves the
frozen SHA, and generates the npm HTTPS-preserving consumer URL. It rejects
stale nested Assistant pins and non-HTTPS resolved entries in both the consumer
lock and installed metadata. Regression coverage exercises these checks. It now
imports and records all **11** public Agent SDK entrypoints.

The initial installed runtime run then failed because the fixture module guard
omitted `preparation.test.mjs`, which `runtime.test.mjs` already imports. Adding
that exact test fixture to the test-only allowlist restored the suite. Repository,
reference-build and SDK-source fallback remain prohibited and tested.

There are **no functional SDK source, dependency/version, or example changes**.
Changes are qualification tooling, its regression test, the fixture allowlist,
documentation and new evidence. All **110** locally built distribution files
match the fresh public Git installation byte-for-byte (`build-comparison.json`).
This worker leaves changes uncommitted; native delivery owns version/commit/push.
The future evidence-only delivery SHA is not the installed SDK SHA qualified here.

## Verification

Node **22.23.1**, npm **10.9.8**, TypeScript **5.9.3**, Agents **0.18.0**.
NodeNext pins Node declarations **22.20.4**; ESNext/Bundler pins **22.18.0** and
also compiles explicit provider/model composition. Both use `strict: true`,
`skipLibCheck: false`, and the current consumer plus application/conversation
examples through public package exports.

| Check | Result |
| --- | --- |
| Fresh `npm install`, then `npm ci`, per profile | Passed with separate empty caches and unchanged generated locks; normal Git prepare/build, no SDK source overlay. |
| NodeNext and Bundler typechecks | Both exit 0. |
| Public import checks | All 11 entrypoints resolve inside each external consumer's installed package and import successfully. |
| Initial `node tests/verify-git-install.mjs 0faf5214f0413886884e2f59e74a9b5ca0ba385e` | Exit 1 only at installed runtime: 61 passed, 1 failed due to omitted test fixture. Earlier install/lock/typecheck/import stages passed for both profiles. Preserved in `qualification-initial.log`. |
| Corrected `node tests/run-local-postgres.mjs --installed-consumer <fresh-node-next-consumer>` | Exit 0; **97 passed**, no failures/skips. Same unmodified installed SDK; only the test guard was refreshed. `installed-runtime.log`. |
| `npm test` | Exit 0; **778 passed**, no failures/skips, including builds and the new lock regression. `npm-test.log`. |
| `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json` | Exit 0; `root-consumer-typecheck.log`. |
| `node tests/run-local-postgres.mjs` | Exit 0; all **19 suites**, **428 passed**, no failures/skips. Owned temporary cluster stopped and removed. `postgres-all.log`. |

The entire install verifier was not rerun after the test-guard correction;
only its failed installed-runtime stage was rerun. The passing fresh install,
lock, type and import evidence above is from the initial invocation, not a
claim that its overall exit code was zero.

The published SDK manifest retains its bare HTTPS Assistant dependency URL.
The qualified consumer explicitly declares the same Assistant SHA using the
HTTPS-preserving form above; npm deduplicates to **one** Assistant 0.2.75. Both
generated consumer and installed locks resolve both SDKs to the exact HTTPS Git
pins. Git credential helpers/global rewrites and non-HTTPS protocols were
disabled. npm's internal GitHub archive downloads are part of Git dependency
installation, not tarball dependency declarations or a publishing workflow.

Each profile directory retains manifest and lock snapshots, installed metadata,
compiler configuration, dependency versions, build logs, empty successful
typecheck logs and public import names. Snapshot filenames intentionally differ
from active package-manager manifests: these are immutable evidence, not live
consumer projects. Run `tests/verify-git-install.mjs` to generate current fixtures.
Temporary workspace paths are normalized in retained consumer logs/metadata.

## Verdict and handoff

The paired pins above are compatible under the recorded Node/type profiles.
Mills should use that exact Agent commit and matching direct Assistant pin,
regenerate its ordinary npm lockfile and preserve the HTTPS resolved sources.
No reusable runtime defect was found by these checks.

Database verification uses the existing isolated PostgreSQL 15 cluster/schema
harness, actual migrations, transactions, encrypted persistence, Runner and
fresh-process recovery. Provider/model/native-executor boundaries are simulated.
This qualifies the SDK composition, not Mills application or production
acceptance. Mills integration, its production checks and subsequent owner review
remain downstream work. No Mills/Avery source, platform deployment, application
credentials, auth/access policy, live provider calls, external messages or
production config changed.
