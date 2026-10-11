# Agent SDK consolidation work record

Goal: replace the separate Assistant SDK across the AI Chatbot group while preserving runtime behavior and data. This file records source progress, not deployment acceptance.

## Consumer inventory

### Mills

Checked source: `34cd794b84803a6df2cf2df233a999331b4bbabd`.

| Legacy entrypoint | Files |
| --- | --- |
| `@handrail/ai-assistant` | 91 |
| `@handrail/ai-assistant/adapters/spartan-aegis` | 1 |
| `@handrail/ai-assistant/browser` | 1 |
| `@handrail/ai-assistant/client` | 18 |
| `@handrail/ai-assistant/persistence/postgres` | 70 |
| `@handrail/ai-assistant/providers/openai` | 1 |
| `@handrail/ai-assistant/providers/openai/transcription` | 2 |
| `@handrail/ai-assistant/react` | 8 |
| `@handrail/ai-assistant/react/styled` | 12 |
| `@handrail/ai-assistant/server/application` | 7 |
| `@handrail/ai-assistant/server/assistant` | 21 |
| `@handrail/ai-assistant/server/usage-control` | 4 |

### Hitcents

Checked source: `4357c00166e2612fd55fe6106975eb4e4b81f5ca`.

| Legacy entrypoint | Files |
| --- | --- |
| `@handrail/ai-assistant` | 64 |
| `@handrail/ai-assistant/adapters/spartan-aegis` | 2 |
| `@handrail/ai-assistant/browser` | 1 |
| `@handrail/ai-assistant/client` | 19 |
| `@handrail/ai-assistant/connectors/mcp` | 1 |
| `@handrail/ai-assistant/persistence/postgres` | 71 |
| `@handrail/ai-assistant/react` | 1 |
| `@handrail/ai-assistant/react/styled` | 4 |
| `@handrail/ai-assistant/server/application` | 72 |
| `@handrail/ai-assistant/server/assistant` | 7 |
| `@handrail/ai-assistant/server/usage-control` | 1 |

### Spartan

Checked source: `3712ae7975d3cc623a56487bcac49529c99c93f2`.

| Legacy entrypoint | Files |
| --- | --- |
| `@handrail/ai-assistant` | 56 |
| `@handrail/ai-assistant/adapters/spartan-aegis` | 1 |
| `@handrail/ai-assistant/browser` | 2 |
| `@handrail/ai-assistant/client` | 11 |
| `@handrail/ai-assistant/connectors/mcp` | 1 |
| `@handrail/ai-assistant/persistence/postgres` | 80 |
| `@handrail/ai-assistant/providers/openai` | 4 |
| `@handrail/ai-assistant/react` | 5 |
| `@handrail/ai-assistant/react/markdown` | 1 |
| `@handrail/ai-assistant/react/styled` | 4 |
| `@handrail/ai-assistant/server/application` | 14 |
| `@handrail/ai-assistant/server/application-gateway` | 1 |
| `@handrail/ai-assistant/server/assistant` | 14 |
| `@handrail/ai-assistant/server/usage-control` | 3 |

## Package mapping

- `@handrail/ai-assistant` → `handrail-agent-sdk/assistant`.
- Every former JS subpath → the same suffix beneath `handrail-agent-sdk/assistant`.
- Existing Agent SDK entrypoints remain unchanged, particularly `server/application` (the agent-to-gateway transport).
- Flutter `handrail_ai_client` → `handrail_agent_client`; Git package path `packages/handrail_agent_client` in the Agent SDK repository.
- Flutter `handrail_ai_widgets` → `handrail_agent_widgets`; Git package path `packages/handrail_agent_widgets` in the Agent SDK repository.
- Dart class names, wire protocol versions, persistence table names and stored identities remain stable.

## Work remaining

- Publish the locally qualified follow-up through an authorized SDK-targeted native path; the current native commit request was rejected (see publication gate below).
- Pin consumers to that real follow-up SHA, regenerate locks normally, and rerun Mills' stale-feedback regression plus relevant installed package checks.
- The Mills source-candidate feedback regression now passes; final installed qualification still requires the published follow-up pin.
- Validate hosted mobile previews and authorized deployed acceptance, including live usage delivery. Production database changes retain the human approval gate.
- Record final retirement evidence. Source consolidation and local fixture qualification do not establish that the legacy SDK is absent from deployed applications.

## Initial worktree facts

The Agent, JS Assistant, Flutter Assistant, Mills web, Hitcents web/mobile and Spartan web/mobile trees were clean at inventory. Mills mobile already had changes to `pubspec.yaml` and `pubspec.lock`; retain those changes when migrating.

## Qualification checkpoint (2026-10-11)

- Combined build, strict assistant typecheck, Agent acceptance typecheck and reference host compile passed.
- Full moved Vitest suite: **237 files / 2,663 tests passed**. Poll scheduling now waits for the active refresh to settle before choosing its next cadence; deactivating an idle client clears its queued wake. This corrects two failures reproduced in the original Assistant source.
- Existing Agent SDK default suite: **875 tests passed**. Usage wrapper: seven tests passed; consolidation/dependency tests: two passed.
- Flutter client analysis passed; 294 client tests passed initially and all 22 SQL-backed gateway tests passed after replacing the obsolete in-memory fixture. Three previously skipped gateway cases now execute.
- Flutter widget analysis and all 277 widget tests passed; combined client/widget lifecycle suite: 117 passed.
- Packaging, adoption CLI (including repeatability) and feedback gateway contracts: **64 checks passed**. Disposable PostgreSQL setup: two tests passed; assistance/transport: 65 passed; Stop: five passed; JS/Dart recovery projection: five passed.
- Public remote HEAD verified at `2d0d1ff54a65b1d8ce52c7a017c09b16300955d2` (package 0.3.1). Source changes after that checkpoint need separate publication. Public Git qualification passed for that exact revision: two strict consumer profiles, fresh-cache install/ci with unchanged HTTPS locks and no legacy dependency, and 108 installed-only runtime tests (zero skipped). Consumer application and deployed acceptance remain pending. See `docs/evidence/assistant-consolidation/public-install-0.3.1.json`.

## Provisioning inventory

Native Handrail readers confirm all three consumers already have provisioned PostgreSQL resources and enabled `ai_openai` / `ai_runtime` capabilities. The generated `HANDRAIL_AI_RUNTIME_*` environment contract supplies the telemetry binding and trusted service/environment identity. Reuse these bindings; consolidation alone does not require new infrastructure. Mills and Spartan also declare object storage; Hitcents must follow its existing attachment storage contract rather than acquiring an invented requirement. No production database writes or configuration changes were performed during this inventory.

## Next continuation

Revalidate the active goal and worktree, preserving concurrent changes. All six consumer source trees and dependency locks now target the public Agent revision. Mills and Hitcents web builds/typechecks pass; Mills mobile and cross-language checks pass. Consumer adoption of the locally fixed `prepare` race still needs SDK publication. Continue the pending checks, then resolve the publication gate without bypassing it. Deployed acceptance and retirement evidence remain outstanding.

Source qualification is not public-install or deployment evidence. The public Git qualification receipt explicitly identifies its tested revision.

## Consumer follow-up discovered during qualification

Mills' metering, admission and lifecycle groups pass against the public 0.3.1
revision. A feedback scenario exposed a client race: `prepare` could reuse a
display control read begun before its send intent, then reject the next message
after the server had already completed the preceding turn. The source fix waits
for the older read and starts a fresh authorized control read. Two regressions
prove both directions: a completed turn releases admission, while a newly active
turn still blocks it. Both fail before the fix and pass afterward; all 56 focused
session/polling tests pass. The full rerun passes: 237 files / 2,663 tests. The real Chromium/PostgreSQL
fixture also passes reopen, interrupted admission, next draft, duplicate Send,
Stop and account-replacement cases. A new published consumer pin is still
required before treating this correction as adopted. No production change is
implied by these local results.

Flutter pre-send qualification: 24 instrumented client cases and the public composer case pass against the consolidated gateway. Historical per-request traces explicitly disable bundled reads in their fixture; normal bundled-read tests retain the advertised capability. Attachment gateway smoke and client analysis also pass. These are local fixture results, not hosted Mobile Preview acceptance.

## Publication gate observed (2026-10-11)

The native `auto_commit` request for the Agent SDK repository was rejected with
`authorization_required` (403): "Use the native Dev Chat approval or shipping flow
for this action. V2 discovery does not grant authorization." No operation receipt
was returned. The exposed Dev Chat shipping controls target only the starting
Mills project and do not accept an SDK project target. Do not substitute a shell
commit/push or a different release action to bypass this rejection. The published
Agent revision remains `2d0d1ff54a65b1d8ce52c7a017c09b16300955d2`.
Consumer checks against that revision remain useful, but the fresh-prepare fix
and the optional setup helper are local only. Publication needs an authorized
SDK-targeted native path before final consumer adoption and release acceptance.

Normal Flutter bundled-read tests pass (12 cases), separately from the explicit
historical pre-send tracing mode.

## Installed consumer qualification (published 0.3.1)

Hitcents web: normal npm install regenerated the HTTPS lock at the real published
SHA; the adoption check reports no legacy imports or dependency. Full browser,
server and tools typecheck and production build pass. Six selected application
suites pass all 55 tests: native gateway/runtime, attachment integration, request
preparation, reconciliation, and React Cents drawer. This includes failed usage
delivery, outbox recovery after process recreation, receipt deduplication, trusted
attribution, approvals, retained attachments and history. Evidence logs:
`/tmp/hitcents-agent-{install,typecheck,build,integration}.log`. These tests use
fixture provider/telemetry responses and isolated PostgreSQL WASM, not live billing.

Mills mobile: normal Flutter resolution removed both legacy packages and pinned
the client/widgets to the public Agent revision. Full analysis passes with no
issues. Eight selected suites pass 91 tests covering session/CSRF handling,
account replacement, history, approval races, original document uploads, terminal
recovery and composer input. The installed Flutter-to-Mills gateway terminal
denial test also passes against an owned disposable PostgreSQL fixture (one
selected test, 57 intentionally filtered out). Logs:
`/tmp/mills-mobile-agent-{pubget,analysis,tests}.log` and
`/tmp/mills-agent-flutter-interop.log`. This is actual Git dependency adoption
with local interoperability; hosted preview and production acceptance remain pending.

## Hosted mobile observation

The native Mills dev Mobile Preview handoff returned `preview_not_running`,
`boundary: platform_blocker`, `app_failure_reproduced: false`. Native runtime
inspection showed all declared dev services stopped. The separately declared
Flutter assistant service is a staging deployment, not the configured dev preview.
No browser session was opened and no raw Flutter listener was used. This does not
constitute hosted acceptance or reproduce an application failure.

Spartan web: normal npm installation and the static source/lock check pass with
no legacy SDK dependency. Full typecheck (source and 550 test files), production
build and eight selected integration suites pass: 99 tests cover native tool
composition, authorization changes, approval/process recovery, usage capture,
attachments, retained schema data, composer and React UI. The native PostgreSQL
runner verifies its owned disposable database before use. Logs:
`/tmp/spartan-agent-{install,typecheck,build,integration}.log`.

Hitcents mobile: normal Git resolution, full analysis and three selected client,
file workflow and sheet suites pass (34 tests). Logs:
`/tmp/hitcents-mobile-agent-{pubget,analysis,tests}.log`.

Spartan mobile: full analysis initially exposed three pre-existing test-fixture
type errors and four missing-brace lints. The fixture callbacks now accept the
current expected-version argument; the prototype renders a missing vendor ID
explicitly; existing control flow is enclosed in braces. Full analysis now passes,
as do 78 selected assistant/bank fixture cases. One historical source-only paged
activity case was initially skipped; its installed-SDK qualification is tracked
separately. Logs: `/tmp/spartan-mobile-agent-analysis-final.log` and
`/tmp/spartan-mobile-agent-tests.log`.

The existing Mills Mobile Preview configuration was reconciled through the native
configuration API after its missing service was confirmed. The API created the
configured dev-only Mobile Preview service at its declared port and reported it
stopped; the updated contract applies on its next native start. No production
configuration or service was changed by this repair.

The guarded Spartan paged-activity case passes against the installed Agent SDK;
the obsolete `HANDRAIL_TEST_LOCAL_SDK` skip was removed and the case passes again
under default flags. The selected mobile total is now 79 passing cases (78 in
the grouped run plus this separately qualified case), with no remaining skip in
that repository test.

The native Mills dev web start request was rejected with `authorization_required`
(403), directing this chat to the native Dev Chat approval/shipping flow. No
start receipt was returned. No alternative shell start or raw Flutter listener
was used. Preview configuration reconciliation succeeded; starting the services
and hosted QA remain blocked by the runtime authorization gate.

## Final local checkpoint for this turn

The Mills stale-feedback regression passes against the unpublished SDK source
fix (one selected test; 58 unrelated cases filtered out), after full candidate
typecheck and server compile. The source-candidate runner now unifies identical
OpenAI versions using the correct ESM declaration entrypoint; it refuses different
versions and verifies manifests/locks remain unchanged. This is local candidate
qualification, not publication or installed adoption of the fix.

All six consumer lockfiles contain the real public Agent SHA and no legacy
Assistant dependency. All three web full typechecks/builds and all three mobile
analyses pass. See `docs/evidence/assistant-consolidation/consumer-qualification-2026-10-11.json`
for exact source bases, lock hashes and bounded test counts. SDK follow-up
publication, subsequent consumer repins, authorized hosted preview and deployed
acceptance remain outstanding. The old repositories must not be retired yet.

## Requirement audit after consumer qualification

Completion remains unproven. This audit preserves the full goal scope.

| Requirement | Evidence available | Remaining evidence or action |
| --- | --- | --- |
| 1. Move adopted runtime capabilities and remove the SDK dependency | Agent-owned gateway/client/persistence source; no legacy dependency in Agent or six consumer locks; moved runtime suite and consumer history/recovery tests | Publish the locally corrected client follow-up and verify it from the installed revision |
| 2. Own Flutter and React UI | Native Dart packages under `packages/`; React subpath exports; all mobile analyses, widget and consumer UI tests; public Git package qualification | Adopt the follow-up revision and complete hosted acceptance |
| 3. Trusted durable usage | `server/usage`, seven wrapper tests, shared outbox tests and consumer restart/deduplication tests; Mills uses the shared wrapper | Confirm actual runtime delivery after authorized release; fixture telemetry is not live settlement evidence |
| 4. Repeatable setup/provisioning | Explicit inert PostgreSQL setup helper, repeated owned-database setup tests, resource/capability inventory and setup guide | Publish optional setup entrypoint and qualify its installed boundary; native release/runtime access must be available |
| 5. Migrate all in-scope consumers | Six real public-SHA dependency locks, three web builds/typechecks, three mobile analyses and recorded bounded integration tests | Repin to published fix, rerun installed Mills regression, release consumer changes, verify hosted/deployed behavior |
| 6. Migration and retirement documentation | Source provenance, package mapping, setup/mobile contracts and per-revision qualification records | Final retirement decision requires the missing publication, adoption and runtime evidence; old repositories remain intact |

The next autonomous turn revalidated the same publication gate: the native repo
reader reports Agent HEAD `2d0d1ff54a65b1d8ce52c7a017c09b16300955d2`, local
follow-up changes and zero unpushed commits. Public HEAD agrees. The exact native
Mobile Preview reader reports `stopped`, no supervisor PID, no listener and no
QA route. There is no live job to wait on. The exposed native Dev Chat shipping
controls still target only the starting Mills project; they cannot publish the
Agent repository. The rejected commit and start actions were not retried or
substituted. This is the second consecutive goal turn with the same authorization
dependency; the goal remains active until the blocked-audit threshold is met.

Resume work when an authorized native SDK commit/push path is available. Publish
the reviewed follow-up first, verify its actual public full SHA, update all six
SDK pins and normal locks, then rerun installed package boundaries (including
`server/setup`) and the Mills feedback regression. Start the declared dev services
through native controls, obtain a new environment-matched Mobile Preview handoff,
and use its private QA profile helper. Release and deployed acceptance follow
only after these checks. Never use a shell release/start to evade the native
rejections or treat another project's Ship control as SDK publication.

## Blocked audit conclusion

The third consecutive goal-turn audit confirms the same external authorization
dependency. Public and local Agent HEAD remain the published 0.3.1 SHA; the
qualified follow-up is still uncommitted. Native Mobile Preview remains stopped
with no supervisor, listener or browser route. No live job is awaiting completion
and no applicable SDK-targeted native approval/publication control has appeared.
The goal is blocked, not complete. Work and evidence remain available for an
authorized continuation; no old repository has been deleted and no deployed
acceptance is claimed. Resume at the publication/adoption steps above after the
platform authorization path is available.
