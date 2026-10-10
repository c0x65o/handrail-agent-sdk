# Handrail Agent SDK

Headless, durable agent execution powered by **OpenAI Agents SDK 0.18.0**.
Requires Node.js 22 or later. The host owns identity, authorization, provider
connections, database lifecycle and private Vault/browser executors. The shared
assistance module owns schedule/watch lifecycle and notification orchestration.

- `handrail-agent-sdk`: pure job, connection, Vault and browser contracts.
- `handrail-agent-sdk/server`: admission, leases, Stop, answers, effects and Vault boundaries.
- Browser runtime tools and private login entry/fill adapters are described in
  [browser and Vault integration](docs/browser-vault-integration.md).
- `handrail-agent-sdk/server/postgres`: supported durable stores, additive migrations and host key handles.
- `handrail-agent-sdk/server/conversation`: continuous transcript/context, scoped memory and durable native work return.
- `handrail-agent-sdk/server/agents`: `createAgentRuntime` and its typed host/store/tool ports.
- `handrail-agent-sdk/server/application`: existing assistant gateway transport and checkpoint projection.
- `handrail-agent-sdk/server/application-tools`: trusted application tool catalog/presentation adapters.
- `handrail-agent-sdk/server/assistance`: durable schedules, observed conditions and deduplicated inbox facts.
- `handrail-agent-sdk/server/assistance/postgres`: reusable host-owned SQL storage adapter.
- `handrail-agent-sdk/server/assistance/notifications`: delivery through the existing effect ledger.
- `handrail-agent-sdk/server/handrail-feedback`: canonical reporter/MCP v2 submission and verified-readiness observation.

The runtime uses OpenAI Agent, Runner, tools, streaming and serialized RunState.
It checkpoints tool calls before execution, reauthorizes each call, and uses the
existing effect ledger for mutation reconciliation. RunState and terminal text
stay in private storage; public events contain references only. Importing a
package entrypoint starts no worker or provider request.

```sh
npm ci --include=dev         # ordinary prepare builds the package
npm test
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node tests/run-local-postgres.mjs
```

Start with the [typed headless example](examples/headless.mts) and
[integration/migration guide](docs/agent-runtime.md). Read the
[readiness evidence](docs/evidence/agents-runtime/README.md) before choosing a pilot.
The [assistance composition and Mills migration map](docs/assistance.md) describes
the shared adapters, live-provider inputs and remaining canonical feedback
interaction gap. Source fixtures do not establish application acceptance.
The [PostgreSQL composition guide](docs/postgres-runtime.md) and
[complete installed application example](examples/postgres-application.mts)
compose runtime, gateway, native answers and notifications using public factories.
The reference host reuses these implementations. Nothing starts automatically.
The [continuous conversation guide](docs/continuous-conversation.md) and
[headless host](examples/continuous-conversation.mts) add bounded history, scoped
memory and native work handoffs before application cutover.
The optional [Marketing onboarding foundation](docs/marketing-onboarding.md) and
[host injection example](examples/marketing-onboarding.mts) compose native Vault,
connection and user-consent ports. Meta execution is synthetic-only; live provider
operations and browser fallback remain disabled pending independent qualification.
The example implements Marketing's concrete optional `AgentPort`; its
[isolated consumer check](docs/marketing-onboarding.md#verification-and-documentation-provenance)
installs the pinned Marketing dependency separately from the base SDK checks.

Consumers install from the public HTTPS Git repository
`https://github.com/c0x65o/handrail-agent-sdk.git`, pinned to the **full 40-character
SHA produced by the delivery pipeline**, with a matching package-manager lockfile.
`private: true` disables registry publishing; it does not prevent Git installation.
`prepare` builds during normal installation. The root is the installable package;
the former copied `consumer-distribution` candidate has been retired.

TypeScript consumers must explicitly pin supported Node declarations; the SDK's
development dependencies do not constrain consumer types. The qualified setup is
Node **22.23.1**, TypeScript **5.9.3**, and `@types/node` **22.20.4** (also tested:
**22.18.0** with Bundler resolution). An unpinned clean install currently pulls
Node 26 types and fails in upstream Agents declarations. Other Node runtime
majors are unqualified; `engines.node >=22` is a minimum, not a tested-version matrix.
See the [consumer installation contract](docs/agent-runtime.md#consumer-type-and-lock-contract)
for the npm HTTPS URL form and reinstall commands.

After the pipeline pushes the revision, verify the actual installed runtime:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

This checks two strict consumer type setups, fresh-cache HTTPS lock reinstall,
and an external installed-only runtime suite with disposable PostgreSQL, actual
Agents Runner and mocked model/provider boundaries. No repository helper, SQL or
reference build is available to that suite. It requires the local PostgreSQL 15 test binaries. The
[consumer correction evidence](docs/evidence/consumer-compatibility/README.md)
separates published-SHA verification from the pending delivery revision.
The [0.2.10 compatibility qualification](docs/evidence/consumer-compatibility-0.2.10/README.md)
records the current verified Agent/Assistant SHA pair, fresh consumer locks and
the stale mixed-version failure. Archived evidence manifests are historical
snapshots; generate current consumers with the verifier above.

Mills is the first intended consumer; its application cutover is separate work.
No live model, generic browser controller, or native Handrail deployment is
qualified by these source tests.
