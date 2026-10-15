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
# Optional application Vault

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
revoked or changed credentials cannot be replayed. The host owns origin, scope,
revision checks and access auditing. Provider failures must never include secret
values in public diagnostics.

Automatic credential selection is attempted once per original job and exact
credential origin. A new request after rejection or MFA uses the private form;
the SDK does not cycle through saved passwords. Multi-page logins can therefore
require private input after the first automated page. A missing provider, disabled
Vault, absent match or unavailable credential retains the existing private form.
