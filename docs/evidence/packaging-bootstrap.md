# Packaging bootstrap evidence

Date: 2026-09-27. Selected item: `186147b0-fe52-461e-88fa-fb95307b228c`.
Work request: `41353d61-3103-469a-a88c-6577f8923c1e`.

Handrail current context confirmed the supplied project, goal, task and change
lane. Before edits, `git branch --show-current`, `git rev-parse HEAD`,
`git status --short` and `git ls-files` confirmed `lane/agent-sdk-v1` at
`3fb1580b8da396ff54c9b8dbf4a65f40592a37f9`, clean, with only README.md,
.gitignore and docs/Handrail_Agent_Runtime_Concept.md tracked. No recovery was
needed. The separate ownership document is absent and was not recreated.

## Toolchain

- Actually tested: Node `v22.23.1`, npm `10.9.8`, Linux.
- Declared compatibility: Node `>=22.0.0`. Other versions were not tested.
  Node 22 is in Maintenance LTS through 2027-04-30 per the official
  [release schedule](https://github.com/nodejs/Release). This floor satisfies
  the Node >=20 contract without selecting the now-EOL Node 20 line.
- Only dependency: development compiler `typescript@5.9.3`, pinned exactly.
  No runtime dependencies. Registry metadata and the installed manifest both
  declare TypeScript's Node requirement as `>=14.17`.
- `npm view npm@10.9.8 engines --json` reported
  `^18.17.0 || >=20.5.0`; the declared SDK floor satisfies both tools.
- Lockfile v3 SHA-256, identical in source and before/after disposable validation:
  `c68dc3add2958204f912ab4f8664b279662e5781f35cc39510b5fa38ba0186f9`.

## Commands and results

From the repository root, generated the intended lockfile with:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /opt/handrail/.handrail/codex-runs/35103dc2-0e92-482b-9f6e-16faad1a4c25/tmp/npm-cache
```

Exit 0. The successful disposable validation used these exact commands:

```sh
set -eu
validation_dir=$(mktemp -d /opt/handrail/.handrail/codex-runs/35103dc2-0e92-482b-9f6e-16faad1a4c25/tmp/agent-sdk-packaging.XXXXXX)
cp package.json package-lock.json tsconfig.json "$validation_dir/"
cp -R src tests "$validation_dir/"
printf '%s\n' "$validation_dir"
cd "$validation_dir"
node --version
npm --version
sha256sum package-lock.json
npm ci --include=dev --no-audit --no-fund --cache /opt/handrail/.handrail/codex-runs/35103dc2-0e92-482b-9f6e-16faad1a4c25/tmp/npm-cache
npm run build
npm test
sha256sum package-lock.json
npm ls --all
```

Disposable directory suffix: `agent-sdk-packaging.01Daws`. All commands exited 0.
`npm ci` installed one package and ran `prepare` -> `npm run build` ->
`tsc -p tsconfig.json`. The separate explicit build also exited 0.
Because the worker sets `NODE_ENV=production`, `npm ls --all` hides dev
dependencies. A subsequent `npm ls --all --include=dev` exited 0 and showed
exactly `typescript@5.9.3`.

The first disposable attempt (`agent-sdk-packaging.YrGj3M`) used the same
`npm ci` command without `--include=dev`. It exited 127 during prepare:
`sh: 1: tsc: not found`. `npm config get omit` returned `dev`, and
`process.env.NODE_ENV` was `production`. This was corrected by explicitly
including build dependencies in the fresh copy and documenting that command.
The resource guard reported 55 MiB peak memory and zero OOM kills for that
failed attempt. No unrelated pre-existing test failures were encountered.

## Acceptance outcomes

`npm test` executes:

```sh
node --test --test-concurrency=1 --test-reporter=tap tests/packaging.test.mjs
```

TAP totals: **5 tests, 5 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**.

- Separate child processes dynamically imported `handrail-agent-sdk` and
  `handrail-agent-sdk/server` by package name. Each printed `[]`, exited 0
  naturally, and had no termination signal. Each child has a 10,000 ms timeout;
  no `process.exit` is used. Observed test durations were 42.901 and 38.215 ms.
- AST inspection of both TypeScript entrypoints and both emitted JavaScript
  files found only an empty export declaration. There are no import edges,
  re-exports, executable startup statements, timers, workers, database clients
  or provider requests. The root cannot load server implementation.
- The NodeNext TypeScript consumer ran with strict checking, no emit, no path
  aliases and no ambient types. Exact child command:
  `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json --traceResolution`.
  Exit 0; resolution traces confirmed `handrail-agent-sdk` -> `dist/index.d.ts`
  and `handrail-agent-sdk/server` -> `dist/server/index.d.ts` through exports.
  Compile-time assertions confirmed both bootstrap namespaces are empty.
- The unexported implementation path `handrail-agent-sdk/dist/server/index.js`
  was rejected at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED` and at compile
  time with an expected diagnostic.
- Manual emitted-file inspection confirmed both declarations are `export {};`.
  Repository `git diff --check` exited 0.

This is local packaging/self-reference consumer evidence, not a clean public-Git
consumer installation or runtime feature proof. M6 retains the Git-install
acceptance task. The documented distribution policy remains public HTTPS Git
with full 40-character commit pins and matching consumer lockfiles. No SDK was
adopted in a consumer, published or deployed. No CI job, service, provider
operation, commit or push was performed. Source changes remain uncommitted for
Handrail's post-agent workflow.
