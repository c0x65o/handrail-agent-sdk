# Managed account access

`handrail-agent-sdk/server/capabilities` supplies the browser, encrypted credential
and session storage, private login form, human browser control page, account tools,
and durable pause/resume. Applications do not implement those adapters or screens.
This is the default integration for new account-access features; the lower-level
[browser/vault adapters](browser-vault-integration.md) remain available for custom backends.

## Setup

```ts
import { createManagedAgentCapabilities } from 'handrail-agent-sdk/server/capabilities';

const access = createManagedAgentCapabilities({
  database: pool, schema: 'agent', keys: agentStateKeys,
  baseUrl: 'https://app.example.com/agent-access',
  authenticate: request => authenticatedAgentScope(request),
  features: { vault: true, browser: true },
});
await access.initialize();
const runtime = access.createRuntime(existingRuntimeOptions);
// Mount GET/POST /agent-access/:interactionRef to access.handleRequest(request).
// Use runtime with the existing SDK checkpoint reader/conversation transport.
// At server shutdown: await access.close().
```

The [typed example](../examples/managed-capabilities.mts) is compiled in the consumer
check. `authenticate` returns the complete current `JobIdentity.host` scope from
the application's session, or null. Never take that scope from a link or model.
The runtime and this service must use the same PostgreSQL database, schema and
state encryption keys. Use the existing SDK migration command instead of
`initialize()` if migrations run separately during normal startup/deployment.
Size the pool for two held connections per concurrent managed operation plus
free query capacity (at least four connections for one operation). Effects,
account locks, and encrypted storage can be active together. The `baseUrl` is an HTTPS route without a trailing
slash; the framework must preserve the original public URL and stream the request
body without logging it. Do not apply transcript/body capture middleware here.

Existing host authorization, tool visibility, `decide`, and `withToolAuthority`
remain authoritative. For a restrictive tool allowlist, merge `access.toolNames`
into it when these flags are enabled. No hand-written tool schemas are needed.
Enabling a feature does not override application authorization or old instructions
that explicitly forbid browsing. Use the SDK checkpoint reader to display secure
links and preserve them across a waiting turn. A custom reader must project
`checkpoint.interactionNotices` as stable, ordered text before the final output.

## What the assistant gets

- `agent_accounts`, `agent_connect_account`, `agent_disconnect_account` with vault enabled.
- `agent_browser_open`, `agent_browser_inspect`, `agent_browser_click`,
  `agent_browser_fill_login`, `agent_browser_handoff` with browser enabled.

Browser requires vault. Both flags false disable the HTTP surface and all these
tools. Construction/import performs no database migrations, downloads or launches.
`status()` reports feature settings and whether the browser executable is present;
it is not proof of a successful sandboxed browser launch or provider login.
Tool results distinguish missing installation, launch failure, capacity, and
unapproved destinations; none of those statuses implies a successful login.

For a request such as “check each family member's Southwest points,” the assistant
can list saved accounts, request one private credential form for each missing
account, open isolated sessions, fill authorized logins privately, and inspect
balances. It must verify the displayed account and balance before reporting a total.
Secure entry pauses the original job, then answers its native requirement and
resumes that job after saving. Neither passwords nor verification codes belong
in chat. The user explicitly approves the login website and any additional origins,
and grants account use for 30 days. Account access is scoped to the full authenticated
SDK scope; household sharing requires the application's intentional scope policy.

MFA, CAPTCHA, and unsupported login forms use the SDK's private screenshot-and-input
page. While a handoff is active, persisted account control prevents other workers
from running agent actions on that account. Click “I'm done” to return control.
Browser sessions are process-local: route live browser work and handoff requests
to the same worker for uninterrupted control. After worker loss or idle expiry,
return control and let the assistant reopen from encrypted saved storage. Secure
credential entry survives restarts once the same runtime definition is registered.
Private interaction links expire after 15 minutes. An unfinished human-control
claim also expires; it does not authorize further actions by itself.

## Installation and runtime

Install this Handrail SDK from its public HTTPS Git repository at the released
full commit SHA and commit the matching package-manager lockfile. Do not use
registry, branch, tag, tarball or local-file dependencies. Git dependency `prepare`
compiles the SDK and installs its pinned Playwright Chromium in the normal install
pipeline. There is no separate package/publish step.

Server images need Chromium's operating-system libraries and a working Chromium
sandbox. The SDK never falls back to disabling the sandbox. Keep the browser cache
available to the runtime user. An image with its own pinned compatible Chromium
may set `HANDRAIL_AGENT_SKIP_BROWSER_INSTALL=1` at install time and pass
`browser.executablePath`; otherwise leave the default install enabled. The SDK uses
and removes a short private temporary directory to avoid Unix socket path limits.
`browser.maxSessions` defaults to 4; `browser.idleMs` defaults to five minutes.

Credentials and browser storage use the supplied versioned encryption keys; keys
stay outside the database. SDK browser actions enforce approved HTTPS origins and
a checked, pinned public DNS address through a private proxy. Downloads, popups,
WebSockets, service workers, browser traces, and model-supplied JavaScript are not
supported. Known credentials and stored values are redacted from model-facing text;
arbitrary provider transformations cannot be treated as a general data-loss filter.
Private screenshots and human inputs stay on the authenticated portal route.
A disconnect removes local credentials/session access; it does not revoke the
provider's remote session or change a provider password.

External effects are journaled. An uncertain action is reconciled or held for
review rather than silently replayed. Stop/revocation prevents subsequent account
use; it cannot undo a click already accepted by a provider. Website anti-bot systems,
extra third-party origins, cross-frame login forms, and provider layout changes may
require human intervention. No live Southwest login is qualified by the fixture tests.

## Checks

- `npm test` and `node node_modules/typescript/bin/tsc -p tests/fixtures/tsconfig.json`
- `node tests/run-local-postgres.mjs` (owned disposable database only)
- `npm run test:managed-browser` with the installed Chromium, or set
  `HANDRAIL_TEST_BROWSER_EXECUTABLE` to the test image's pinned executable.

The managed integration tests exercise real PostgreSQL and the real agent runtime
with a synthetic model. The browser test runs real Chromium against synthetic
provider pages with the Chromium sandbox enabled by default. Test-only
`HANDRAIL_TEST_BROWSER_SANDBOX=0` is available for restricted test images; the SDK
has no corresponding production override. It covers private
fill, session recovery, account isolation, human control and denied origins. Separate
network tests cover URL/address restrictions and proxy rejection. These are SDK
qualification tests, not evidence that a particular airline accepts automated login.
