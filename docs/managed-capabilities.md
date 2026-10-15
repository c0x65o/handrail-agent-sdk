# Managed account access

`handrail-agent-sdk/server/capabilities` supplies scoped encrypted credential custody,
authenticated private forms and durable owner-input handling for OpenAI-hosted
browser requests. It uses the same admitted job and provider session as the shared
runtime. It does not install Chromium or run a second browser engine.

```ts
const access = createManagedAgentCapabilities({
  database: pool, schema: 'agent', keys: agentStateKeys,
  baseUrl: 'https://app.example.com/agent-access',
  authenticate: request => authenticatedAgentScope(request),
  // Both features default to true. Set either to false explicitly to disable it.
  features: { vault: true, browser: true },
});
await access.initialize();
const runtime = access.createRuntime({ ...runtimeOptions, harness: hostedHarness });
// Mount GET/POST /agent-access/:interactionRef to access.handleRequest(request).
```

Supply an OpenAI client with Agents API access through `harness`. The SDK creates
an `openai_hosted` environment with the `computer_use` tool and desktop enabled by
default. Browser false omits both. Browser access does not require saved credentials
or a local executable. `status()` reports configuration, not live browser proof.

Keep the application’s existing session authentication on this route. `authenticate`
must return the complete current `JobIdentity.host` scope, never scope from the
link, request parameters or a model. Use the same database, schema and encryption
keys as the runtime. Preserve the public request URL and body without logging it.
Do not put transcript capture middleware on this private route.

For applications that dispose of turn observers, configure `restoreRuntime(identity)`
to re-register the original job through this service's `createRuntime`. It runs only
after the request is authenticated and its encrypted interaction matches the complete
scope. Re-read native job authority when restoring; do not admit a replacement job.
The same hook restores links after an application process restart.

Configure `onAnswered(identity)` when the application owns canonical turn scheduling.
The SDK saves the verified answer first, then calls this hook instead of starting
provider work outside that scheduler. Retain the original job and conversation;
repeated private-form submissions may repeat the notification and must be idempotent.
Without that hook, the registered runtime resumes the same original job directly.
`createConversationAgentRuntime` accepts `createRuntime: access.createRuntime` to
compose private browser steps with canonical transcript custody.

Current host authority, exact job identity and the original pending provider
request are checked on every use. Forms require same-origin POST and CSRF checks.
If a form expires while its original task still awaits that same response, the
authenticated owner can reopen the same link. The SDK rechecks current authority
and rotates the expired form token; old submissions remain invalid. Reopening
does not approve access, start provider work, or replace the task/session. Stopped
tasks and revoked access cannot renew a form.
Private values are encrypted at rest and submitted directly to OpenAI’s registered
browser controls; they do not enter chat, model input or tool output. Untrusted
provider field labels, explanations and origins are escaped when rendered.

For sign-in methods, only the selected method’s registered field IDs are submitted.
The owner can type values or explicitly choose saved username/password values for
individual fields. Saved credentials can be used only for their approved exact
origin, within their scope and unexpired grant. Cancelling sign-in sends a cancel
response to the original provider request. Website access requests require an
explicit allow/deny response; visiting a page is not proof of a login or task result.

Vault enables `agent_accounts`, `agent_connect_account` and
`agent_disconnect_account`. Merge `access.toolNames` into a restrictive application
tool allowlist. Disconnect removes saved credentials; it does not revoke an
already authenticated remote website session. Browser uses the provider’s native
computer tool, so there are no separate `agent_browser_*` application tools.

Use the normal SDK checkpoint reader to project `interactionNotices` and native
requirements into the originating conversation. The private response resolves that
requirement and resumes the same job. A restart retains the request and encrypted
response, so uncertain result delivery can reconcile without retyping or executing
the task twice. Stop must settle the remote turn with `runtime.cancelProvider`
before recording native cancellation. `runtime.stop()` detaches local observation
for process recovery; it does not claim to cancel hosted work.

The host retains provider session identity in encrypted conversation storage.
Changing the model updates settings on an idle original session. Tool/environment
configuration, including browser enablement, is immutable in the current provider
API. A conflicting configuration fails closed; it never silently replaces the
conversation or continues with a browser that the host has disabled. Settle active
work before changing policy. Session deletion is explicit and requires a terminal
turn; retain needed artifacts before deleting it.

Validation includes real disposable PostgreSQL secure-entry/restart tests, scoped
access and Stop rejection, provider request rendering, and the hosted transport’s
recovery tests. Production delivery still requires testing the installed consumer,
its authentication, original conversation, artifact storage and cancellation path.

Private input failures include `X-Handrail-Agent-Input-Error`, a fixed stage label (authentication, interaction lookup, current job authority, form renewal/rendering, submission, or answer delivery). The header contains no exception text, private URL, provider payload or submitted values. Use it to distinguish the failing boundary without exposing form data.

Saved private responses survive a failed answer handoff. On the original scheduler resume or an authenticated reopening, the SDK delivers the saved response under current host authority, renewing only an expired challenge for the unchanged wait and authority. Stop, revoked access and changed waits still reject it. The original job and provider session continue; the user does not submit the response again. Delivery diagnostics use fixed `answer_issue_*` / `answer_complete_*` store codes, never raw exceptions.

An authenticated conversation can collect a nonsecret website decision through
`readBrowserOriginAccess(identity, actorScope, requirementRef)` and
`answerBrowserOriginAccess(identity, actorScope, {requirementRef, decision, sourceRef})`.
The host must authenticate the sender and bind their explicit decision to the exact
delivered request. Neither a website request nor an original task grants consent.
The SDK checks the current original wait and host authority, retains the first
decision, and rejects conflicting answers. The host's scheduler resumes that same
job; saving an answer does not execute it. These methods cannot read or answer
credential forms. Keep passwords and verification codes on the private portal.
## Optional application Vault

`createManagedAgentCapabilities` accepts an optional `credentialProvider` with
`select(input)` and `resolve(input, selection)` methods. Applications that omit it
retain the existing private form and SDK account storage behavior.

The input contains the original job identity, provider request ID and registered
browser authentication request. `select` returns an opaque `credentialRef`, its
`revision`, `optionId` (null for a plain form), and explicit `{fieldId, source}`
mappings, or null to request private human input. `resolve` rechecks current
application authority and returns the requested source values privately, or null
when unavailable. Selection must use explicit configuration or a structured model
decision; field rendering types alone cannot distinguish a password from an MFA
code. Never send values to a model to perform selection.

The SDK validates the registered fields and option, rechecks job authority, and
passes values only through the registered private browser response. It retains
the response encrypted for same-request recovery without creating a reusable SDK
account. Recovery re-resolves the exact selected revision through the host, so
revoked or changed credentials cannot be replayed. If resolution becomes unavailable
or Vault is disabled before delivery, the SDK removes the stale response and
reopens the original private form. The host owns origin, scope,
revision checks and access auditing. Provider failures must never include secret
values in public diagnostics.

Automatic credential selection is attempted once per original job and exact
credential origin. A new request after rejection or MFA uses the private form;
the SDK does not cycle through saved passwords. Multi-page logins can therefore
require private input after the first automated page. A missing provider, disabled
Vault, absent match or unavailable credential retains the existing private form.

## Sign-in recovery and diagnostics

Private sign-in is a sequence of provider requests, not a single login result.
Each request retains its exact original job, provider request ID, login methods
and field IDs. A rejected password, subsequent two-factor challenge, or rejected
or expired verification code can produce another private form in the same task.
The SDK emits a new conversation notice and an already-open private receipt page
follows the current same-job step. It never copies a previous password/code into
a new request or infers the meaning of fields from labels. Verification codes
are private responses, not reusable SDK accounts. The provider must expose the
next authentication request; unsupported methods such as passkeys/QR sign-in
remain provider limitations, not a reason to collect secrets in chat.

The portal distinguishes explicit cancellation from submission. A receipt means
the response was saved, **not** that the website accepted it. Required/invalid
fields return an empty form with a corrective message (422); expired or stale
forms return a reopen link (409). Reopening rotates the expired form's CSRF under
current authority, without resubmitting old input. A saved response whose answer
handoff fails returns a recoverable 503 receipt; reopening or the existing host
scheduler recovers the same response. Uncertain provider delivery retains the
same request and idempotency identity. Stop and revoked authority still prevent
continuation. Do not reinterpret an expired form or transport error as cancellation.

`agent_connect_account` accepts an optional existing `accountRef` from
`agent_accounts` to update an expired or incorrect **SDK-owned** login. Updating
it requires the normal private storage consent form and preserves its identity.
One-off browser corrections never silently update either SDK accounts or an
application-owned Vault. Application Vault updates use that application's own
authorized management flow.

An optional `onPrivateInput(event)` observer receives credential-free lifecycle
events: request/follow-up, form opening/renewal/expiry/validation, saved decision,
native answer delivery, provider acceptance or uncertain delivery, and authority
rejection. Events carry the original job ID, timestamp, one-way step correlation,
fixed stage/kind, and explicit submit/cancel/approve/deny where known. They exclude
credentials, field IDs, labels, provider reasons, origins, private links, CSRF,
and exception bodies. Provider acceptance is not website authentication success.

The SDK also retains the latest 64 events and total recorded count per original
job in encrypted custody, so missing infrastructure logs need not erase the
history. This is a diagnostic retention window, not an execution/retry limit.
Trusted server diagnostics can call `readManagedInputDiagnostics({database,
schema, keys, identity})` from `handrail-agent-sdk/server/capabilities` after
authorizing inspection of that exact persisted identity. It works after task
completion and returns `{total, events}`; an empty history is missing evidence,
not proof no input occurred. Observer/storage failures do not grant authority or
block sign-in. Do not expose this server reader directly to model-selected scopes.
