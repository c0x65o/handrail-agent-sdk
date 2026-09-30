# Handrail Agent SDK

Headless, durable agent execution powered by **OpenAI Agents SDK 0.18.0**.
Requires Node.js 22 or later. The host owns identity, authorization, provider
connections, storage, scheduling and private Vault/browser executors.

- `handrail-agent-sdk`: pure job, connection, Vault and browser contracts.
- `handrail-agent-sdk/server`: admission, leases, Stop, answers, effects and Vault boundaries.
- `handrail-agent-sdk/server/agents`: `createAgentRuntime` and its typed host/store/tool ports.

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
The PostgreSQL reference is a host implementation with disposable tests, not an
automatically started service or a replacement for Handrail's native controller.

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
and the installed multi-step runtime with disposable PostgreSQL and mocked model
HTTP transport. It requires the local PostgreSQL 15 test binaries. The
[consumer correction evidence](docs/evidence/consumer-compatibility/README.md)
separates published-SHA verification from the pending delivery revision.

No application has been migrated, no pilot has been selected, and no live model,
generic browser controller, or native Handrail adapter is qualified by these tests.
