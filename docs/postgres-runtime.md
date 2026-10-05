# Supported Node/PostgreSQL Agent composition

This repairs the shared persistence prerequisite for Mills. It is not the Mills
engine cutover or web/Flutter acceptance. Node 22.23.1, TypeScript 5.9.3,
`@types/node` 22.20.4 (also 22.18.0/Bundler), `pg` 8.23.0 and `@types/pg`
8.23.1 are the qualified consumer setup. Declare dependencies you import directly,
including `@openai/agents` 0.18.0, `openai` 7.25.0 and `zod` 4.3.6 when used.
Install this SDK from `git+https://git@github.com/c0x65o/handrail-agent-sdk.git#`
followed by the full **pipeline-delivered 40-character SHA**. The `git@` is a public
username, not a credential; it prevents npm from rewriting the HTTPS lock to SSH.
Keep the manifest, root/resolved/installed locks in agreement. Normal Git install
runs `prepare`; no tarball, registry or separate publication route is required.

[postgres-application.mts](../examples/postgres-application.mts) is a complete,
strictly compilable composition. `handrail-agent-sdk/server/postgres` exposes
`createPostgresAgentStores({client: pool, schema, keys})` returning admission,
journal, lease, effects, cancellation, answer and encrypted state stores. The
seven individual `createJobAdmissionStore`, `createJobJournal`,
`createJobLeaseStore`, `createEffectStore`, `createJobCancellationStore`,
`createJobAnswerStore`, `createAgentStateStore` factories are available too; they
accept the host Pool and explicit schema (state additionally takes keys).
Drizzle implementation types do not enter the public consumer declaration graph.
Internal compilation skips upstream Drizzle declaration errors; consumer checks
use **skipLibCheck:false** and exercise the entire example.

Constructing these factories opens no connection, runs no DDL and starts no loop.
Host owns the Pool, timeouts, connection credentials, lifecycle and operational
limits. The existing implementations were moved into package source; reference
callers re-export them. There is one engine and one set of transaction algorithms.
`createPostgresAssistanceDatabase(pool)` bridges the same Pool to the existing
assistance SQL API; those existing APIs and table layouts remain compatible.

## Schema and migration contract

Choose an explicit application-owned PostgreSQL schema. ASCII SQL identifiers (letters, digits, underscore; not starting with a digit)
up to 63 characters are accepted and retain their exact case; `public`, `pg_*` and `information_schema` are
rejected. Every runtime table is schema-qualified; search_path is not authority.
The legacy default `agent_reference` remains only on internal reference factories.
Use the same explicit schema when adopting an existing reference database.

Run `migrateAgentPostgres(pool, schema)` from the host's approved migration phase
**before** starting workers. It takes a transaction-level schema advisory lock,
creates the schema/ledger if absent and applies the unchanged additive runtime
migrations 0000, 0001, 0002, 0006, 0007, 0008, 0013 and 0014. SQL ships in the ordinary
built package. The entire call commits or rolls back on one checked-out connection;
concurrent calls serialize. The original per-schema `journal_migrations` ledger
(hash/created_at) is recognized, including partial reference installs. Existing
entries must have the exact namespace-relocated SQL hash, or bootstrap fails.
Unknown pre-existing tables without this ledger are never silently adopted.

`await agentPostgresMigrations(schema)` exposes ordered `{id, createdAt, hash,
statements}` for an existing host migration runner. The host records/applies them
transactionally and owns its deployment order. Choose that runner OR SDK bootstrap;
do not independently replay both ledgers. If the old host customized the ledger
location or SQL, audit/adopt it in the host migration rather than resetting rows.
The full reference-only migration chain also includes Vault/browser/connection
schema; runtime bootstrap deliberately does not install those separate services.
Do not run the old high-watermark reference migrator against a runtime-only schema:
it would assume skipped reference migrations had run.

No table, event, effect reference, provider idempotency key, answer delivery,
cancellation epoch or encrypted envelope is rewritten by this packaging move.
An existing reference deployment must preserve those rows and ledger; bootstrap
is repeatable and does not re-admit jobs. Uncertain effects retain their original
identity and reconcile before a dispatch can occur. On rollback stop workers and
keep all tables, keys and receipts. A compatible forward repair is safer than
rolling a writer back across newer durable records. There is no destructive down
migration. Assistance tables still use the additive `assistancePostgresSchema` API.

Job IDs are globally unique within the selected SQL schema. Admission idempotency
is scoped by tenant + user + namespaceRef + requestKey and binds the complete
identity and operation digest. Different scopes may share a request key, but not
adopt each other's job. Stores fence full identity, grant, cancellation epoch,
lease generation and revisions; row locks/transactions protect state + journal,
effect, answer and cancellation commits. This is application authorization, not
PostgreSQL RLS: possession of the Pool is trusted server access. Hosts must derive
all identity/namespace/ACL facts from current authenticated context and keep
`withAuthority`/`withToolAuthority` valid through the awaited operation. Never
accept browser-supplied authority or treat a visible catalog as execution permission.

Conversation records are added by migration 0014. The optional
`checkpointQuotaBytes` store setting enables authenticated paged checkpoints;
without it the original 64 KiB whole-record bound remains. See the
[continuous conversation guide](continuous-conversation.md) for sizing,
canonical storage, memory and rollback constraints.

## Encrypted state and host-controlled keys

`AgentStateKeys.current()` returns `{ref, key}`; `resolve(ref)` returns a Node
`KeyObject`. The key is a host-provided 32-byte AES secret key, obtained privately
from the host's approved custody mechanism. The SDK generates an AES-GCM nonce,
**never a production key**. There is no environment lookup, generated fallback,
plaintext fallback, exported key material or example production secret.
Key references must be stable nonsecret identifiers. KMS installations that do
not expose local symmetric KeyObjects may implement the existing `AgentStateStore`
port; a remote KMS encrypt/decrypt adapter is not claimed by this implementation.

Only key reference, nonce, ciphertext and authentication tag enter the state row.
AAD binds full original identity, version, grant revision and key reference.
Changing any of them, wrong/missing keys or corruption fails closed. Public job
history has references, never RunState/prompt/output plaintext. Host must protect
private decrypted checkpoint access and backups. On rotation `current()` chooses
the new reference while `resolve()` retains old decrypt handles until records and
backups no longer need them; grants must not be silently changed to bypass a failed
load. Copying state into a different tenant/identity does not make it decryptable.

## Mapping the inspected Mills seams

The inspected Mills web source was at `0753ac7b3eafe331cd35d5a48379ae8997f73a19`.
These are concrete seams, not permission to edit or deploy Mills in this repair.

| Existing Mills component | Agent integration / responsibility |
| --- | --- |
| `database/postgres-runtime.ts`, `BetaSeedDatabase`, `handrail-ai-persistence.ts` | Mills currently uses postgres.js and a callback transaction wrapper, not `pg.Pool`. Supply a host-owned `pg.Pool` using the same approved database/SSL settings and bounded connection budget for these SDK stores; keep its lifecycle in the existing server. Do not cast BetaSeedDatabase into a Pool or translate Drizzle queries in Mills. This is a thin connection setup, not a second database/service or per-app store engine. Existing domain/history operations continue through their current adapter. |
| `handrail-native-provider.ts` `createTransport` and current session checks | Return `createAgentConversationTransport` through the existing gateway/durable turn writer. Host persists turn-to-original-job/input binding and uses `createJobAdmission`; gateway/history tables remain canonical. |
| `handrail-turn-context.ts`, `createMillsNativeTurnReader` / `millsRequestFromSavedTurn` | Convert saved, role-preserving messages to `AgentInputItem[]` in `host.input`; use opaque attachment references. Bind immutable turn revision and input digest, reject stale corrections rather than silently retargeting a job. |
| `handrail-native-tools.ts`, tool registry and domain execution ledger | `createApplicationAgentTools` converts the current catalog. Filter through `visibleTools`; reads call existing domain handlers. Mutations bind immutable intents to the shared effect ledger, with existing domain validation/idempotency still authoritative. `observeApplicationAgentTool` feeds the existing presentation observer. |
| Native proposal review/decision endpoints | `host.decide` returns a requirement bound to the original call. Issue a challenge via `answer.issue`; complete the current, authenticated native decision via `answer.complete`. `host.resolveWait` checks saved snapshot.answer plus current domain approval, and `runtime.resume` queues the same job. Reconnect/wake alone cannot approve. |
| `handrail-attachment-source.ts`, native provider `loadSource` / attachment resolver | `prepareModelInput` reauthorizes opaque references against the current session, household, message and turn, validates readiness/type/size, resolves transient provider input immediately before each request. Keep the existing checks after object reads; never store signed URLs/bytes as durable input. |
| Canonical transcript / citations / renderers | `createAgentCheckpointReader` emits stable native protocol output, usage and terminal frames for the existing writer. Tool presentations and citations use existing host observers/normalization. It does not create a second transcript or claim per-token text streaming. |
| Existing provider receipts / metering outbox | Inject the approved Model/client wrapper. Meter each provider response at that wrapper with its existing stable invocation identity/outbox. Runtime checkpoint usage and reader output provide normalized totals; `observe` is best-effort metadata, **not** a durable billing receipt or exactly-once per-invocation ledger. |
| `assistance-store.ts`, `assistance-runtime.ts`, app notification ledger | Existing assistance APIs remain. Admit a dedicated notification job per fact/channel/destination and use `createNotificationDelivery` with the same lease/effect stores. Bind existing uncertain sends/receipts to their original identities before switching writers; do not resend/import as a new effect. |

No further generic Agent admission/journal/lease/effect/answer/state store needs to
be copied into Mills. Domain authorization, immutable input/turn mapping,
canonical history, approvals, provider metering and destination reconciliation
remain real host integration work, demonstrated as ports in the example. Host
controls startup/recovery scans in its existing application/worker role. Nothing
in this change creates services, removes legacy writers or modifies deployment.

## Provider and sampling

`createAgentRuntime` requires an injected approved Agents `Model`. An existing
`OpenAIProvider({openAIClient: approvedClient, useResponses:true})` can supply it;
no second client, automatic key lookup, account or model switch is required.
The legacy protocol's mandatory `generation.temperature` is **not read** by the
Agent runtime. Sampling is omitted by default; a host may explicitly set
`sampling: {temperature, topP}` only for a model that accepts it. Values must be
finite. A typed seam does not discover provider capabilities: the host-approved
model wrapper still owns provider-specific adaptation. Fixed no-store, retry and
serial-tool settings remain enforced. These choices align with the official
[Models and providers guide](https://developers.openai.com/api/docs/guides/agents/models).

The installed suite uses the actual OpenAI client/Responses adapter and Runner
with simulated HTTP SSE. One boundary returns HTTP 400 if temperature is sent;
default execution succeeds without it. Another asserts explicit temperature/top_p.
This qualifies parameter forwarding, not live `gpt-6-astra` connectivity or Mills'
old streaming provider. No live credentials or API spend were used.

## Reproduction and delivery boundary

Run checks sequentially: `npm test`,
`node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json`, then
`node tests/run-local-postgres.mjs`. PostgreSQL 15 binaries are required. All
clusters are disposable, local, isolated and cleaned up by the runner.

After pipeline publication, run `node tests/verify-git-install.mjs FULL_SHA`.
It performs normal public HTTPS installs and fresh-cache lock reinstalls, strict
consumer compilation, then starts the external fixture directly. The fixture uses
only declared external dependencies and package exports, including packaged DDL.
Node filesystem permissions deny repository reads; synchronous ESM/CommonJS load
hooks reject reference/source modules and path escapes, including child recovery
processes. The repository test launcher supplies only disposable connection
settings; no repository functions or SQL are injected into the fixture.

For an uncommitted candidate, `--candidate-source` first installs/reinstalls its
declared dependencies through normal package resolution, compiles Agent source
via normal `prepare` inside the isolated consumer's package directory, then
removes source/scripts before testing. Assistant remains an unmodified public
Git installation. Installing the old Agent base here would retain its old nested
Assistant pin when qualifying a dependency update. This
is explicitly **candidate source qualification**, not a public Git revision or
consumer dependency upgrade. The lock makes no Agent installation claim; the
supplied SHA identifies the source baseline and the evidence records the overlay.
Only the pipeline may produce the deliverable SHA, and the
unmodified fresh public-install check remains mandatory afterward.
