# Browser and login Vault integration

The server entrypoint now exposes `createBrowserUse`, `createLoginVault` and
`createLoginFillExecutor`. `createAgentRuntime` accepts `kind: 'browser'` alongside
its existing `vault` tools. These are shared execution adapters, not a hosted
browser service or an airline connector. Importing them performs no IO.

## Composition

1. Register a private browser executor with `createBrowserUse(host, effects,
   registrations)`. Use the same durable effect store as the agent. Registrations
   bind immutable host-admitted `BrowserOperation` references to exact effects,
   perform private browser operations, reconcile uncertain outcomes, and return
   only validated `BrowserObservation` facts. The host must authenticate and hold
   native job/profile/lease/document authority through the entire callback and
   commit. `context()` must be current, not a snapshot taken before awaited IO.
2. Register the resulting `browser` object in a runtime tool:

   ```ts
   const accountTool = {
     name: 'account_points',
     description: 'Read an authorized account points balance.',
     kind: 'browser' as const,
     parameters: accountParameters,
     bind: resolvePersistedBrowserAdmission,
     browser,
     readResult: readAuthorizedPointsResult,
   };
   ```

   The parameter schema contains account/operation aliases, never a password,
   selector, URL, browser handle or permission claim. The host authenticates and
   resolves every alias. `bind` returns the original persisted admission for the
   call's effect ID on retry; do not construct a new admission from current state.
   `readResult` is a repeatable, read-only, host-filtered domain projection. For
   example, return a numeric points balance, an authorized account alias and an
   observation timestamp. It runs only after a verified effect and an authorized
   sanitized observation, never after withheld output or a takeover request.
3. Compose `createLoginVault(entryHost, entryStore)` with the existing encrypted
   Vault entry store. A missing credential uses the original job's `secure_input`
   requirement. The authenticated private UI calls `capture(handle, {password})`;
   selection of an existing item calls `capture(handle)` with no value. Call
   `deliver` to deliver the reference-only answer, then resume the original job
   after validating that answer. Closing a form does not cancel or complete it.
   The host still owns secure UI, origin/CSRF checks, authentication, item ACLs,
   encrypted storage, saved consent and revocation. The adapter rejects extra
   fields, including verification codes. Password whitespace is preserved.
4. Register `createLoginFillExecutor(registration, privateBrowserDestination)`
   with `createVaultUse`. Add a `kind: 'vault'` runtime tool whose `bind` resolves
   the exact existing permitted-use grant. Only the private destination receives
   the password. The adapter checks the complete destination, permits one fill,
   suppresses raw errors and never submits a login form. Login submission is a
   separate browser action requiring its own admission. Account identifiers are
   resolved through the host's authorized account mapping.

Generic browser execution rejects `vault_fill` and `vault_capture`. Credentials
must use the existing Vault grant/custody/effect path; opaque IDs alone are not
permission to read or fill a secret. Each family account needs its own scoped
profile, account mapping and credential grant. Never reuse a logged-in context
across family members.

## Observations and human verification

`observe` is a separate read-only operation under fresh host authority. It checks
the complete operation binding and strict observation shape, then requires
`canObserve` to approve release under current recipient/profile/lease policy.
The host authenticates adapter qualification and all subject aliases. Raw DOM,
network output, cookies, screenshots, credentials and provider errors are not
valid observations. Schema validation alone is not sanitization or provenance.
The host's domain result reader must independently prevent those values from
entering tool results, history, logs or the model.

When a verified browser operation returns a host-authorized `takeover` observation,
the runtime saves its reference-only result and pauses the **same job** on that
human requirement. It does not mark the job successful or project a balance.
The host uses the existing browser takeover/handback contracts to fence the old
controller, present its private human surface, obtain fresh handback authority,
and deliver a verified answer through `createJobAnswer`. After `runtime.resume`,
the completed browser action is not repeated. New actions require new admissions
under the successor lease. MFA and CAPTCHA must be completed in that human
surface, not by sending codes into chat. The host must validate cached-result
access in `withToolAuthority`, including after handback or revocation.

`unknown` browser effects pause on the existing reconciliation requirement.
They never count as permission to retry. `reconcile` reads existing facts only.
The private executor may return `not_applied` only when late application is ruled
out. Stop, timeout and revocation must fence actual browser IO as well as SDK
callbacks; an AbortSignal by itself cannot stop a remote browser operation.

## What remains application-owned

An application must supply a qualified private browser/controller, isolated and
encrypted profile custody, authenticated secure-entry and human-takeover UI,
current native authorization, durable immutable admissions, and authorized domain
readers. The browser owner must bind actual account, origin, full frame ancestry,
navigation generation, field and form destination atomically with a credential
write; enforce egress on every redirect/subresource; and suppress private traces.
The generic adapters cannot infer these facts from a selector or model input.

These SDK changes do not change Mills' dependency pin or register tools in Mills.
They do not establish a successful Southwest login or live points retrieval.
Application adoption and provider end-to-end validation are separate required
steps. Install a published revision using the public HTTPS Git repository, a
full commit SHA and a matching package-manager lockfile; do not substitute a
local/file/tarball dependency to adopt an unpublished working tree.

## Checks

```sh
npm run test:browser-integration
node tests/run-local-postgres.mjs test:browser-agent test:vault-entry
```

The first suite checks authorization, stale destination/lease rejection, private
password boundaries, timeouts and observation filtering. The second runs the
real Agents Runner and PostgreSQL ledger against synthetic private executors,
including same-job takeover/resumption, no action replay, and unknown results.
It also exercises login entry against encrypted custody and the answer outbox.
No test uses a real family credential or logs in to Southwest.
