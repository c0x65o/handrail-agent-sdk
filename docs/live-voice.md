# GPT-Live with the saved agent conversation

`handrail-agent-sdk/server/live` owns OpenAI GPT-Live session creation, sideband
transport, speech delegation, result delivery, final usage and audio lifecycle.
It uses the official OpenAI client and `SidebandWS`. `BrowserLiveCall` from
`handrail-agent-sdk/assistant/browser` owns microphone/WebRTC/playback lifecycle.
Both are headless. Projects keep their existing presentation and HTTP routes.

This is a client-delegation frontend to the existing saved agent. Its `enqueue`
port must admit work to the same durable conversation runtime that text uses.
Do not install a second tool loop for calls. Hosted browser, MCP tools, native
approvals, cancellation, work identity and backend usage stay with that runtime.
The Live voice frontend's seconds are a separate usage receipt.

## Server ports

Create `createLiveTransportConnector({client})` with the application's configured
OpenAI client. The connector carries its organization/project headers and does
not retry creation. Its `hangup(providerId)` method can terminate an original
provider ID retained by the host after process recovery. The SDK does not infer
that a successful hangup response contains final usage.

Supply `createLiveSessionService` with:

- `authorize`: current user/conversation access, called during startup, refresh
  and speech admission. Audio cannot authorize tools or relax native policy.
- `prepareContext`: authorized, redacted startup messages, a user-visible context
  update, a stable fingerprint and usage attribution. Use the canonical saved
  conversation, including text and results that preceded the call.
- `recordProviderSession`: save the original provider ID against the native call
  before the SDK attaches a work receiver.
- `transcripts.append/read`: store exact server-observed fragments idempotently
  by original event identity, and read all fragments in the requested sequence
  interval. The short client caption window is not admission evidence.
- `enqueue`: persist observed speech under the original call/delegation identity
  and return its durable queue ID. Invoke `validateCurrent` within the host's
  admission transaction. A failed receipt is not permission to resubmit using a
  new ID. Explicit pre-write rejection may carry `liveRejection: true`.
- `readResult`: read the original saved work's current result, rechecking access.
  Do not equate an accepted queue entry with completed business work.
- `recordUsage` and `onFinish`: retain cumulative voice seconds and whether the
  final provider event was observed, then finalize native history. Missing final
  usage is recorded as unconfirmed, never replaced with a guessed duration.
- `connect`, `instructions`, and optional result redaction and lifecycle timing.

The host must durably reserve each call request before invoking `create` and
reject a reused identity after process recovery. It must also reserve an end
request that arrives before creation. A voice request's authorization context
stays server-owned. The SDK's in-memory replay cache is not durable admission.

`close` requests termination; `end` also waits for final history/usage custody.
Ending audio does not cancel admitted agent work. `submit` is for authenticated
native UI selections such as reading a saved brief. These updates use null
OpenAI delegation IDs; only actual provider-issued delegation IDs are reused.

## Browser ports

Construct `BrowserLiveCall` with a native call `id`, authenticated `exchange` and
idempotent `end` callbacks. `exchange` receives an SDP offer and abort signal.
`end` returns `{confirmed: true}` only after the application's durable end receipt.
It must handle cancellation that outruns startup, using the same original ID.

Subscribe with `subscribe/getSnapshot` or `onChange`; call `start`, `mute`, `play`
(autoplay recovery), `stop`, and `dispose`. Capture stays disabled until both SDP
and `session.started` succeed. Stop releases local audio immediately. If the end
receipt is lost, state is `end_unconfirmed`; retry `stop` on that same object.
There is no automatic reconnect or second call creation.

Provider events are presentation-only. They never execute tools or establish
business outcomes. `addLiveCaption/groupLiveCaptions` are optional display
helpers; applications may instead page their authorized durable transcript.
`LiveOutputPlayback` requires measured local playout before reporting speaking.
It does not infer audible playback from captions or received packets.

## Verification status

The focused `npm run test:live` suite exercises the actual OpenAI HTTP/WebSocket
clients against a local server and the runtime/browser state machines against
controlled ports. These tests do not prove real-provider quality, microphone
hardware behavior or a consumer deployment. Consumer integration and supported
environment verification remain separate release acceptance steps.
