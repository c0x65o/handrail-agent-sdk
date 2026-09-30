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

After the pipeline pushes the revision, verify the actual installed runtime:

```sh
node tests/verify-git-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

No application has been migrated, no pilot has been selected, and no live model,
generic browser controller, or native Handrail adapter is qualified by these tests.
