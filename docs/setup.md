# Agent SDK application setup

Use the existing application's declared Handrail resources. Installing the SDK
must not create a database, acquire credentials, start background workers, or
make provider calls. The server host supplies those dependencies explicitly.

## Packages and installation

JavaScript and optional React UI use the same `handrail-agent-sdk` Git package.
Pin the public HTTPS Git repository to a full published commit SHA and commit
the package-manager lockfile. Normal Git install runs `prepare` to compile the
SDK; no registry publication or separate packaging step is needed. React peers
are optional for server-only applications.

Flutter uses native Dart packages from that repository, with the same frozen
revision and Git paths `packages/handrail_agent_client` and
`packages/handrail_agent_widgets`. Keep the resulting `pubspec.lock`. See
[the migration guide](assistant-consolidation.md) for old-to-new package names.

The `handrail-agent-sdk` CLI provides `scaffold`, `migrate-package` and `check` commands.
Migration parses JavaScript/TypeScript module specifiers, including dynamic imports, CommonJS requires and declaration files. Package catalog values, comments and quoted examples remain unchanged. A source syntax error aborts before any manifest or source write; dry-run reports the exact files that would change.
Run `--help` for exact arguments. Migration requires an explicit full
`--sdk-revision`: a revision from the former Assistant repository cannot be
reused in this repository. Migration is a dry run unless `--write` is supplied.
Regenerate locks with the application's normal package manager after migration;
`check` checks that no old Assistant identity remains in the dependency graph.

## Existing PostgreSQL and durable storage

```ts
import { createPostgresAgentApplication } from 'handrail-agent-sdk/server/setup';

const storage = createPostgresAgentApplication({
  pool: applicationPool, // host-owned pg Pool for the declared database
  agentSchema: 'application_agent', // preserve the existing namespace on upgrade
  keys: applicationStateKeys, // host-owned encryption/KMS handles
  assistance: false, // enable only for adopted schedules/watches/notifications
});
// Invoke ONLY from the application's authorized migration lifecycle.
await storage.migrate();
// storage.agent: checkpoints, jobs, leases and journal adapters
// storage.assistant: gateway persistence, history, approvals, attachments, outbox
```

Construction is inert. Migration calls on one composition coalesce. Agent
migrations are serialized and transactional within their existing namespace;
all component migrations are repeatable. The combined bootstrap is not one
cross-component transaction: retry after a partial failure. Across replicas,
use the application's single migration runner for the gateway schema.

Gateway persistence retains the existing `handrail_ai_*` tables and uses the
pool's existing search path. Do not change that path or rename/copy those tables
when changing imports. Agent tables remain in the explicitly supplied namespace.
Stored conversation, approval, attachment and usage receipt formats are
unchanged. Existing encrypted checkpoints still require the original decrypt
keys. The SDK does not create or rotate production keys.

For applications already composing their stores, keep that composition and
existing migration runner; adopting this convenience helper is optional.
Production database writes require the platform's designated human approval
flow. Running a migration task is not a substitute for that approval.

## Capabilities, workers and telemetry

Use native Handrail capability/resource APIs to inspect declared resources and
materialize missing bindings within authorized project scope. The SDK cannot
provision cloud infrastructure using application credentials. Follow the
attached runtime contracts for `ai_openai`, `ai_runtime` and any declared storage;
do not infer a provider or add an undeclared service.

The existing Handrail runtime contract supplies `HANDRAIL_AI_RUNTIME_*`
telemetry endpoint, token and trusted org/project/service/environment binding.
Resolve user/session attribution on the authenticated server. Keep provider and
telemetry credentials out of Flutter/browser configuration. See
[usage delivery](usage.md) for per-invocation capture and settlement ownership.

Compose the application gateway with `storage.assistant`. Its existing usage
retry lifecycle drains saved outbox records on startup and retries delivery.
Close the gateway on host shutdown. A standalone agent can explicitly own
`createAIRuntimeUsageDelivery` instead; do not start two independent delivery
lifecycles for the same host. Agent workers, cancellation and recovery use the
existing `server` / `server/application` entrypoints and durable stores. See
`examples/postgres-application.mts` and `examples/continuous-conversation.mts`.

Mills, Hitcents and Spartan already declare PostgreSQL and the two AI
capabilities. Consolidation can reuse them. UI source tests and disposable
PostgreSQL tests establish local compatibility; only installed consumer tests
and authorized live acceptance establish adoption and runtime delivery.

## SDK source checks

From this repository, `make setup-flutter` installs the locked Node test gateway
and the Dart/Flutter development dependencies. `make check-flutter` builds that
gateway and runs analysis and tests sequentially. These Node dependencies serve
the repository's cross-language fixtures; a Flutter application installing the
Git packages still uses the ordinary native Dart/Flutter pipeline.
