# Protected vault-bound HTTP requests

`createVaultRequestExecutor` is a server-only registration for `createVaultUse`.
It supports scoped API/refresh token use with Bearer authorization. It does not
support payment references, login passwords, arbitrary model-supplied URLs,
headers, request bodies or signing code. Native hosts adapt their existing
approved HTTP/provider clients to `VaultHttpClient`; the SDK adds no provider
client or controller. This follows published revision 1 of
`handrail-ai-sdk-implementation-contract` and the local vault/security contracts.

The registered recipe fixes the public HTTPS destination, method, resource,
nonsecret body, recipe revision and byte limits. The host `bind` callback must be
pure and bind **both** the complete operation and supplied recipe binding into
the canonical effect digest, using the existing account/environment idempotency
namespace. Recipe changes must conflict under an existing effect identity. Never
hash credential values or use model-supplied recipe registrations. Existing host
action approvals, retry budgets and domain gates still apply.

Register the result in `createVaultUse(host, custodyPort, [executor], timeoutMs)`.
Only the operation and lease fence are execution inputs. That service commits
unknown admission, rechecks the current scoped grant and resolves custody at
dispatch. Its locks serialize revoke/cancel with execution. The executor rechecks
`isCurrent()` after asynchronous preparation, immediately before send and before
verification release; expiry during DNS or connection setup cannot start late use.
The existing effect deadline covers custody, resolution, connection and body
consumption. Timeout aborts the client and retains unknown. An already transmitted
mutation cannot be undone by revocation; read-only reconciliation remains available.

## HTTP client boundary

The injected client resolves the hostname without credentials. All returned
addresses must pass the address policy before a connection starts. V1 deliberately
allows only canonical globally routable IPv4: private, loopback, link-local,
carrier NAT, metadata (including Azure's platform address), multicast, reserved,
documentation, mapped/tunnel and all IPv6 forms fail closed. This conservative
policy can deny otherwise public IPv6-only providers.

The client must pin the selected address without another DNS lookup, proxy,
reconnect or fallback. For HTTPS it must authenticate the certificate against the
original hostname. Before receiving authorization it exposes the actual endpoint,
socket address and port. The executor compares each against the registration and
selected address. A client unable to expose/enforce this boundary is unsupported;
post-response URL checking cannot qualify it. These are trusted adapter duties,
not guarantees the SDK can impose on arbitrary HTTP libraries.

`send` receives a bounded payload, generated Bearer header, the bound effect for
native idempotency handling, `redirects: 'deny'`, and `retries: 0`. The host client
must enforce request/wire/header limits (response headers capped at 4096 bytes),
bounded decompression and the abort signal, and close streams/connections on every
exit. It must not record private requests, raw responses, redirects, exceptions,
URLs or credentials in diagnostics. There are no automatic network retries. Any
3xx, failed status, malformed/oversized body, exception, timeout or inconclusive
verification remains unknown until the existing reconciler establishes facts.
`not_applied` must exclude late in-flight effects, not merely an absent lookup.

The SDK consumes at most the registered decoded response byte limit (maximum
1 MiB) and exposes those bytes only to the trusted recipe verifier. Only literal
`true` verifies an operation. Provider headers, body fields, URLs, errors and
payload-shaped verifier returns never enter the public output. The output is the
existing fixed effect outcome and original correlated `receiptRef`; no provider
account/capability strings are released. Provider-specific nonsecret capability
mapping and live connection readiness belong to the subsequent connection tasks.

## Disposable exception and evidence

A host may explicitly register `fixture: { kind: 'disposable_loopback', endpoint,
environmentRef }` for synthetic tests. The actual transport must be canonical
HTTP at `127.0.0.1` with a registered explicit port, and the job environment must
match. This is a server registration only: public operations and grants still
require the unchanged canonical HTTPS destination. Production host registration
must never enable this exception or use real credentials with it.

Focused tests use the existing real PostgreSQL 15 harness, checked-in migrations,
per-case schemas, two SQL connections, encrypted synthetic custody, and two
loopback HTTP servers. They exercise authorization delivery, redirect isolation,
revocation between admission/dispatch, expiry, byte/deadline bounds, durable replay,
conflicting recipes, reflected output withholding, and unknown reconciliation
following grant revocation. Policy-only tests use a narrow injected transport and
make no public connection. The loopback client is test-only, not a production TLS
adapter qualification or Meta readiness proof.

```sh
node tests/run-local-postgres.mjs test:vault-request test:vault-use
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json
node --test --test-concurrency=1 --test-reporter=tap tests/contracts/vault.test.mjs tests/packaging.test.mjs
```

See `docs/evidence/vault-request.json` for exact commands/counts, fixture receipts,
source hashes and the uncommitted candidate tree SHA. Existing prerequisite
changes remain in the lane; no production changes or live provider actions occur.
