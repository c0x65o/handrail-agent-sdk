# Complete application catalog repair — candidate evidence

Work request `74fd5670-844f-5d7d-b378-44d6f5d4f9e3`; original Mills outcome
`9fd48d7e-2e9d-49e7-976d-b852efe42b72` remains OPEN. The usable destination is
the existing Mills DEV web application with full Flutter parity and its complete
assistant catalog. This assignment repairs the shared SDK prerequisite only.
Consumer repositories were read-only; no application pin, runtime, provider,
deployment, real reminder, feedback request or notification was changed.

The starting public SDK is **0.1.6**, full SHA
`f6eb0ef10af89a8ecaea0707610d7709483eaa49`. Packaging was already qualified.
These source changes remain uncommitted for the native pipeline's version bump,
commit and push. No candidate test is proof of a newly published Git revision.

## Source and failure identities

The source report remains in Mills
`docs/qa/agent-runtime-public-2026-09-30/README.md`, from work
`9c852f82-4da5-5b8b-9a51-091725fe206d`, run
`3fb5541a-e561-4b4c-a7a1-8dc088fd68fc`. Its old uncommitted statement predates
the native pipeline: web `8bd861cdeadb4de644fbfeaed11bf0a94260b30b` (1.0.340),
mobile `7fac032b125d25e22dd76d7d8533f07734bee012` (1.0.259).

`scripts/capture-mills-catalog.mjs` imports the consumer's original catalog
factories with fail-on-use business ports, using its own installed tsx loader.
It exports schemas without rewriting them. Capture observed web HEAD
`8bd861cdeadb4de644fbfeaed11bf0a94260b30b` plus the shared working tree. The
committed regression fixture is `tests/fixtures/installed/mills-catalog.json`:

- Original inventory: 85 names, all present, original schema subset tested.
- Current domain: 87; requested catalog including assistance: 92.
- Current complete catalog including Travel: 100.
- SHA-256 of captured fixture:
  `e0765904eac404da0b82cf23b6c610d50d64646868a993f810d9a5681ae6ccc0`.
- Original `mills-catalog.json` report SHA-256:
  `1888226e6796a342a70b65f743a04dde86a2176e722ff0b1087b8e4b3ba05afc`.
- Original `current-main-catalog.json` report SHA-256:
  `7332609605a2dfd4d9095c283c22ac049cdb754f84d2ea56ebe6cd8bcb3cf204`.

The consumer generated its schemas with Zod **4.4.3**; SDK legacy Zod tools and
the failure reproduction use **4.3.6**. The repaired application boundary takes
JSON Schema and does not compare or round-trip those Zod implementations.

The retained reports contain full schemas only for their failing tools. Those
22 and 26 schemas and exact failure messages are also retained in the fixture
and tested separately. Three Travel schemas changed in shared consumer source
since that report: `travel_create_trip`, `travel_create_item`, and
`travel_update_item` now describe input defaults as optional. We test both the
unchanged current 100-tool catalog and every retained historical failing schema;
we do not claim to possess an older complete schema snapshot that was not saved.

`node tests/reproduce-tool-schema.mjs` reproduces the published algorithm's
22/92 and 26/100 failures and asserts exact historical error messages. See
[reproduction.json](reproduction.json). Failure was JSON Schema → Zod → strict
upstream conversion: optional non-null members and generated `allOf` constraints.

## Repair and compatibility

The application adapter now compiles the original JSON Schema with Ajv and
ajv-formats and sends that same schema using upstream `strict: false`.
Validation occurs before approval and again before authorized IO. It does not
coerce values, strip fields, fill defaults or conflate absence and null.
Application business validation, permission locks, effect identity, leases,
approval, cancellation and recovery remain authoritative. There is one Runner.

See [the public contract](../../agent-runtime.md#application-tool-schemas) for
dialects, fail-closed unsupported semantics, and the typed
`ZodObject | AgentJsonSchemaParameters` compatibility change. Host-authored Zod
tools retain their prior path. Application consumers continue passing the
adapter's result directly to `createAgentRuntime`; diagnostics must stop
passing its parser wrapper directly to upstream `tool()`.

The upstream 0.18 implementation (`agents-core/dist/utils/tools.mjs`) passes raw
schemas unchanged in non-strict mode and only JSON-parses their arguments. Its
TypeScript non-strict type unnecessarily requires `additionalProperties: true`.
A single local assertion bridges that declaration restriction, without changing
the original schema. Runner tests assert exact schema equality at the model
boundary, including `additionalProperties: false` and omitted `required` keys.

## Candidate verification

Commands run sequentially, with test concurrency one:

```sh
node tests/reproduce-tool-schema.mjs
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node tests/run-local-postgres.mjs test:assistance
# Public base installation + clearly labelled uncommitted source qualification:
node tests/verify-git-install.mjs f6eb0ef10af89a8ecaea0707610d7709483eaa49 --candidate-source
# Existing durable stores, leases, journal, effects and Runner regressions:
node tests/run-local-postgres.mjs
```

The full catalog is constructed by `createAgentRuntime`, using the real Agent,
Runner, streaming, interruption, RunState and encrypted PostgreSQL checkpoints.
Every emitted schema is compared to the original. Controlled calls cover reads,
calendar partial updates, reminder dates/offsets and nested Travel patches.
The independent laboratory example covers references, intersections, exclusive
unions, arrays, patterned metadata, numeric bounds and nullable patch values.
Negative calls cover malformed JSON, null/array roots, missing/unknown fields,
wrong types, UUID format and pattern, date/time constraints, min/max lengths,
nested recurrence constraints, array bounds and non-null optional properties.
They never reach effects. A separate business refinement rejects a structurally
valid but invalid IANA zone before an effect. Recovery, repeated/conflicting
call IDs, approval rejection, cancellation and scope revocation are exercised.

The model boundary and domain effects are synthetic; PostgreSQL, Runner,
validation, authority callbacks and durable SDK stores are real. Existing
runtime tests additionally exercise separate-process recovery and state binding.
No live provider HTTP, Mills database, real delivery or rendered client QA is
claimed. Temporary PostgreSQL clusters are stopped and deleted by the harness.

Final results and installation receipts are recorded alongside this document.
The consolidated [result.json](result.json) records the candidate's source hashes
and keeps `publishedRepairedSha: null` until the native pipeline publishes it.
The SDK contracts passed **777/777**, and the strict local consumer typecheck
exited zero. The isolated installed candidate passed **77/77** tests with no
skips: [runtime log](candidate-runtime.log), [consumer receipts](candidate-consumers.json),
and [installation log](candidate-install.log). Both NodeNext and Bundler use
`skipLibCheck: false`; the original Node 22 type pins are unchanged.
The complete disposable PostgreSQL command passed **391/391** tests across all
**17** suites, with zero skips/failures; see [postgres-all.log](postgres-all.log).
This includes the final **63-test** assistance/application suite (the earlier
focused log has 60 tests, before three additional negative regressions).
The installed candidate's three changed compiled runtime modules were compared
byte-for-byte with the final local build and matched.

An unchanged copy of the consumer's actual `agent-composition.ts` was compiled
inside each isolated candidate consumer, with zero diagnostics in both modes.
Its SHA-256 is
`471660cdbf1fd67fd90c8a02307500a4d401da750c2b0c41014f700ce36ba225`;
see [composition receipts](mills-composition.json). This checks the real public
composition boundary, not the whole consumer application or its runtime.

Candidate installation uses a full-SHA public HTTPS dependency and matching
root/installed locks, then overlays uncommitted source **only in the isolated
verification package**, compiling it through `prepare`. It is explicitly tagged
`candidateSourceOverlay: true`; it is not a dependency source, release artifact,
consumer installation or substitute for final public-SHA verification.

## Required continuation after native publication

1. Obtain the exact next SDK version and full 40-character public SHA from this
   work request's native commit/push receipt. Do not reuse the base SHA as the
   repaired revision. The worker cannot report a future SHA before publication.
2. Run `node tests/verify-git-install.mjs <PUBLISHED_FULL_SHA>` without
   `--candidate-source`. This requires clean public HTTPS install/reinstall,
   strict NodeNext and Bundler compilation (`skipLibCheck: false`), and the same
   complete catalog/Runner/PostgreSQL regressions under the installed-only
   filesystem/module guard. Retain `results.json`, both typecheck logs and
   `runtime.log`; require `candidateSourceOverlay: false`.
3. Avery's consumer work updates Mills via its normal manifest/lock pipeline:
   `git+https://git@github.com/c0x65o/handrail-agent-sdk.git#<PUBLISHED_FULL_SHA>`.
   Preserve the separately assigned AI SDK Stop repair and its exact delivered
   revision. Refresh the normal lock; verify manifest, root lock and installed
   metadata all identify the same public HTTPS SHA. Do not use internal imports,
   file/tarball/workspace dependencies, tags, branches or copied SDK source.
4. Keep all original domain schemas/validators. Update the old construction
   diagnostic to pass `createApplicationAgentTools(...)` into the public
   runtime and inspect its injected model request, as `catalog.test.mjs` does.
   Re-capture and compare the latest complete consumer catalog; no dropped names
   or schema relaxations. Change the runtime `definitionRef` for changed schema
   semantics, and reconcile existing pending work with the existing host policy.
5. Run the consumer's scoped strict server compile and its controlled real
   Runner/domain permission tests, then the authorized live DEV checks and
   independent web/Flutter parity QA from the original source report. Provider
   capability, domain refinements, attachments, durable Stop, metering and
   application activation remain consumer verification, not facts established
   by this SDK fixture. Avery reads the receipts and determines outcome acceptance.

No new worker, goal, deployment or packaging job is needed for this handoff.
