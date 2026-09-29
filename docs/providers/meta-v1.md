# Meta v1 setup recipe

Recipe version: `meta-v1.2026-09-28`. Graph API pin: `v25.0`.
Reviewed **2026-09-28** for item `10a00f02-f34d-4680-856c-a54c7a0687d5`.
The [manifest](meta-v1.recipe.json) freezes a documentation recipe. Every operation
is disabled; every adapter is pending qualification. This is neither a runtime
registration nor evidence of an authorized, ready Meta connection. The pin occurs
in the inspected official examples; it is not a claim about the newest release
or an installed host's version. Re-review before operational admission.

## Scope and prerequisite decisions

Use a **User access token**, acquired by a human's Facebook Login consent with
server-side code exchange. App credentials are private supporting credentials for
exchange/inspection, not substitutes for the user's Marketing token. System user,
Page, client and Threads tokens are outside this recipe. Meta supports other token
classes; this narrower choice avoids provisioning business identities in a setup
recipe. See [token classes][access-tokens] and [authentication][authentication].

The exact requested Marketing scope is **`ads_read`**. Facebook Login's implicit
`public_profile` is separate, not an additional Marketing capability. No
`ads_management`, `business_management`, Page scope or `read_insights` is needed
for this recipe's account/report read. The [Insights guide][insights] explicitly
requires `ads_read`; the [authorization use-case table][authorization] maps ad
reports to that permission. Additional permissions on an existing token confer
no SDK authority. The [manual flow][manual-flow] describes implicit login access.

Prerequisite IDs in the manifest have these meanings:

| ID | Required evidence before execution | Responsible actor |
| --- | --- | --- |
| app | Approved developer/app identity, Marketing API and Facebook Login setup, exact registered HTTPS callback and server-only app credential custody; verify the API pin against the app | Host app owner |
| account | Approved tenant/user/project/account/environment/purpose mapping, exact Meta ad-account ID, app-scoped user ID and current permitted account role | Account owner and host |
| access | Applicable permission access level, Marketing API tier, review and business verification decisions for this particular app/use case | Meta and app owner |
| consent | Explicit human consent for the bounded read; user completes login, MFA and provider checkpoints privately | Admitted user |
| callback | Authenticated user, one-time state, original request/challenge revision, deadline and exact redirect binding | Host authorization owner |
| custody | Qualified private capture/use, encrypted Vault storage and output filtering | Host Vault owner |
| token | Actual user/app binding, USER type, current validity, granted permission and expiration metadata | Host provider owner |
| fences | Current authority, original identities, cancellation, lease, revocation and scope checked at dispatch and output release | Native job owner |

Meta's [get-started guide][get-started] requires an app, developer identity and ad
account. Do not follow its campaign-creation next steps for this recipe. The
account must already be owner-approved; this task creates no account or app and
changes no settings. Host policy requires exact HTTPS redirect registration,
matching exchange redirect and one-time state binding; the underlying dialog,
state and server exchange are described in the [manual flow][manual-flow].
An unapproved callback, missing app configuration or missing role yields a
requirement on the original job, not automatic configuration or consent.

Permission **standard/advanced access** and Marketing API **Limited/Full Access
tier** are different. The current [authorization guide][authorization] describes
the renamed tiers, development restrictions on Limited access, app-role/account
constraints, advanced permission review for other people's accounts, and business
verification for sensitive access. Record the app's actual applicable approvals;
neither a token nor this table proves them. Even development access can reach
production data. No request volume is generated to meet tier thresholds, and no
sandbox is inferred from a host environment name.

## Operation mapping

The table below is checked against the manifest. `marketing-agent` and
`marketing-provider` are **candidate source seams**, not selected adapters or
claims that the current host exposes these capabilities. The capability names
are this recipe's proposed identifiers. Only `meta.account.read` and
`meta.report.read` are proposed readiness capabilities; setup operations do not
establish them. Parameter labels ending in `_private` describe private inputs,
never literal wire values. All operations require qualified custody/output gates.

<!-- recipe-operations -->
| Operation | Capability | Request | Authority owner | Candidate seam | Prerequisites | Public sources |
| --- | --- | --- | --- | --- | --- | --- |
| authorize | meta.setup.consent | GET https://www.facebook.com/v25.0/dialog/oauth; response_type=code&scope=ads_read | user | marketing-agent (pending) | app, account, access, consent, callback, fences | manual-flow, authorization |
| exchange | meta.setup.exchange | GET https://graph.facebook.com/v25.0/oauth/access_token; authorization_code_private | host_authorization_owner | marketing-agent (pending) | app, account, access, consent, callback, custody, fences | manual-flow, authentication |
| extend | meta.setup.extend | GET https://graph.facebook.com/v25.0/oauth/access_token; grant_type=fb_exchange_token | host_provider_owner | marketing-provider (pending) | app, account, consent, custody, token, fences | long-lived |
| inspect-token | meta.setup.inspect | GET https://graph.facebook.com/v25.0/debug_token; input_token_private | host_provider_owner | marketing-provider (pending) | app, account, custody, fences | manual-flow |
| permissions | meta.setup.permissions | GET https://graph.facebook.com/v25.0/me/permissions; none | host_provider_owner | marketing-provider (pending) | app, account, custody, token, fences | manual-flow, revocation |
| account-read | meta.account.read | GET https://graph.facebook.com/v25.0/act_{ad_account_id}; fields=id,account_id | account_owner | marketing-provider (pending) | app, account, access, consent, custody, token, fences | ad-account, authorization |
| report-read | meta.report.read | GET https://graph.facebook.com/v25.0/act_{ad_account_id}/insights; fields=account_id,impressions&date_preset=yesterday&level=account&limit=1 | account_owner | marketing-provider (pending) | app, account, access, consent, custody, token, fences | insights, account-insights, authorization |
| revoke | meta.setup.revoke | DELETE https://graph.facebook.com/v25.0/{app_scoped_user_id}/permissions; none | user | marketing-provider (pending) | app, account, consent, custody, token, fences | revocation |
<!-- /recipe-operations -->

The harmless verification is a bounded account GET for `id,account_id` followed
by one synchronous account Insights GET for `account_id,impressions`, yesterday,
account level, limit one, without pagination. Compare the returned account
identity with the independently approved mapping; validate any returned report
account IDs. An empty report is permitted on an account with no delivery: it
proves only successful access to the bound endpoint after the separate identity
check, not advertising activity or metric correctness. No asynchronous report
creation, campaigns, ads, spending or other domain mutation is included. See the
[account fields][ad-account] and [Insights parameters][account-insights].

Inspection (`debug_token`) binds app/user/type/validity/expiry, and permissions
inspection checks `ads_read` is still granted. Neither substitutes for those
account/report calls. Release only a host-generated scoped capability receipt;
raw account data, token inspection payloads, callback URLs, codes, tokens and
provider errors stay out of model observations, logs and evidence. The manual
flow's query examples require private request handling with URL/access-log
suppression before dispatch; never copy secret-bearing examples into diagnostics.

## Lifetime, reconnect, revocation and uncertainty

[Access-token documentation][access-tokens] gives typical short lifetimes of
one to two hours and long lifetimes around 60 days, warns against relying on
them, and mentions Marketing exceptions. [Marketing authentication][authentication]
also describes persistent tokens and invalidation. These are not a uniform TTL
promise. Use actual exchange/inspection expiration and data-access expiry when
provided, plus a finite host authorization/verification deadline. Missing,
ambiguous or invalid lifetime evidence cannot imply readiness. A provider
no-time-expiry indication must still have a finite host deadline; it is never
irrevocable authority. The manifest intentionally contains no fixed token TTL.

[Long-lived token exchange][long-lived] accepts a valid short-lived user token
with app credentials on the server. It does not accept an expired token. This
optional exchange is separately journaled; it is not an OAuth refresh-token
grant or permission for background renewal. Meta describes SDK-specific renewal
behavior, but this server recipe does not import it. Expiry, revocation or lost
permission requires human reauthorization and fresh capability verification
within the same admitted ceiling. No automatic consent loop.

Users can decline or revoke permission. [Revocation documentation][revocation]
supports permission reads and user-requested deauthorization via
`DELETE /{user-id}/permissions`; successful deauthorization invalidates user
tokens and requires new login/consent. That operation is documented for later
explicit authorization, not executed here. A local revoke immediately fences
use and invalidates cached receipts independently of whether remote revocation
has completed. Password changes and provider invalidation also require current
validity checks. A lost revoke acknowledgement cannot be called a success.

**An uncertain code exchange or token extension remains `unknown_effect`.**
The reviewed exchange docs specify no lookup by the SDK's logical effect ID and
no idempotency guarantee. This is a limitation of the reviewed evidence, not a
claim that all possible Meta recovery mechanisms are impossible. Retain the
original effect and reconciliation reference; do not resubmit the code, extend
again, switch keys or start a replacement job because a response was lost.
A qualified domain reconciler may account for a privately retained result under
current authority. A token found elsewhere or a successful account read does
not prove which exchange produced it. With no correlated result, hold for
domain-owned resolution. Reconnect cannot erase the uncertainty, and the current
connection contract exposes no transition that resolves it.

## Host evidence and unresolved citations

SDK source baseline: `lane/agent-sdk-v1` at
`34a21d6673d940bd59fb9800d4ddeef6b3d7e051`. The manifest retains SHA-256 digests
for the inspected [connection contract](../connection-contract.md),
[connection types](../../src/contracts/connection.ts),
[security boundary](../agent-security-boundary.md) and
[M4 acceptance cases](../../fixtures/convergence-v1.json).

The completed M1 inventory belongs to Handrail project
`07b11eec-aac0-4ec4-a1a6-d5be88b41948`, repository
`4d92b94f-7234-4318-99ab-c19b0bb65855`, work request
`c08b2fdf-888d-4d37-bc75-26f66a2c48c0`. Its **reported** baseline is
`847c632b0718f52669f5adcbf3a377d6d0b4187e` and document digest is
`b1bd9b24fee983cb2dc03b26e5a25f42fac72900f68408d47b381eac86ca122b`.
The SDK security document records an earlier successful inventory read. This
worker could not independently reread it or current Handrail implementation.

On 2026-09-28, `read_source_files(source=handrail, repo_name=handrail)` with both
null and omitted `change_lane_id` failed because the reader inherited
`convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e`, which is not a Handrail
lane. A scoped `grep_source_code` for Marketing callers failed identically.
Unresolved exact citations are `docs/agent-sdk-native-ownership.md`,
`marketing-sdk/server/{agent,providers,ports,service}.ts` and their actual callers.
**Current Handrail revision and dirty-source digests are unavailable**, not clean
or unchanged. No historical line number is presented as fresh evidence; no
Handrail lane was provisioned. Restore authorized source access before adapter
selection, then retain exact revision, source digests and independent qualification.

Historical evidence suggests AgentPort/setup, provider verification, native
Vault/input, job/task/wake and domain reconciliation ownership. Their reuse is
required, but coverage of this recipe remains unverified. There is no qualified
adapter selected by this artifact. Browser fallback is **disabled: no explicitly
permitted recipe gap**. The human's normal provider consent dialog is not an
agent-controlled browser fallback. No new controller or browser bypass is added.

The earlier security document contains superseded payment prerequisites. They
are irrelevant to this Meta recipe and are not adopted here; current owner scope
governs the separately tracked Vault card work.

## Recovery and live-proof prerequisites

Bind `ConnectionEnsureInput.prerequisiteVersion` to this recipe version. Preserve
the original SDK job/task, all native and route references, action/operation/effect,
capability ceiling, scope and evidence mode across callbacks, restart and reconnect.
Recheck current authenticated principal, Vault item/grant revision, instruction
revision, cancellation/hold and lease epoch before use and before releasing a
receipt. Reject stale answers, wrong tenant/user/project/account/environment/purpose,
expired/revoked authorization and scope changes. Widening requires reviewed
admission; narrowing applies immediately. Identical duplicate delivery can reuse
only its canonical current receipt; conflicting idempotency is rejected. These
are existing contract/host requirements, not persistence behavior implemented here.

The approved non-secret metadata search read current context and dev auth-profile
metadata for the SDK and linked Handrail project. SDK had zero profiles; Handrail
had two application QA profiles, neither an approved Meta account mapping. No
Meta capability was configured in those projects' returned context. This bounded
search does **not** establish that no approved metadata exists elsewhere. No
credentials were read, requested or collected. The manifest leaves account,
environment and authority references null, and readiness false.

Later live proof requires:

1. An existing approved non-secret account reference mapping all six host scope
   dimensions to the exact Meta ad account, app, app-scoped user, account role,
   allowed environment, owner consent authority and read purpose. A Handrail dev
   label alone does not authorize touching Meta production account data.
2. App/redirect/version and access/review evidence, private credential custody,
   exact current host source/caller review and qualified adapters for every path.
3. Separately authorized installed-runtime provider receipts for both read
   capabilities, current expiry and revocation facts, preserving original work.
4. Installed same-task restart/expiry/revoke/duplicate/unknown-effect recovery
   proof under the existing M4 items. Unknown-exchange resolution remains pending.

These are unresolved live-proof prerequisites, not requests to perform live work.
M4 observed acceptance stays unverified. Structural mutation fixtures use only
synthetic data and cannot authenticate receipt provenance or provider facts.

## Validation and public-source record

Run `node scripts/validate-meta-v1.mjs` and
`node --test --test-concurrency=1 --test-reporter=tap tests/meta-recipe.test.mjs`.
The validator enforces the frozen operation/prerequisite/source mapping and
disabled status; it cannot qualify adapters or certify provider readiness.
It consumes decoded JSON, returns fixed error codes, and is not an execution API.
The operation table and version pins are mechanically checked for agreement.
The [evidence record](../evidence/meta-v1-recipe.json) retains commands, totals and
candidate digests. No persistence behavior is exercised, so no database harness
or disposable-run receipt is claimed. Persistence work must use the existing
`tests/helpers/postgres.ts` / `tests/run-local-postgres.mjs` harness.

All public references below were fetched on **2026-09-28**, HTTP 200, through
public HTTPS with Python `urllib.request.urlopen` after the web reader returned
429/errors for several legacy URLs. The manifest records requested URL, resolved
canonical URL and SHA-256 of the returned documentation bytes. No authenticated
provider endpoint was called. Public docs can change; digests identify this
review, not perpetual validity. Only summaries and digests are retained.

<!-- public-source-links -->

[insights]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights
[get-started]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started
[authorization]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization
[authentication]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication
[manual-flow]: https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow
[access-tokens]: https://developers.facebook.com/documentation/facebook-login/guides/access-tokens
[long-lived]: https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived
[revocation]: https://developers.facebook.com/documentation/facebook-login/guides/permissions/request-revoke
[ad-account]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account
[account-insights]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights
