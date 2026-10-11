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

- Qualify transferred JS behavior, package boundaries, native agent execution and Flutter clients/widgets.
- Adopt the implemented shared per-invocation usage model wrapper in Mills; validate actual usage, durable outbox delivery, deduplication and restart recovery. The transferred usage-control gateway client and outbox are the existing implementation, not new billing authority.
- Inspect declared setup/provisioning capabilities and expose repeatable supported setup.
- Publish a verified Agent SDK Git revision only with current release authorization, then adopt its full SHA and regenerate all consumer locks.
- Migrate Mills first, then Hitcents and Spartan; run consumer builds and behavior checks.
- Validate authorized deployments and mobile previews with declared platform tools. Production database changes retain the human approval gate.
- Update retirement documentation without deleting the old repositories.

## Initial worktree facts

The Agent, JS Assistant, Flutter Assistant, Mills web, Hitcents web/mobile and Spartan web/mobile trees were clean at inventory. Mills mobile already had changes to `pubspec.yaml` and `pubspec.lock`; retain those changes when migrating.

## Validation in this source turn

- Combined `npm run build`: passed after matching optional-property semantics across the source packages.
- `npm run typecheck:assistant`: passed with the source's strict optional/indexed checks.
- Full moved Vitest run: 228/237 files passed, 2,642 assertions passed. Eight moved-path/example checks were corrected; focused reruns pass (22 assertions). Two polling assertions also fail in the untouched source repository at `41de2dd3c23517311d83734481825805b102e099`; investigate this existing behavior before final acceptance.
- Existing Agent SDK default suite: all 875 tests passed. Acceptance typecheck and reference host compile passed.
- Shared usage model wrapper: seven tests passed; two consolidation/dependency tests passed. The wrapper is implemented but has not yet replaced Mills' application wrapper.
- Moved Dart client analysis passed. Initial suite passed 294 tests but its 19 gateway cases failed with the old in-memory fixture. The fixture now uses this package's compiled gateway and real disposable SQL persistence; all 22 gateway tests pass, including three previously skipped SQL cases.
- Moved Flutter widgets analysis passed; all 277 widget tests passed. All 117 combined client/widget lifecycle tests passed.
- The imported Node `.mjs` Assistant packaging/adoption tests and associated CLI/templates still need adaptation to the consolidated package layout; they are not covered by the moved Vitest run. Do not interpret the current source as publication-ready.
- No consumer adoption or deployed acceptance established yet.

## Next continuation

Start by revalidating the active goal and worktree. The source changes in this turn are all in the Agent SDK repository; consumer source/dependencies have not been edited. No commits, pushes or deployments have been made.

1. Finish adapting imported Node package/adoption checks and setup tooling. In particular, `tests/assistant/package-contract.test.mjs` still assumes the former package root/export map, and `tests/assistant/adopt-cli.test.mjs` needs an Agent-owned CLI/template. The old standalone cancellation fixture manifests were removed so it uses root package self-resolution; its Dart projection uses the shared client package configuration. Other imported Node test paths need an audit before running that suite.
2. Investigate the two confirmed baseline `client-polling.test.ts` failures (idle visibility transition performs one already queued control read earlier than the test expects). Do not hide this with skipped tests or claim the full Vitest suite is green.
3. Qualify the new installed Git package after full source readiness, including the updated `tests/verify-git-install.mjs`; its candidate/public paths and optional React peers need final review. The helper now rejects any direct/nested legacy Assistant lock entry.
4. Adopt the shared usage wrapper in Mills while preserving its authorization, attachment preparation, compaction receipts and diagnostics. Check gateway composition for duplicate capture. Then migrate consumer import specifiers, manifests, tooling and mobile package names to a genuinely published Agent SHA, regenerating locks normally.
5. Provisioning and deployed acceptance are still outstanding. Existing private capabilities, tables and Handrail environment contracts must be preserved; production database approvals remain mandatory.

Local validation logs are in `/tmp/agent-assistant-tests.log`, `/tmp/agent-native-tests.log`, `/tmp/agent-flutter-client-tests.log`, `/tmp/agent-flutter-gateway-tests.log`, `/tmp/agent-flutter-widget-tests.log` and `/tmp/agent-flutter-shared-tests.log`. The initial full Dart log contains the old fixture failures; the gateway rerun records the corrected result. Source qualification is not public-install or deployment evidence.
