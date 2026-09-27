# Scoped vault handoff contract

`src/contracts/vault.ts` provides pure readonly metadata/reference types and strict validators exported from `handrail-agent-sdk`. `handrail-agent-sdk/server` exports only trusted policy **types**. Neither entrypoint starts services. These public entrypoints contain no plaintext adapter, storage, secure-entry UI, browser executor or provider integration. Private reference-host storage is documented separately in [vault persistence](vault-store.md).

## Ownership and authority

The host owns authentication, original-request admission, item ACLs, custody, clock, current job state, grant revisions, expiry/revocation and durable consumption. The context arguments of `validateVaultEntryCompletion` and `validateVaultOperation` must come from those authenticated host services, never from request JSON. Successful validation compares assertions; it does not authenticate them. An opaque reference or a client-supplied `authenticated: true` establishes no authority.

Reuse native Vault ownership: `submitUserVaultInput`, `readAveryPrivateInputReturnObservation`, and trusted `readUserVaultEntryForExecutor` are future adapter boundaries, **not SDK public getters**. The native ownership and KB provenance recorded in [agent-security-boundary.md](agent-security-boundary.md) apply. This worker had no scoped KB/source reader to refresh the cited `handrail-ai-sdk-implementation-contract` entry.

Every request retains the full existing `JobIdentity`: original SDK job/task/request/instruction revision, all six host scope dimensions, native identities and original route. The secure-entry requirement reuses `JobRequirement` identity, revision and authenticated user actor; completion reuses reference-only `JobAnswer`. Effects reuse the distinct action/operation/effect identifiers, matching native effect identities when present. No new controller is introduced.

## Families and destinations

| Family | Metadata and reference | Permitted broker operations |
| --- | --- | --- |
| Login/password | Password classification and a generic secret item/version reference; no username or password value | Capture or password fill |
| API/refresh token | Explicit token subtype and generic secret item/version reference | Capture or bounded server request |
| Synthetic identity field | Exact field (`ssn`, `legal_name`, `date_of_birth`, `tax_id`), `synthetic` classification and provenance reference; no identity value | Single-field fill with explicit recipient and purpose |
| Payment method | Specialized payment/version reference plus host-approved provider/customer/payment-account aliases | Specialized server request for verification or attachment only |

Payment references cannot be substituted for generic secret references in either TypeScript or schemas. The aliases are nonsecret host IDs, never provider handles. Provider-managed payment material and encryption key material stay host-owned. Raw PAN, CVV/security codes and identity bundles have no public fields or general storage representation. A payment reference cannot authorize a purchase; no purchasing operation is defined.

Browser capture/fill binds normalized HTTPS top origin, profile, lease epoch, document, navigation revision, ordered complete frame ancestry (frame IDs and origins), field identity/type and form endpoint. Identity disclosure additionally binds field, recipient and purpose. The host-admitted grant must match every field; an approved cross-origin frame receives no implied authorization for another frame or form. Capture uses a host-reserved item/version reference, not a model-supplied value.

Server requests bind an exact canonical HTTPS endpoint, HTTP method and resource, with redirects denied. Specialized payment requests also bind provider/customer/payment account, merchant/payee, purpose and exact permitted action. There are no public bodies, headers, arbitrary scripts, raw responses or secrets in these operations. Endpoint paths and references still require host approval; syntax cannot prove arbitrary text secret-free.

## Entry, revision and replay rules

`validateVaultEntryRequest` and `validateVaultItem` are shape checks only. An entry request is issued by the authenticated host for one current original job/challenge. Its deadline is at most **900,000 ms (15 minutes)** after issuance. At completion, host policy may shorten this limit and task/item expiry may bound it further. Future issuance, equality with the expiry deadline, revocation and deleted/expired items deny completion.

The host context supplies the exact admitted request, source (`new_input` or `existing_item`), current item/version and approved private-response reference. Both new input and existing-item selection require current item authorization, authenticated actor and job authority. First delivery requires the original waiting job revision, matching unconsumed requirement and no answer. A changed job, instruction, challenge, actor, scope, origin, item version or response binding fails. An answer alone does not resume work or grant secret use.

After atomic host consumption, store the canonical completion. Supplying it as `previous` permits only an identical authorized replay, with a later current job revision and unchanged original identity. Replay still checks current authority, item version, expiry and revocation. `disposition: 'replay'` means return the same reference-only fact: **do not append another answer, create another grant/effect, consume input again or resume the job**. Conflicting canonical content fails; stale new delivery fails. The validator itself neither records nor applies effects. Hosts must serialize admission/consumption and keep canonical inputs immutable to avoid races.

## Use policy and receipts

Trusted `VaultPermissions` distinguishes `use`, `reveal` and `export`. Human reveal/export permissions never imply use. `VaultAgentPermissions` fixes reveal/export to false; the public broker exposes only capture, fill and server request. No model/public reveal/export operation is admitted even if a human policy grants it.

Use is bounded to one item/version, original job/revision, grant/revision, destination and logical effect, for at most **300,000 ms (5 minutes)**. A host policy may narrow the duration. The validator requires current authenticated authority, item ACL/version, a running job at the exact revision, active grant, granted use and task/item deadlines. Already-accounted effects, including unknown outcomes, cannot authorize another dispatch. Changes need fresh host admission and reviewed policy/grant revisions; no automatic renewal is defined.

`VaultBrokerResult` carries only a typed receipt or fixed error code and correlation reference. A receipt preserves the exact operation/effect, with `verified`, `not_applied` or `unknown` outcome; unknown requires a reconciliation reference and never authorizes blind retry. `validateVaultBrokerResult` checks structure and request binding, not execution truth. The host must repeat current authority and destination checks immediately before dispatch and output release, then use the existing domain owner for reconciliation. Provider output is not a receipt until qualified host filtering approves it.

All nested records reject unknown, hidden, symbol and accessor properties; frame lists must be dense, bounded and unambiguous. Errors contain only enumerated codes, never supplied keys, values or exception text. Successful results retain input objects; callers must supply inert data and protect authoritative snapshots from mutation. Secret detection, network isolation, durable ACL enforcement and authenticated runtime behavior remain separate implementation and qualification work.
