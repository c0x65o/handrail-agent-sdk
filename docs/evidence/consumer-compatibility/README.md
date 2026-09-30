# Consumer compatibility correction

Work request `0188dca4-e120-5d5b-af45-03b33c8aab11`, 2026-09-30.
Published baseline: **v0.1.3**, full SHA
`4d1f995e2bf337fb4ad9552bb675dade0f633fdb`.
Destination: qualify the SDK's public Git installation for the owner's first
application test. No application was selected/migrated or deployed. Temporary
consumer directories and a disposable PostgreSQL cluster are verification only.

## Reproduced causes

The original `node tests/verify-git-install.mjs 4d1f995e2bf337fb4ad9552bb675dade0f633fdb`
failed with exit 1; its strict TypeScript subprocess failed with exit 2. See
[exact diagnostics](default-errors.log) and [original manifest/lock/versions](default-resolution.json).
There were three TS2416 errors at:

- `@openai/agents-core/dist/lifecycle.d.ts(73,15)` (`AgentHooks.eventEmitter`).
- `@openai/agents-core/dist/lifecycle.d.ts(139,15)` (`RunHooks.eventEmitter`).
- `@openai/agents-realtime/dist/openaiRealtimeBase.d.ts(57,15)` (`OpenAIRealtimeBase.eventEmitter`).

The installed declaration chain was inspected, not inferred from a failed
package build: `handrail-agent-sdk/dist/server/agent-runtime.d.ts` imports
`Model` from `@openai/agents`, whose index reexports core and realtime.
`agents-core/dist/lifecycle.d.ts` overrides its structural `EventEmitter` with
`RuntimeEventEmitter`; `dist/shims/shims-node.d.ts` exports that from `node:events`.
Node 26.6.3's conditional listener/event-name signatures do not satisfy those
Agents 0.18.0 overrides. `npm explain @types/node` in the original consumer showed:

```text
@types/node@26.6.3
  @types/node@"*" from @types/ws@8.18.2
    @types/ws@"^8.18.1" from @openai/agents-realtime@0.18.0
      @openai/agents-realtime@"0.18.0" from @openai/agents@0.18.0
        @openai/agents@"0.18.0" from handrail-agent-sdk@0.1.3
```

The SDK's **dev** `@types/node: 22.20.4` controls Git `prepare`, not application
resolution. No Handrail public type defect was needed to explain the failure;
no engine/declaration/dependency upgrade was made. The consumer now explicitly
pins the supported Node 22 declarations and checks them without suppressions.

For the second failure, npm **10.9.8**'s installed
`pacote/lib/git.js:repoUrl` prefers `h.sshurl` unless the HTTPS URL has `h.auth`.
The original manifest's bare `git+https://github.com/…#SHA` therefore became
`git+ssh://git@github.com/…#SHA` in the lock. Merely normalizing the root lock
then running `npm ci` was rejected by the new verifier: npm wrote SSH into the
installed hidden lock again ([failed diagnostic](normalization-rejected.log)).
That attempted workaround was removed.

The correction uses **`git+https://git@github.com/c0x65o/handrail-agent-sdk.git#SHA`**.
The literal public username selects npm's HTTPS handling; no password, token,
private key or new credential is involved. Both generated root and installed
locks must match this exact spec. No lock editing occurs in the final verifier.
The following credential-free probe returned the published SHA at HEAD:

```sh
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https \
git ls-remote https://git@github.com/c0x65o/handrail-agent-sdk.git HEAD
```

## Verification commands and contract

Run sequentially from the SDK root:

```sh
# Full supported matrix, including installed runtime and real disposable DB:
node tests/verify-git-install.mjs 4d1f995e2bf337fb4ad9552bb675dade0f633fdb
# Separate negative reproduction: success here means the failures reproduced.
node tests/verify-git-install.mjs 4d1f995e2bf337fb4ad9552bb675dade0f633fdb --reproduce-default
# Local source build, contracts, packaging and lock rejection regressions:
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
# Existing durable runtime and lease/journal checks, one suite at a time:
node tests/run-local-postgres.mjs test:agents test:lease test:journal
```

Each supported consumer runs these commands in its own directory outside the
repository, with separate initially empty npm caches for install and reinstall:

```sh
npm install --include=dev --no-audit --no-fund --foreground-scripts --loglevel=http
npm ci --include=dev --no-audit --no-fund --foreground-scripts --loglevel=http
node node_modules/typescript/bin/tsc -p tsconfig.json
```

The verifier isolates Git system/global configuration, disables credential
helpers and prompting, allows only Git HTTPS, and uses public npm registry
resolution. Retained transport excerpts show fresh HTTPS downloads of the exact
Git revision and normal `prepare`/`tsc` execution. npm's internal GitHub archive
fetch is not a tarball dependency; both manifest and locks remain SHA-pinned Git.
The root lock must remain byte-for-byte unchanged by `npm ci`.

The supported matrix is Node **22.23.1**, npm **10.9.8**, TypeScript **5.9.3**:

| Consumer | Node types | Resolution | Additional coverage |
| --- | --- | --- | --- |
| Minimal SDK dependency | 22.20.4 | NodeNext | All public entrypoints, typed host/state/tool ports, rejected invalid inputs |
| Explicit provider and Zod dependencies | 22.18.0 | ESNext/Bundler | Headless example and official provider Model/Zod integration |

Both use `strict: true`, `skipLibCheck: false`. No `any` casts, installed-module
patches or declaration suppression were added. The preexisting reference DB
build configuration is unchanged; it is not used as the consumer type verdict.
`engines.node >=22` remains a minimum, not a claim of qualification for every
newer runtime. Other runtime/type combinations are unverified.

## Fresh results

The [qualification transcript](qualification.log) passed against the published
SHA above. Both consumers installed and rebuilt normally, then reinstalled from
unchanged HTTPS locks with an empty cache. Both strict typechecks exited 0.
[Supported manifest/lock/config/version excerpts](supported-consumers.json) and
[fresh HTTPS download/prepare excerpts](https-prepare-excerpts.log) retain the
actual observations, not proposed manifests. Resolved upstream versions were
Agents/core/openai/realtime 0.18.0, OpenAI client 7.25.0, Zod 4.3.6 and
`@types/ws` 8.18.2.

The installed-runtime PostgreSQL test passed: **4** mocked HTTP model responses,
**3** persisted tool results, **1** verified effect. A second wake made no new
model request and left the provider dispatch-attempt count at **1**. The owned
temporary PostgreSQL 15 cluster stopped successfully. Tracing-disabled upstream
`NoopSpan` diagnostics are retained in the log; they were not provider requests.

The [negative reproduction](default-reproduction.log) passed its reproduction
assertions: consumer compilation still exited **2** with exactly the three
TS2416 errors and Node types **26.6.3**; the raw generated lock was SSH. This means
the unsupported default consumer **failed**, not Node 26 compatibility.

The [local package checks](package-checks.log) passed **775/775** tests with zero
skips/failures, including strict package-export compilation and the new lock
rejection regressions. The additional standalone consumer typecheck exited 0.
`npm test` also ran SDK, acceptance, PostgreSQL-helper and reference builds.
The [disposable PostgreSQL regressions](postgres-checks.log) passed sequentially:
**17/17** runtime, **9/9** lease and **14/14** journal tests, zero failures/skips;
the owned cluster stopped successfully. This rechecks the existing runtime
fixture after its additive installed-factory injection path was introduced.

## Settlement check still required

**The final changed delivery revision is UNVERIFIED as a public installation.**
This worker leaves source uncommitted; only Handrail's pipeline can create and
push the new revision. Avery must run this exact fixture against the full SHA
returned by settlement (not a branch/tag or the baseline SHA):

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

The installed runtime check uses installed public SDK factories, Agent/Runner,
and the official OpenAI provider/client, plus the existing real PostgreSQL
reference repositories/migrations. Only model HTTP/SSE transport and the
external effect boundary are simulated. It proves persisted multi-step work
and duplicate-effect protection within that boundary. Live-model behavior,
browser behavior, sustained/unattended runs, native host integration and the
owner's first application remain **unverified**. No deployment, external
provider effect, commit or push is performed by this worker.
