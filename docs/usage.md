# Agent usage delivery

`handrail-agent-sdk/server/usage` owns the model wrapper and the existing
Handrail telemetry client/outbox integration. It has no dependency on the
separate Assistant SDK. Configure the client from the declared server runtime
environment; provider credentials and the Handrail telemetry token stay on the
server.

```ts
import {
  createAIRuntimeUsageClientFromEnv,
  createAIRuntimeUsageReceiptSink,
  createUsageTrackedAgentModel,
} from 'handrail-agent-sdk/server/usage';

const client = createAIRuntimeUsageClientFromEnv(process.env);
if (!client) throw new Error('Configure the declared Handrail usage capability');
const sink = createAIRuntimeUsageReceiptSink(client, persistence.usageOutbox);
const model = createUsageTrackedAgentModel({
  model: providerModel,
  settlementOwner: 'application',
  sink,
  scope: {
    conversationId, turnId, logicalRequestId, traceId,
    providerId, modelId, attribution: trustedContext.attribution,
  },
});
// Supply model to createAgentRuntime for this immutable conversation turn.
// Drain pending receipts at startup and from the host's existing retry worker.
await sink.flush();
```

`persistence.usageOutbox` can be the consolidated application gateway's
PostgreSQL outbox. Its table and receipt schema are unchanged, so existing
queued receipts can still be delivered. `createHandrailAssistant` already owns
the configured usage retry worker; use that worker when composing the gateway
instead of starting a competing lifecycle. Standalone agents can use the
exported `createAIRuntimeUsageDelivery` with their durable outbox and manage its
startup/shutdown explicitly.

Bind one wrapper to one immutable turn and its server-derived attribution.
The wrapper captures each ordinary or streamed model completion before exposing
that completion to the caller. It requests preserved raw provider usage and
keeps unknown quantities distinct from reported zero. Custom model adapters can
provide `projectUsage` for other raw usage formats. Provider cost remains
unavailable unless supplied through a separate authoritative integration;
this wrapper does not estimate prices or settle bills.

The provider response identity and trusted turn scope determine the receipt ID.
Retries of delivery retain the saved receipt; a new provider invocation is not a
delivery retry. Failures, cancellation and truncated streams without terminal
provider evidence record unavailable usage. A persistence failure propagates
without replaying the provider or substituting a second receipt. Process loss
before the durable write cannot be reconstructed by this wrapper and must not
be reported as measured usage.

Set `settlementOwner: 'handrail'` when the managed provider already reports
usage. The wrapper then returns the model unchanged and sends no additional
receipts. Do not wrap a model twice or keep an application-owned usage wrapper
around this one. Agent checkpoint totals and UI usage events are observations,
not another per-invocation billing source.

The gateway receives only normalized receipts at `/api/ai-usage/v1/receipts`.
Prompts, model output, raw provider payloads, tool arguments and credentials are
not copied into receipts. Delivery authorization, settlement and resource
provisioning remain governed by the existing Handrail capability contracts.

Tests: `npm run test:usage` covers streamed and ordinary responses, reported
zero, unavailable usage, failure/cancellation, persistence failure, trusted-scope
isolation, managed-settlement suppression and retry after a lost gateway reply.
