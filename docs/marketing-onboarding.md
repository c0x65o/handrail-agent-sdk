# Optional Marketing onboarding foundation

This integration is opt-in and server-injected. It adds no Marketing dependency,
HTTP client, browser controller, database, queue, background worker or login at
import time. Marketing remains usable through its manual connection flow without
this extension. The [example](../examples/marketing-onboarding.mts) uses supported
consumer exports only. No factory under `reference/node` is a consumer API.

The Meta executor is **synthetic-only**. Its constructor rejects provider evidence
mode. The [Meta v1 recipe](providers/meta-v1.md), all eight operations and browser
fallback remain **disabled/unqualified for live use**. Synthetic tests qualify the
adapter contract, not an installed host, reusable browser session or live account.

## Consumer exports and capability bridge

| Import | Purpose |
| --- | --- |
| `handrail-agent-sdk/marketing` | Dependency-free types: `MarketingConnectionBinding`, `MarketingOnboardingPort<Setup, Grant>`, `MarketingOnboardingResult` |
| `handrail-agent-sdk/server/marketing` | `createMarketingOnboarding`, `createMetaOAuthCallback`, `createMetaVaultExecutor`, and native-host/private-client port types |
| `handrail-agent-sdk/server` | Existing `createVaultEntry`, `createVaultUse`, `ConnectionStore`, storage, grant, effect and lease ports |
| `handrail-agent-sdk/server/agents` | Existing `AgentRuntimeTool` with `kind: 'vault'`; only a receipt reaches the model |

No root or browser contract import acquires a server dependency. The optional
server export resolves only under Node conditions and explicitly rejects the
`browser` condition. Direct file copying is not a sandbox; hosts must keep server
ports and credentials out of browser build graphs. The package's ordinary
build/prepare pipeline compiles the optional entrypoints. Hosts install from the
public HTTPS Git repository pinned to a full committed SHA with the matching
lockfile, once this workspace change has been reviewed and committed by its owner.
There is no new registry/tarball dependency or separate release build step.

The exact SDK adapter contract is
`MarketingOnboardingPort<Setup, Grant>.inspect(setup, grant): Promise<MarketingOnboardingResult>`.
`createMarketingOnboarding<Setup, Grant>` returns `inspect`, `reconnect`,
`requestAccess`, `cancel`, and `revoke` with that same argument/result signature.
The example's `marketingAgentPort(host: MarketingOnboardingHost<Setup, Grant>,
connections: ConnectionStore, entry: Pick<ReturnType<typeof createVaultEntry<MetaPrivateValue>>, 'issue'>)`
returns an actual Marketing `AgentPort` and the existing `onboarding` methods.
`marketingExtension(native: NativeMarketingPorts)` composes that wrapper with
`tool: AgentRuntimeTool` and `privateOAuthCallback`. These are example exports,
not additional package entrypoints. `Setup` and `Grant` are imported from
`@handrail/marketing/core`; `AgentPort` is from `@handrail/marketing/server`.
Its result is `Awaited<ReturnType<AgentPort['inspect']>>`, because Marketing does
not export a named inspect-result type. No compatibility cast is used.

The server entrypoint's exact exported port types are `MarketingOnboardingHost`,
`MetaOAuthSession`, `MetaOAuthCallbackHost`, `MetaRecipe`, `MetaExecutorBinding`,
`MetaPrivateValue`, `MetaPrivateInspection`, `MetaReadVerification`,
`MetaPrivateGuard`, `MetaPrivateClient`, `MetaPrivateCustody`, and `MetaExecutorHost`.
It also re-exports the three `/marketing` contract types. Its only runtime exports
are `createMarketingOnboarding`, `createMetaOAuthCallback`, and `createMetaVaultExecutor`.

The published Agent 0.2.14 (`c17257f0b9ed10f84f32dc7f2107d40e3c51aa13`)
and Marketing 0.1.5 (`b5e725a1d2cff4864c98acb98f9e6e8e8e370f51`) pair passed
independent exact-Git installed-consumer qualification in work request
`7937a264-35f9-400e-8871-ee2937df1235`, including a temporary concrete wrapper
inside `MarketingServer`. This example persists that public type seam; the
[new source handoff](evidence/marketing-typed-bridge.json) distinguishes its
packed-candidate checks from that immutable published-pair proof. Neither proves
an installed native host or live provider readiness.

The wrapper preserves fixed blocked reasons and supplies a null handoff; waiting
maps to `provider_consent_required` with only the authenticated opaque host route.
Ready maps to null reason/handoff after checking the two read capabilities:
`meta.account.read` corresponds to Marketing's `setup` verification and
`meta.report.read` to `report`. Marketing's `AgentPort` carries **no capability
field**. The wrapper does not mutate Setup/Grant or install permissions.
`MarketingServer` independently verifies provider/account capabilities after
ready. Neither read capability grants campaign-write, spend or billing authority.

Marketing remains an optional consumer dependency, pinned to the full HTTPS Git
SHA above with the consumer's lockfile. The SDK's own dependency graph does not
include it. Copy the example into server-owned code only; its Marketing imports
are type-only, but its Agent imports are server runtime code. The regular SDK
consumer typecheck covers dependency-free exports; the optional check below
compiles the concrete example against both installed packages.

The full composition, including `AgentRuntimeTool`, is qualified with TypeScript
**5.9.3** and `@types/node` **22.20.4**, using Node **22.23.1** (the pinned
Marketing package requires `>=22.23.1 <23`). TypeScript **7.0.2** with
`@types/node` **25.9.0** failed with three upstream `@openai/agents` **TS2416**
declaration errors. That combination is not qualified for this example. The
earlier temporary pair proof had narrower TS7 coverage and did not compile the
full `AgentRuntimeTool` composition. Neither `skipLibCheck`, declaration casts,
library edits nor dependency upgrades are used to suppress this limit.

`inspect` and `reconnect` only read native state; they never create credentials,
renew consent or dispatch provider work. Ready requires authenticated, current
provider evidence for **both** `meta.account.read` and `meta.report.read`, matching
credential/grant revisions and expiry. Fixture evidence returns `synthetic_only`.
The bridge can read future independently qualified provider receipts, but this
release's executor cannot produce them. Receipt authenticity remains native-host
authority; shape validation is not authentication.

## Required host ports and private flow

1. Resolve setup/grant hints against the authenticated user's original admission.
   Bind tenant, user, project, host account, environment, purpose, original job,
   native/route references, instruction revision, action/operation/effect, exact
   Meta app/app-scoped user/ad account, redirect and destination. The only Marketing
   permission is `ads_read`; the two read capabilities are a fixed ceiling. IDs,
   arbitrary strings and provider page text never authorize access.
2. Pre-admit the connection in the existing native `ConnectionStore`. Supply
   existing durable Vault entry/use and connection ports backed by the host's
   encrypted storage/key services. Public ports are the supported minimal seam;
   this patch does not promote reference SQL factories or copy their crypto.
3. `requestAccess` requires `approvePersistentAccess` for creation **or expansion**
   of persistent access. It must record a real authenticated human decision bound
   to the exact recipe, not return true for model/tool approval. Then issue the
   original job's `createVaultEntry` challenge. Approval does not turn password
   login into API consent and cannot authorize broader scopes.
4. `handoff` persists the entry/recipe binding in the host's existing private
   consent-session service. Generate separate cryptographically random OAuth
   state (at least 128 bits), entry handle and opaque UI route reference. The UI
   receives only `https://HOST/marketing/connect/OPAQUE_REF`; it is not a bearer
   capability. Independently authenticate access to that route and the callback,
   check CSRF/session binding, one-time state, deadlines and current grants. Keep
   state/code/provider redirect URLs out of agent/Marketing output and logs.
   The user's private surface alone navigates the OAuth dialog, asking for
   `response_type=code&scope=ads_read`, using the registered exact HTTPS redirect.
   The user handles login, consent, MFA and provider checkpoints. Dismissing the
   surface leaves the original job waiting; cancellation is explicit.
5. Invoke `createMetaOAuthCallback` only from that private authenticated route.
   Supply the actual router callback base separately from decoded query values;
   reject duplicate query keys at the HTTP parser. It validates state, exact
   redirect, user, scope, original job/challenge and lifetime before private Vault
   capture/delivery. Provider denial withdraws entry. Vault stores compare
   duplicate private captures; identical callbacks reuse the original answer,
   different codes conflict. Never accept a callback through a model tool.
6. Resume the original job using the normal answer/lease machinery. Resolve each
   runtime call's exact effect in native authority, then compose a registered
   executor with `createVaultUse`. The example supports per-call immutable
   registrations without a process-local authority map. Codes use the existing
   private token-shaped Vault value; no code/token enters tool arguments. Keep
   captured codes short-lived and remove them through existing Vault lifecycle.

The private Meta client exposes named operations, not arbitrary fetch. Implement
them over the host's approved provider client: fixed `graph.facebook.com/v25.0`
paths for code exchange, `debug_token`, `me/permissions`, account identity and
Insights. App credentials stay in that client. Reject redirects and retries,
bound decoded responses/decompression to 64 KiB and headers to 8 KiB, and suppress
secret-bearing URLs and provider error bodies in HTTP/access/APM logs. Recheck the
guard immediately before every send, including after DNS/client preparation.
`MarketingOnboardingHost.isCurrent(recipe, operation)` and
`MetaOAuthCallbackHost.isCurrent(session)` are mandatory, literal-true checks
before work and after every productive await. They cover current actor, scope,
approval, original effect, revisions and session validity under the native fence.
Callbacks snapshot query/session/entry facts before asynchronous work; host ports
cannot mutate the checked destination or original entry through shared objects.
The host must authenticate the entry-handle-to-request and approved future-use
destination mapping **before capture**, not rely on the post-capture comparison.

`MetaExecutorHost.isCurrent(binding, 'dispatch')` must check this worker's native lease as well as
current user/grant/cancellation authority; Vault use validation alone is not a
substitute for a lease check after private asynchronous I/O. For `reconcile`,
check current authenticated factual-read authority for the exact original effect
before and after the read. That separate phase may operate after Stop/expiry; it
never permits another dispatch, renews a grant, or changes connection readiness.
The generic bearer-only `createVaultRequestExecutor` is unchanged.

Private inspection validates USER type, app/user identity, current validity,
`ads_read` in scopes and still granted, token/data-access expiries, exact account
identity and all report account IDs. Normalize provider seconds to milliseconds;
only a documented no-expiry value may normalize to null. Missing/ambiguous values
fail closed. A finite host approval expiry always applies. Read verification is
the exact bounded account and yesterday's synchronous Insights query documented
in the recipe, with limit 1 and no pagination. Empty reports are allowed after a
successful account check. Raw inspection/account/report responses never escape.
Known failed token/scope/account/expiry validation calls native custody
`invalidate` to fence cached readiness, preserving the original effect. It cannot
silently leave an older ready receipt usable after observing revocation.

`MetaPrivateCustody.retain` uses existing Vault/connection services to atomically
store the result and expiry under the entire approved binding, source effect,
current credential/grant revisions and native lease/cancellation fences. It must
authenticate evidence provenance; only fixture evidence is legal for this
executor. All host critical sections must hold authority through callback and
commit; checking permission once before asynchronous work is insufficient.

## Host requirement audit and limits of proof

These are required trusted server implementations, not optional callbacks or
caller-created approvals. SDK checks validate their returned facts and fence
signals; they cannot prove that a host boolean represents real authentication,
that a client obeys its transport contract, or that a ledger survives a crash.
No installed host implementation of these Marketing ports is shipped here.

| Required binding | SDK validation / repository proof | Independent host proof still required |
| --- | --- | --- |
| `onboarding.withAuthority`, `isCurrent`, `now` | Exact recipe/scope/effect/destination, finite deadlines; checks before/after load, approval, issue and handoff; authority-loss regressions | Authenticate user independently of setup/grant; resolve all six scope dimensions and original admission; serialize ACL, grant and cancellation revisions through callback and commit; reject replacement jobs for unresolved exchanges |
| `approvePersistentAccess` | Only literal `true` accepted; denied caller hints issue nothing | Persist explicit human approval for creation/expansion bound to full recipe; expose `requestAccess` only on an authenticated human route, never as an agent tool |
| `entryRequest`, `entryHost`, `entryStore` | Same original identity/effect/actor, API-token metadata, origin and bounded entry lifetime; real encrypted entry/grant/answer tests | Bind entry to the exact future Vault grant, item, destination and approval; key custody/rotation, secure ingress, native ACL and transaction fencing |
| `handoff`, `handoffOrigin`, `callbackHost` | Canonical HTTPS opaque route, exact state/redirect/actor/request, immutable snapshots, expiry and current checks; duplicate/conflicting encrypted-capture tests | Random independent state (128+ bits), authenticated nonbearer route, CSRF, duplicate-query rejection, durable one-time state and handle/request/destination binding; serialized duplicate callbacks; private login/consent/MFA; invalidate handoffs on fence |
| `connections`, `fence` | Current result validation, finite credential/grant revisions/expiry, provider-only readiness, local revoke CAS and unknown preservation | Authenticate provider receipt and app/user/account mapping; atomically fence native grants/cancellation first, then return current CAS revision; readiness invalidation cannot depend on cleanup succeeding |
| `resolveCall`, `resolveOperation`, `useHost`, `usePort` | Example accepts empty tool arguments; immutable matching operation, grant/item and destination; PostgreSQL grant, lease and effect tests | Resolve original tool effect and approved recipe without trusting arguments; encrypted custody, current ACL and lease fencing through commit |
| `executorHost.bind`, `isCurrent`, `now` | Full identity/effect/idempotency checks, immutable registration, literal current checks before/after I/O and reconciliation | Digest the entire nonsecret binding; current worker lease, approval and scope; separately authorize factual reconciliation after Stop |
| `privateClient` | Synthetic flag only; fixed action/destination and API-token class; validates USER/app/user/scope/deadlines/account/report facts; emits only enums | Fixed approved endpoints, field/query allowlist, no retry/redirect/pagination, byte/decompression/header limits, send-time guard, app-secret custody, expiry normalization, logging/APM suppression; transport is not implemented or qualified here |
| `custody.claimDispatch`, `retain`, `invalidate`, `reconcile` | Literal claim/retain booleans, bounded expiry, guard propagation, known-failure invalidation and enum-only reconciliation; synthetic concurrency/unknown/late-result tests | Durable independent claim CAS surviving outer rollback/process death; guarded atomic token/evidence publication; fail-closed invalidation; authenticated exact-effect reconciliation. SQL tests prove SDK stores, not this injected ledger |

Missing implementations fail closed. Synthetic/client qualification flags are
registration assertions, not a network sandbox: a host that falsely labels a live
client violates the contract. No provider client or live registration is included.
The generic Vault HTTP executor remains bearer-only and rejects query strings;
this adapter does not relax it. A live Meta transport needs a separately reviewed
resolution of the recipe's private exchange/query requirements and the security
policy's ban on token URLs; log suppression alone does not waive that policy.

## Durability, cancellation and uncertainty

The existing Vault effect ledger commits `unknown` before external I/O and
serializes dispatch. Its reconciliation protocol requires `not_applied` before
even the first dispatch. The native `MetaPrivateCustody.claimDispatch` must
therefore atomically commit an irreversible attempted marker in the host's
existing dispatch/outbox mechanism **before** sending the code. That marker must
survive rollback of the surrounding SDK transaction, lease loss, timeout and
process death. Never implement it with a boolean or a transaction that rolls back
after provider I/O. If no such native mechanism is qualified, keep dispatch off.

`not_applied` is permitted only when that authoritative marker has never been
committed, serialized against every outstanding attempt. Once claimed, absence
of a response/token is **unknown**, not evidence of failure. Reconciliation is
authenticated and read-only, tied to the exact original effect/digest and retained
private result. A token discovered elsewhere does not prove an exchange. No
reconnect, new grant, new key, replacement job or callback can authorize replay.
Conservative claims that never reached the provider also remain unknown.

Cancel/revoke first call the native `fence` to durably stop work or revoke the
local Vault grant, invalidate handoffs and return the canonical connection CAS
revision. Then the adapter locally revokes that connection, including after
expiry. Native denial still wins. An interrupted second step is fail-closed
because the native fence already prevents use; retry the idempotent local fence
and CAS with current authority. Unknown connection effects retain their original
identity and reconciliation reference. The current connection contract does not
support resolving a recorded `unknown_effect` to ready; domain-owned resolution
is a remaining gate, not something this adapter circumvents.

Remote token revocation, extension/renewal, system-user provisioning and account,
app, billing or ad creation are not implemented by this adapter. A local revoke
does not claim provider revocation. Users may revoke via Meta's own settings;
subsequent private inspection fails closed. Adding remote DELETE requires a
separate explicit user action, allowlisted executor and unknown-effect policy.

## Manual fallback and remaining live gates

Without this extension, use Marketing's existing secure manual connection flow.
An authorized user can complete provider configuration/consent privately and
submit an existing credential only through the host's existing secure Vault
input. Never paste a credential into chat, a tool argument or a Marketing form
that lacks private custody. Missing approvals/configuration return blocked or an
authenticated handoff; no autonomous account/app creation or billing setup occurs.

Before enabling any live operation, independently qualify all of:

- Existing app/ad-account ownership, host scope mapping, account role, approved
  redirect, API version and private app credentials; no environment name implies
  a sandbox. Standard/Advanced **permission access** differs from Limited/Full
  **Marketing API tiers**. All tiers reach production data; Limited is for
  development. Check actual app review, business verification and applicable tier.
- Installed native user approval, login/consent/MFA session and CSRF/state replay
  handling, encrypted Vault storage/key rotation, ACLs, log/URL suppression,
  fixed transport operations/limits and cancellation/lease fences through commit.
- Durable native attempt CAS across process death and transaction rollback,
  exact-effect private reconciliation and a reviewed domain resolution for an
  exchange whose outcome cannot be established. No auto-retry workaround.
- Separately authorized live receipts for both read capabilities, real account
  binding, expiry, declined/revoked permission, duplicate callback, restart,
  stop/revoke races and stale leases. Update qualification deliberately only after
  evidence is reviewed. Fixture flags must never be relabelled as provider proof.
- Any browser fallback separately: the reference profile store's secure host-only
  cookies/local/session storage do not prove reusable Meta sessions. No browser
  implementation is installed or enabled here.

This source request authorizes none of those live actions. No live credentials,
login, consent, token generation/transmission/revocation or account change was used.

## Verification and documentation provenance

`npm run test:marketing` exercises synthetic private-client/native-host boundaries.
`node tests/run-local-postgres.mjs test:marketing-postgres` uses the existing
disposable PostgreSQL 15 harness and real Vault encryption/grants, entry,
connection, journal and lease repositories. Native Meta transport/dispatch-custody
are narrow synthetic boundary fixtures, not a new fake database. Those tests
prove SDK persistence and composition, not a host's durable attempt store or live
transport. The optional installed-consumer check compiles the packaged example
using public exports with strict NodeNext and Bundler and `skipLibCheck:false`:

```sh
# Uncommitted source qualification: baseline SHA is not a candidate Git identity.
node tests/verify-marketing-install.mjs c17257f0b9ed10f84f32dc7f2107d40e3c51aa13 --candidate-source
# After separate review/publication, qualify the actual delivered Git revision:
node tests/verify-marketing-install.mjs FULL_40_CHARACTER_DELIVERED_SHA
```

The runner creates a temporary consumer outside the checkout, installs Marketing
from its frozen full-SHA public HTTPS Git dependency with normal prepare scripts,
then copies the manifest and unchanged lockfile into a second consumer and runs
`npm ci` with a fresh cache. Candidate mode follows the existing source-consumer
workflow: install the candidate's dependencies normally, build/pack Agent source
with normal prepare, and unpack only its package allowlist for the tests. No
Agent tarball dependency or Git-install claim is put in the consumer lock. The
committed mode installs Agent from its actual Git SHA instead. Neither mode
rewrites dependency locks, substitutes sibling workspaces, or imports reference
factories. Logs, lockfile, source/pack hashes and command timings stay in the
reported temporary evidence directory. The example hash is taken from the
installed package actually compiled; fixture/harness hashes identify the review
checkout separately, including in future committed-SHA mode.

The focused regression covers all blocked reasons, waiting/ready projection,
synthetic denied/accepted human approval, cancellation and original unknown
preservation, inert runtime imports, browser graph/server rejection, and private
value suppression, complete frozen Setup/Grant preservation, immutable handoff
inputs and current-authority checks. It also executes the actual `MarketingServer`
with its public `Store` on a disposable SQLite file and synthetic provider ports:
blocked/waiting projections persist, and ready still requires independent provider
capability verification. This is the package's existing SQL implementation, not a
fake repository; it makes no PostgreSQL dialect or live-host claim. Ready
projection is a vocabulary-only probe; fixture evidence remains blocked.
Stateless native-port responses test the wrapper boundary, not native storage.
The separate existing PostgreSQL/Vault suite proves encrypted custody,
entry/answer replay, durable effects, revocation and SQL reconnect behavior. No
live provider is called by either check; the consumer runtime fences network IO.

On 2026-10-06 the web reader returned 429, then direct unauthenticated public
documentation reads returned HTTP 200 at these canonical URLs:

| Official guide | SHA-256 of fetched documentation bytes |
| --- | --- |
| [Authentication](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication) | `788c92462368de97a68599da7878340fa6c334b90fec594d194fe36bb4ede727` |
| [Authorization](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization) | `7baef3752573fa02055024f402d5cdfb6465f84bfa8fc6c8c83830680ef1939d` |
| [Manual OAuth flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow) | `b1e2eb3539e966c149a19f805a9fce347ccb3e1aa47dde67b2396116bb0ff55a` |

Only summaries/digests are retained. These references document the recipe; they
are not authorization or live runtime evidence.
