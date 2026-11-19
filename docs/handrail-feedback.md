# Handrail Feedback

Handrail Feedback is an optional server feature for an application's signed-in assistant. Each configured reporter exposes submit, list own, lookup own, answer, follow_up and stop_follow_up. The server discovers availability using the current application session. The connector is pinned in the SDK lockfile. Handrail Platform MCP, including developer work requests and staff operations, has a separate authorization boundary.

## Composition

```ts
import { createHandrailFeedback } from "handrail-agent-sdk/assistant/server/feedback";
import { createHandrailAssistant, openaiResponses } from "handrail-agent-sdk/assistant/server/assistant";

const feedback = createHandrailFeedback({
  installationId: "keystone", persistence: persistence.persistence,
  runtime: { projectId, serviceEnvId, environment: "dev" },
  reporters: loadServerReporters,
  currentSession: resolveCurrentApplicationSession,
  authorize: checkFeedbackPermission,
  resolveIntent: resolveExplicitMessageIntent,
  authorizeDelivery: checkSavedConversationAccess,
});
const assistant = await createHandrailAssistant({
  id: "keystone", persistence, feedback,
  authorize: authorizeAssistantRequest,
  authorizeConversation: checkConversationAccess,
  toolPolicy: existingToolPolicy,
  provider: openaiResponses({
    model, // host's Responses model; supply OPENAI_API_KEY on the server
    savedConversation: { fileTools: false },
    functionStrict: false, supportsToolSearch: false, maximumEagerTools: 12,
  }),
});
```

This feedback-only example projects all twelve functions eagerly. Responses strict mode requires every property in the schema to be required. Submit, list and answer have optional fields, so set `functionStrict: false` on this provider. The setting applies to every function on that provider. SDK registration, argument checks and host authorization still apply. For a mixed catalog, size `maximumEagerTools` for all eagerly exposed functions (including file or business tools), or configure supported tool search and namespaces. The SDK's provider defaults are unchanged.

Supply a stable installation ID and the exact registered project, web service environment and environment name. The supported environment names are dev, staging and production. Enable the feature only in the intended host composition. The server resolves credentials afresh. The bug configuration takes apiBaseUrl and reportToken. Enhancement takes apiUrl, capabilityId and token. Omit an unconfigured reporter. Pass no credentials to the model, browser, saved turn context or SDK database.

The currentSession callback returns tenantId, scopeId, principalId and the fresh sessionToken from the host's trusted session resolver. The authorize callback takes context, report kind, operation, abort signal and optional conversation ID. Check current tenant membership and permissions on discovery and again at execution. When a conversation ID is present, check access to that conversation. resolveIntent must bind the operation to the explicit user request in trusted conversation history, stable across retries and distinct for separate intentions. For an answer, verify that the selected option and/or text reflect what the user actually said. For follow_up, verify explicit consent. Existing assistant policy and approval decisions still apply.

authorizeDelivery(watch, signal, transaction?) checks the current account, tenant, reporting permission and the original active conversation before delegated read and again before writing the notice. Use the supplied transaction for the delivery-time access check and lock the relevant membership and conversation rows against concurrent revocation. Return false for definitive denial and throw for a transient dependency failure. Implement cancellation-aware callbacks. SDK clear stops the old conversation's watches. Permanent deletion removes its saved watch, answer and follow-up documents.

## Receipts and freshness

Both answer operations require request_id and information_request_id, plus an exact offered option, written answer, or both. They look up the owned report at execution time. A saved, identical answer attempt can recover the canonical idempotent response for its original question even if a newer question is open. A different payload on the same intent conflicts. Inspect answered and resumption separately. The latter is resumed, queued, needs_recovery or unverified. Preserve an uncertain submit intent for authoritative reconciliation. A history list miss is insufficient evidence for a new submission. When a canonical receipt was saved before its conversation record, a successful shared-feature reconcile restores that record under current authorization. Follow-up still requires explicit opt-in.

Call feedback.status(context, conversationId, kind, reportId, signal) from an authenticated server route to read state and lastSuccessfulRefresh (epoch milliseconds or null). An available report has no active follow-up. Pending means the grant is awaiting confirmation. After a lost acknowledgement or restart, the worker reads the saved grant ID and exact binding under current authorization. An inconclusive read leaves it pending for the next sweep. Repeating the start while pending does not dispatch another grant. Following means a recent refresh succeeded. Stale means the worker has yet to refresh or its last success exceeds two minutes. Unavailable retains the prior success time after a temporary failure. Stopped, revoked and expired watches produce no notices. Use the host's existing assistant status treatment.

The assistant's recovery timer finds due watches across persisted installations after restart. Each sweep reads at most eight due records and schedules each completed read one minute later. PostgreSQL versions fence concurrent delivery. The question identity and displayed content drive duplicate suppression. When the server supplies current behavior, the notice shows it before the question and choices. A changed snapshot, its conversation event, unread activity and watch cursor commit together. The usual conversation history revision protocol catches reconnecting clients up on saved messages. A status transition that begins and ends between polls can be missed. Native MCP Events webhooks use a separate receiver. Await assistant.stopBackgroundWorkers() before closing the database.

## Existing installations

Existing createFeedbackTools callers keep the submit-only API and their approval behavior. Hosts can continue running their existing consumer until cutover. Use the same assistant persistence, tenant, scope, conversation IDs and conversation gateway. Preserve the original conversations and their event history.

For BBD and Spartan, pause and join the old feedback worker at cutover. Import *only* previously authorized active grants from trusted server persistence via feedback.adoptLegacyGrant(context, originalConversationId, grant, signal). The SDK checks the exact binding, live read receipt and access. An identical import is safe to repeat. Preserve the legacy rows until verified. The first SDK refresh can post a current-status notice because the legacy digest is not imported. Leave stopped, revoked and expired grants inactive. Existing report reads and answers use canonical ownership. Older submissions without a saved grant or SDK origin record can continue through the legacy host's follow-up flow; the SDK does not infer their original conversation from model input. For Traughber, supply the same callbacks using its assistant authorization and existing PostgreSQL composition. Remove duplicate host registration and polling only after verifying the new consumer.
