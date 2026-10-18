# Deferred catalog capacity repair — 2026-10-18

## Checkout and scope

- Repository: `c0x65o/handrail-agent-sdk`; branch: `main`.
- Inspected HEAD: `f8a57ed9be317814090eb4af378d4ea209385dab`; initial working tree clean.
- No applicable `AGENTS.md` was found in the checkout or its ancestor paths.
- Recent history included `c174fe1` (hosted native dispatch/catalog fixtures),
  which is separate from this capacity fix. It was not reopened.
- Existing planner support already validated `maximumTotalTools` in 1–1024,
  defaulting to 256. The provider exposed/forwarded only `maximumEagerTools`.
  This repair reuses the planner validation rather than duplicating it.
- Handrail MCP `handrail_current_context` was unavailable in the run's tool list.
- Node `v22.23.1`; npm `10.9.8`; Vitest `3.2.4`.

## Reproduction and implementation

Before the source fix, this command exited 1 with **5 failed / 33 passed**:

```sh
npm run test:assistant -- tests/assistant/deferred-tool-discovery.test.ts tests/assistant/openai-responses-catalog-bound.test.ts
```

The standalone planner accepted explicit larger limits, while adapter limits
261/512/1024 and server-provider limits 261/512 still returned `failed` for 259
domain functions plus two auxiliaries. No mocked transport opened in those
failing cases. Default 257-tool overflow reproduced the planner's exact
`Discovered tool catalog exceeds maximumTotalTools` error.

The provider now exposes and forwards `maximumTotalTools`. Its server API
inherits/forwards the option and includes it in durable operation fingerprints.
Default total capacity 256, eager capacity 16, and 1–1024 validation are unchanged.
No catalog is truncated. No execution, approval, schema or namespace checks were
relaxed. See [configuration and adoption](../deferred-tool-catalog.md).

An intermediate test run found fixture assumptions about registry sort order
and SDK-added file tools; the fixtures were corrected to assert the complete
actual set (263 functions for saved-file approval cases). No production behavior
was changed to accommodate those fixtures.

## Validation

Focused command (exit 0, **10 files / 165 tests passed**):

```sh
npm run test:assistant -- tests/assistant/deferred-tool-discovery.test.ts tests/assistant/openai-responses-catalog-bound.test.ts tests/assistant/openai-responses-eager-bound.test.ts tests/assistant/openai-responses-tools.test.ts tests/assistant/openai-responses-stream.test.ts tests/assistant/openai-responses-tool-loop.integration.test.ts tests/assistant/server-approval-pause.integration.test.ts tests/assistant/tool-registry.test.ts tests/assistant/tool-executor.test.ts tests/assistant/assistant-tool-runtime.test.ts
```

Coverage includes planner boundaries at 1, 256, 261 and 1024; overflow and invalid
values; unchanged default/eager behavior; the actual adapter/server discovery
path; every authorized function and schema retained; actor/capability exclusion;
spoofed names/namespaces rejected; existing eager-only fallback; execution policy
and argument validation; confirmed/rejected approvals; restart, exactly-once
execution and store:false continuation with the complete catalog.

Provider transport is mocked; there were no live provider calls. Persistence
cases reuse the repository's embedded PGlite PostgreSQL harness and migrations,
not a fake repository. No external PostgreSQL lease/journal test was needed for
this configuration-only change.

- `npm run typecheck:assistant`: exit 0.
- `npm test && node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json`:
  exit 0; **937 tests passed**, no failures/skips. The pretest pipeline ran
  `npm run build`, `npm run typecheck:acceptance`, `npm run build:test-postgres`
  and `npm run build:reference`, all successfully. The public consumer fixture
  verifies the new option through both exported provider APIs.
- `npm run lint`: exit 1, `Missing script: "lint"`. No lint script/configuration
  exists in this repository; no unrelated tooling was introduced.
- `git diff --check`: exit 0.

The additional strict test-source check initially found two fixture typing
errors (intentional malformed schema input and readonly messages). The fixtures
were corrected without changing source behavior or assertions. Final commands:

```sh
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --skipLibCheck --jsx react-jsx tests/assistant/deferred-tool-discovery.test.ts tests/assistant/openai-responses-catalog-bound.test.ts tests/assistant/server-approval-pause.integration.test.ts
npm run test:assistant -- tests/assistant/deferred-tool-discovery.test.ts tests/assistant/openai-responses-catalog-bound.test.ts
```

Both commands exited 0; the final rerun passed **2 files / 43 tests**.

Some checks waited for the shared heavy-command slots; configured Vitest and
Node test concurrency limits were retained. The intermediate PGlite-inclusive
test run reported a 994 MiB peak, zero swap and zero OOM kills; its failures were
fixture assertion failures, not resource failures.

## Source identity

These are SHA-256 content hashes of uncommitted files, not public Git revisions:

```text
1c88d91922e25664a9e6ca31e19be8b0c80ebf07635d85a8353b80a5b998d1cb  src/assistant/providers/openai-responses.ts
1035db6405df9f5d75500229950a5309c01298d96c988eae35228775c26bdbba  src/assistant/server/openai-responses.ts
663c2cfe725c1868e83aef293d43b20d33ea4fe6fe3c38d8d16c0ccac7e92fd0  src/assistant/tools/deferred.ts
f72ebbcd778e643509d8ab39b97e5f163e35800b5cdc1b4ddb501862fc7067f1  tests/assistant/deferred-tool-discovery.test.ts
db6a72f4309747e50f8c420bc7bf1ae3312c571c0f6a0fab994e66a0e5029ce1  tests/assistant/openai-responses-catalog-bound.test.ts
408ebc3316096b58186b65986bf251afd8efbba4bc27b45e277d0a44a8f1823e  tests/assistant/server-approval-pause.integration.test.ts
be44d08c507bcd98eb646371fc74707c8eb9cff6d107e41ec873cc48850c8e21  tests/fixtures/consumer.mts
```

## Outstanding consumer evidence

No ERP/mobile files, installed dependencies, live configuration, database/queue
state or Owner Goal state were changed. No commit, push, PR, publication or
deployment was performed. Handrail finalization still owns the version/commit/
push; no corrected public SHA is asserted here.

The SDK approval/continuation checks pass with the larger catalog. The ERP
administrator finance-ledger-discovery test and failure trace are absent from
this checkout, so their causal connection to the catalog limit remains
unverified. A later authorized ERP adoption must pin the available corrected
full Git SHA with a matching lockfile, configure a sufficient total budget on
both planner and provider, and prove the complete catalog and administrator
ledger regressions before item `2cc53946-2851-4e77-9dab-b8e6d27c7133` is finished.
The existing Web Unit Tests item `a30d9713-fec4-4b28-8743-79c49d21ea42` retains the
subsequent final-source full-suite check and its historical failures/partial
repairs. Optional QA infrastructure is outside this repair.
