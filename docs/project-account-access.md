# Project account access and same-conversation continuation

Use the shared [managed access service](managed-capabilities.md) with the
[hosted runtime](agent-runtime.md). OpenAI runs the session and browser; applications
supply current authenticated scope, encrypted database/key custody, private routing
and durable delivery. Public web search alone does not sign in to websites.

Keep the original conversation visible while private access opens separately.
Passwords and verification codes belong only in the authenticated private form.
Registered browser requests retain their exact provider request ID and native job
requirement. Submitting a response resumes that job; the user does not restate the
task. A waiting job is not completed work. A screenshot or successful page load is
not proof of the correct account or requested result.

Mount private GET/POST routes before body capture, transcript capture and APM
request logging. Derive the public origin from the declared runtime contract and
scope from the current application session. Preserve the SDK's CSP, no-store,
no-referrer and CSRF handling. Unauthenticated GET may enter normal application
sign-in with an exact allowlisted return path. Unauthenticated POST fails without
replaying its body. Do not copy application cookies into URLs or other browsers.

`createAgentConversationContinuation` in `server/application` connects a verified
private answer to the existing durable conversation writer. Supply the current
turn store, event store, runtime inspect and fresh authorization for the exact
job/conversation/turn binding. After the SDK resumes the verified requirement,
reactivate the saved chat turn and wake its existing authenticated writer. Run this
bridge before preparing hosted input from a waiting conversation as needed.
Do not create a second user message, job, native proposal or inferred approval.

Render secure links from persisted `interactionNotices`. Mobile clients open only
the configured application's HTTPS private-access route in the platform browser;
their normal login must retain the exact return destination. Returning from that
browser is not evidence that the provider's verification completed. Household
account sharing requires explicit application scope policy.

Install the SDK from its public HTTPS Git repository at a full committed SHA with
the matching package-manager lockfile. Compilation remains in normal dependency
installation. No Chromium download, local browser installation, browser OS packages
or SDK packaging step is required. Use the normal SDK PostgreSQL migration path;
HTTP requests do not run migrations. Reuse declared application web/worker services
and existing Mobile Preview for mobile QA.

Before declaring a consumer delivered, verify its installed revision, fresh
application authority, private form protections, encrypted custody, same-job
continuation, original session recovery, Stop/cleanup and browser-disabled behavior.
Open a real website, retain the actual screenshot/artifact, deliver it to the
originating conversation and perform a follow-up using retained context. Fixture
success does not establish a production website login or deployed consumer result.
