# Scoped browser contract

`src/contracts/browser.ts` exports readonly metadata/reference types and pure validators through `handrail-agent-sdk`. Trusted policy types are exported only from `handrail-agent-sdk/server`. There is no browser adapter, persistence, observation filter, provider operation or service startup in this change. The native ownership artifact and KB provenance cited in [agent-security-boundary.md](agent-security-boundary.md) remain the ownership baseline; the fixed native QA recipe is not portable profile support.

## Scope, custody and leases

`BrowserProfileReference` contains an opaque ID, revision and the existing six-dimensional `JobIdentity.host` scope: tenant, user, project, provider account (`accountRef`), environment and purpose. All dimensions are required; absence is never a wildcard. Profile metadata describes authenticated encryption custody with nonsecret custodian/envelope/key-version aliases. These are assertions about required custody, not encryption proof. Cookies, storage, ciphertext, paths, key material and provider handles have no fields. The private custodian must bind profile/scope and envelope versions cryptographically, enforce current tombstones on restore and isolate every context.

A `BrowserLease` identifies the exact profile revision, session, owner kind/identity, lease revision, fencing epoch and issuance/expiry in Unix milliseconds. `validateBrowserLease` checks shape; `validateBrowserLeaseSuccessor` requires the same scoped profile and strictly increasing safe-integer epoch and revision plus a current successor. Equal/stale epochs and exhausted integers fail. Expiry equality is expired. This function does not acquire a lease or prove exclusivity. The host must compare-and-swap durable ownership, fence old commands/writes/streams, and quarantine an unfenceable context before reuse. Every operation and observation binds the full lease. Persistence writes must use the same fence in the future custodian.

## Operation admission

`validateBrowserOperationSchema` checks structure and internal bindings only. `validateBrowserOperation(value, trustedContext, now)` additionally compares the complete host-admitted request, original `JobIdentity`, current job revision, scoped profile and exact lease. It requires authenticated current authorization, an active profile, running job, unexpired lease/task and an effect not already accounted for in the original job. All native and channel identity fields survive unchanged. Effects use existing action/operation/effect references; `unknown`, `verified` and `not_applied` entries all prevent redispatch of that effect.

| Action | Bounded input and trusted resolution |
| --- | --- |
| `navigate`, `tab_open` | Approved destination alias; the executor resolves and authorizes each destination/hop |
| `inspect`, `locate` | Typed inspection or approved locator alias; no raw page text or selectors returned |
| `click` | Scoped element alias bound to the current document |
| `type` | Element and approved text aliases; host independently verifies the exact text and field are non-sensitive |
| `tab_select`, `tab_close` | Authorized tab alias, bound through exact host admission |
| `wait` | Document-ready or element-visible/hidden condition; element required for element conditions; 1–30,000 ms |
| `upload`, `download` | Scoped, versioned opaque artifact reference and element alias; a qualified transfer gate must authorize exact content/type/size/destination |
| `vault_fill`, `vault_capture` | Current grant reference/revision resolving to an existing `VaultOperation` |

Model text labels, `nonSensitive` flags and opaque ID possession establish no authorization. Ordinary typing deliberately accepts no inline text. Download artifacts are host-reserved references, never arbitrary filesystem paths. Transfer authority is separate from ordinary operation admission and from observation release.

Vault operations reuse `validateVaultOperation`, including its item ACL, grant lifetime/revocation, purpose, destination/field, current job and effect rules. The browser validator also binds the vault request to the same browser identity, job revision, effect, profile, epoch, origin, document/navigation revision and complete ordered frame ancestry. It exposes no new secret item, capture payload or competing vault grant. Existing login fill, synthetic single-field identity fill and password/token capture remain the vault catalog; payment fill and token reveal are absent.

Every browser document uses the destination dimensions already defined by `VaultBrowserDestination`, plus an approved tab alias. Client claims are insufficient: immediately before execution, after any redirect/target change, the qualified executor must verify actual provider account, origin, complete frame ancestry, document/navigation generation, unique field identity/type and form/destination. All alias resolution must be scoped to this request. A changed target requires fresh admission. Redirects and popups never inherit credential authority. If atomic target binding, egress enforcement or account verification is unavailable, deny the affected operation.

## Protected observations

`validateBrowserObservation(value, request)` strictly checks request/effect binding. Sanitized output requires an adapter/qualification/policy/receipt attestation bound to the request's session, epoch and operation. The only facts are bounded typed statuses with host-approved subject aliases. There is no unrestricted text, DOM, storage, screenshot, debug, network or error output. The alternatives are fixed redacted status or a reference-only approval takeover requirement. Unknown effects require a reconciliation reference and never authorize retry.

**This validator does not authenticate the adapter, verify its qualification, perform sanitization or authorize release.** A model can forge syntactically valid attestation fields. The host must accept attestations only from an authenticated qualified adapter, independently validate their provenance against the exact request and current policy, and gate the entire output before any stream/serialization/log/history/model sink. Repeat current scope, recipient, cancellation and lease checks before release, including replay. If actual sanitization cannot be established, return redacted status/takeover without partial output. `validateBrowserOperation` is a pre-dispatch check, not a post-effect output-release validator: once effects are journaled, it deliberately rejects redispatch.

## Takeover and handback

`BrowserTakeover` reuses the original full `JobIdentity` and a user approval `JobRequirement` reference/revision. Its deadline is at most 15 minutes after issuance and cannot be extended during the flow. `validateBrowserTakeover` checks shape only. `validateBrowserTakeoverTransition` uses trusted current job, profile, lease, prior takeover and authorization facts:

- Initial `requested` starts at revision 1 under the current agent lease and the same unconsumed waiting-job challenge.
- `requested` → `leased` advances takeover revision exactly once and transfers to the scoped human with a higher lease epoch/revision. The host must already have fenced the old controller; human control expires no later than the challenge.
- `leased` → `handed_back` advances again, fences human control, and installs a current agent lease with a higher epoch/revision. Fresh authorization must match the new epoch, original job revision, challenge/revision and handback reference/revision, be issued at or after the new lease, and remain unexpired within lease/task deadlines. The prior authorization reference is explicitly rejected. Trusted hosts must issue and authenticate genuinely new grants, not relabel old grants.
- `requested` or `leased` → `expired` retains the original lease binding and records a higher fenced epoch only after the challenge or lease expires. Fencing must be confirmed. Expired or handed-back facts cannot transition again here; duplicate replay handling belongs to the durable host.

All active transitions reject stale original job/challenge/scope, expired authority, cancellation and consumed answers. Handback is not an automatic job answer/resume and cannot revive a previous vault or operation grant. Existing job contracts own cancellation and same-job resumption. Takeover neither removes nor resolves existing unknown effects; those remain with the original domain owner for reconciliation. Cancellation independently closes/fences browser control and suppresses late output without discarding uncertain effects.

## Revocation and validation limits

`BrowserRevocationResult` explicitly separates local revoked/deleted/unavailable status from remote revoked/unavailable/unverified/not-requested status. A claimed remote revocation needs a separate receipt reference. Schema validity proves neither receipt truth nor permission to invoke a provider. Local deletion cannot imply remote logout. Remote revocation must be independently authorized and verified by the native provider owner when supported.

Every record uses exact own enumerable data fields. Unknown, hidden, symbol and accessor properties fail; lists are dense and bounded to 32; identifiers use the existing 1–128 character nonsecret alias syntax. Errors return fixed codes only, without input keys/values or exception details. Successful validators return the original input object. Hosts must use inert decoded data, protect authoritative snapshots from mutation, and repeat validation atomically with their own durable state changes. Syntax bounds are not secret detection, authentication, ACL enforcement, persistent fencing or adapter qualification. Synthetic tests prove contract behavior only; runtime implementation and independent boundary QA remain separate checklist items.
