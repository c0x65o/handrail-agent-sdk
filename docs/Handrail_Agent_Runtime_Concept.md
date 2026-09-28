> Historical concept. The September 28, 2026 owner correction supersedes the payment-provider and no-card-custody assumptions below. Current v1 card scope is [secure Vault entry and scoped private fill](payment-vault.md), without charging or a provider prerequisite.

# Handrail Agent Runtime
## Concept note — September 23, 2026

**Status:** Product direction and implementation proposal, not implemented or production-verified. Selected Handrail files were inspected through GitHub at revision `7bd945ddd410bf337be7a25cfbd9987cb0613b1b`. No repository changes were made.

## The idea in one paragraph

Build a small, reusable, model-agnostic AI agent runtime that can use a browser, securely use authorized credentials, establish and maintain service connections, invoke application tools, preserve its work, and resume from a schedule or event. Package it behind an SDK so the same capabilities can power a standalone assistant, Handrail/Avery, HITCENTS ERP marketing, or an AI employee-management system. The human delegates the outcome and grants access; the agent performs the ordinary setup work instead of returning a checklist of developer-console instructions.

**The central product promise: an agent that can get itself set up to do its job, not merely operate tools after a human has connected everything.**

## Why this matters

Clinton's motivating experience is marketing setup. Adding a marketing capability to HITCENTS ERP involves connecting services such as Meta, LinkedIn, and Google. Once configured, the integrations can be useful; the painful part is the human labor of navigating accounts, collecting credentials, finding identifiers, configuring permissions, and reconnecting services.

Instinct is the experience reference: confident execution, browser access, a vault, and proactive follow-through. The goal is not to copy its consumer interface. It is to make comparable operating capabilities embeddable in our own products.

## Keep the core small

| Core capability | Required behavior |
|---|---|
| Browser and sessions | Navigate, read pages, use visual interaction when needed, fill forms, handle tabs and files, preserve account-scoped sessions, and provide human takeover and resume. |
| Vault and connection access | Securely capture and use passwords, API credentials, OAuth tokens, and supported authentication factors. Supply secret references to models, not plaintext. Track connection identity, permissions, expiration, and verification. |
| Extensible tools | Expose typed application actions through the SDK and/or MCP. Prefer native APIs for established operations; use browser execution for permitted setup, unsupported tasks, and recovery. |
| Durable work and context | Keep the original goal, task identity, current step, verified results, and unresolved blockers. Recover after a crash without asking the human to restate the request. |
| Schedules and events | Support one-time reminders, recurring work, event-triggered continuation, and agent-created follow-ups within delegated limits. Persist and deduplicate wakeups. |
| Authority, verification, and reporting | Enforce account/tool/action limits outside model prompts; check outcomes; bound retries and spending; request only necessary human intervention; report actual completion or a specific blocker. |

These are capabilities, not six new services. Initially, keep them as a narrow interface over existing components and one worker deployment where practical.

## An SDK needs a persistent execution host

An SDK makes these capabilities easy to embed, but an imported library cannot wake itself after the host application stops. The proposed packaging is:

- **SDK:** submit work, supply scoped tools and permissions, receive events, inspect status, answer an approval, and cancel or resume.
- **Persistent runtime:** maintain durable work records, process due jobs and incoming events, run browser sessions, and call the selected model provider.
- **Host adapters:** connect to Handrail's existing Task, approval, vault, and scheduling services when embedded there. A standalone host supplies the equivalent minimum persistence and worker facilities.

Do not add a second planner, campaign controller, or competing scheduler inside Handrail. Define one execution owner for each job and preserve the originating Objective/Task identifiers across handoffs.

## Make connection setup a first-class operation

A tool named `connect` should mean more than displaying documentation. Its contract should be to establish and verify a scoped connection, or return the exact outstanding requirement.

An illustrative lifecycle is:

`requested → inspecting → authenticating → configuring → verifying → ready`

A connection may temporarily enter `waiting_for_user` or `waiting_for_provider`. Existing connections can enter `reauthorization_required` without losing the task that needs them.

The operation should:

1. Check whether a suitable authorized connection already exists.
2. Reuse an approved OAuth application and the shortest supported consent path when available, rather than creating a new developer application for every customer.
3. Use browser automation for permitted administrative setup that cannot be completed through an API.
4. Capture newly issued secrets directly into the vault through a trusted capture operation, without displaying them to the model or placing them in chat.
5. Verify the intended organization, account, and required capabilities through the provider.
6. Save non-secret account metadata and scoped credential references.
7. Return a connection result and resume the exact original task.

Separate platform-level integration setup from customer-level authorization. A reusable OAuth integration should absorb work once where the provider supports that model; the customer should not repeat all platform engineering for each connection.

Browser authentication and API authorization are separate outcomes. Being logged into a site does not prove that the application has the API access needed for its requested actions. Provider review, account roles, consent, and access levels still need to be satisfied. Provider requirements must be versioned rather than embedded forever in a static setup script. For example, Google's current documentation says Google Ads developer tokens were sunset on September 9, 2026 and API access levels now follow the Google Cloud project used for OAuth credentials. [G1]

## Vault behavior: use secrets without showing them to the model

The model should request an operation such as “authenticate this authorized account” or “use the approved payment method,” referencing a vault item or connection. A trusted broker checks the task grant, account, destination origin, and operation, then performs secret entry or request signing. The result reports success, failure, or a human challenge—not the secret.

This is not merely a prompting convention. The browser executor must prevent secret-bearing values from returning through screenshots, page text, DOM reads, logs, network diagnostics, downloads, and error messages. Generated API keys require a protected capture path as well as a protected fill path. The model must not have unrestricted access to the broker, browser profile files, or raw debugging interfaces that undo those protections.

Keep browser cookies and refresh tokens within the same security boundary as passwords. Isolate sessions by tenant/account, control concurrent use, and support immediate revocation. Treat web pages as untrusted task data, not as a source of authority to grant new access.

For payment support, prefer provider-managed or tokenized payment methods and externally enforced limits where available. Giving a task access to a payment method does not automatically authorize a purchase. Purchasing authority should specify the permitted purpose, merchant where appropriate, and amount. The MVP does not need a home-grown card-number vault.

This pattern is already demonstrated commercially: 1Password's July 16, 2026 announcement describes an integration in which Claude requests a credential, the user approves biometrically, and 1Password handles entry without placing the password or one-time code in model context. It is not evidence that every website or unattended login will work, and the published flow still includes per-task approval. [V1]

## Behavior and human involvement

The desired behavior is **authorized execution by default**, not “refuse every login” and not “ignore every boundary.” Configure the agent to use its real, scoped capabilities and test unnecessary refusals as a product failure. Do not assume a prompt can override a model provider's restrictions or a service's access controls.

Human intervention should be reserved for the actual human-only step: required identity confirmation, a non-delegable authentication challenge, provider consent, missing authority, or a material action outside the task's approved limits. Preserve the session and job state while waiting, explain the precise step, and continue afterward. Do not turn one authentication prompt into a new planning session.

## Efficiency and reliability

Use an event-driven runtime rather than asking an expensive model every minute whether it should act. Store an agent-created wakeup in the scheduler; use provider callbacks when available and bounded polling otherwise. Each wakeup needs an owner, task reference, reason, due time/event, deduplication key, and cancellation behavior.

Prefer deterministic token refresh and existing native actions to repeated browser reasoning. Reuse verified procedures, but re-check page and account state before acting. Send bounded observations and a compact task checkpoint instead of the whole historical transcript on every step. Release idle browser compute where session restoration is safe.

Before retrying an external mutation after an uncertain response, reconcile the external state. A missing acknowledgment is not proof that a campaign, key, or purchase was not created. Use idempotency where supported and a clear unresolved-outcome state where it is not. Do not promise generic exactly-once browser actions.

Suggested minimal job states are `queued`, `running`, `waiting`, `succeeded`, `failed`, and `cancelled`, with a structured reason for waiting. Completion requires a checked outcome, not a model's claim that it clicked the right button.

## What the inspected Handrail code already contains

| Existing component | Observed in the repository | Implication |
|---|---|---|
| Vault-backed QA authentication | `src/server/services/pm/qa-vault-auth.js` has project/environment-scoped login profiles, secret references, and server-side credential resolution, including TOTP material. [H1] | Reuse the vault foundation, but do not equate QA login helpers with a complete general-purpose third-party connection broker. |
| Browser handoff | `src/server/services/dev-chat-production-browser.js` connects production-browser preparation with the vault-auth service. [H2] | Generalize the browser/session boundary rather than treating every browser task as QA. |
| Durable wakeups | `db/migrations/0546_owner_assistant_wake_schedules.sql` defines persistent wake/schedule records; team scheduling code uses the same table and deduplication checks. [H3, H4] | Adapt the existing scheduling owner rather than creating parallel wake loops. |
| Marketing providers | `owner-marketing/providers.js` lists Meta and LinkedIn capabilities and marks Google as future. [H5] | Provider capability should be explicit, not inferred from a successful login. |
| LinkedIn authentication | `owner-marketing/linkedin-client.js` contains OAuth credential requirements, token refresh, expiry handling, and retry after a rejected token. [H6] | Preserve native connection maintenance instead of asking a browser agent to reinvent refresh logic. |
| External-action recovery | `owner-marketing/task-provider-recovery.js` includes recovery paths for provider activation, pause, and budget actions. [H7] | Keep domain reconciliation with the domain service and resume the original Task. |

These are source observations, not a full security audit or proof of current production behavior. The proposed gap is a stable, reusable access-and-execution contract across these components, especially for third-party onboarding and connection recovery.

## Model and browser implementation direction

Instinct's official site describes a core model trained to use phones and computers. Its privacy policy also refers to third-party model providers and authorized credential use. The reviewed official materials do not identify the underlying base model or establish how its vault is implemented. Do not make a Chinese-model or policy-bypass claim without evidence. [I1, I2]

Keep the runtime provider-neutral. For the initial Handrail implementation, preserve the existing coordinator and integrate a bounded browser capability rather than replacing the entire agent harness.

Two concrete model paths worth evaluating are GPT-6 Astra and a supported Claude browser-use model, such as Sonnet 5 or Opus 5.5. OpenAI documents code-driven computer use and continued support for existing UI tools; Anthropic documents browser-specific tools with element-based interaction and visual fallback. These are candidates, not a measured ranking on Handrail workflows. [M1, M2]

Browser Use is also worth evaluating as a reusable browser adapter instead of writing every browser operation from scratch. Its documentation describes a CLI for existing agents, persistent login profiles, and domain-scoped sensitive-data handling. A documented secret-substitution mechanism is a starting point, not proof that arbitrary executor access cannot expose secrets. [B1, B2, B3]

Choose using repeated representative connection tasks now. Measure verified completion, human interactions, unnecessary refusals, latency, cost, leakage checks, and recovery after interruption. Do not select solely on a browser benchmark or a permissive-looking demo.

## First useful proof

**“Connect this authorized Meta account to HITCENTS ERP marketing, verify the required capabilities, then resume the original campaign task.”**

A satisfactory run starts with a missing connection—not a preconfigured test token. It obtains or uses an authorized session, pauses only for a genuine human requirement, persists the connection securely, verifies the intended account and access, and resumes the original work. Campaign preparation should retain existing review and delivery-approval rules; successful connection does not authorize ad spending.

Then repeat after a worker restart and after deliberate credential revocation. Verify that the system does not create duplicates, silently switch accounts, leak a secret, or abandon the original task. Count the human steps removed, not just tests passed.

After proving this slice, expose the same capability through the standalone SDK and a second host. Keep the browser/vault/job logic shared; keep marketing policy and campaign data in the marketing application.

## Non-goals for the first version

No new multi-agent hierarchy, replacement marketing planner, universal workflow language, model-training project, home-grown payment vault, or promise of unrestricted access to every website. Start with the handful of capabilities needed to complete one real connection-and-resume workflow.

**Success is not “the agent has a browser.” Success is “the human stopped being the integration technician.”**

## Sources

Reviewed September 23, 2026. Repository links are pinned to the inspected revision. Public documentation describes provider claims and supported interfaces; it does not prove a Handrail integration has been implemented.

- [H1] Handrail QA vault authentication: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/pm/qa-vault-auth.js`
- [H2] Handrail production-browser handoff: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/dev-chat-production-browser.js`
- [H3] Handrail wake schedules: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/db/migrations/0546_owner_assistant_wake_schedules.sql`
- [H4] Handrail team scheduler: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/owner-assistant-team-scheduler.js`
- [H5] Handrail provider registry: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/owner-marketing/providers.js`
- [H6] Handrail LinkedIn client: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/owner-marketing/linkedin-client.js`
- [H7] Handrail marketing recovery: `https://github.com/c0x65o/handrail/blob/7bd945ddd410bf337be7a25cfbd9987cb0613b1b/src/server/services/owner-marketing/task-provider-recovery.js`
- [I1] Instinct official product description: `https://instinct.com/`
- [I2] Instinct privacy policy, revised August 26, 2026: `https://instinct.com/privacy-policy`
- [V1] 1Password for Claude, July 16, 2026: `https://1password.com/blog/1password-for-claude`
- [M1] OpenAI computer-use documentation: `https://developers.openai.com/api/docs/guides/tools-computer-use`
- [M2] Anthropic browser-use documentation: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool`
- [B1] Browser Use integration approaches: `https://docs.browser-use.com/cloud/which-product`
- [B2] Browser Use persistent profiles: `https://docs.browser-use.com/cloud/guides/authentication`
- [B3] Browser Use sensitive-data handling: `https://docs.browser-use.com/open-source/examples/templates/sensitive-data`
- [G1] Google Ads developer-token migration: `https://developers.google.com/google-ads/api/docs/api-policy/developer-token`
