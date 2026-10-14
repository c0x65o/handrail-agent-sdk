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

For hosts using the SDK's application conversation gateway,
`PostgresLiveConversationQueue` provides durable spoken-input admission. Supply
native transaction authorization, a clear-generation identifier, a prepared
`ChatRequest`, and a callback that starts the exact retained submission through
the existing authenticated gateway. Queue admission and canonical event
publication are transactional. Active text turns are preserved. Bind the existing
hosted worker's `AgentHostedHarness.activeInputs` to the queue's
`activeInputs(canonicalTurnId, nativeJobId, acceptOrigin)` to deliver new speech
while that work runs. The host authenticates the exact job and selects compatible
speaker/privacy origins from native state. Without that binding, speech remains
queued until the active turn settles. Retry uses retained identities.

The worker journals each input before provider IO and waits for its exact saved
user-item receipt. HTTP acceptance stays pending until that receipt exists.
`received` publishes one canonical user message and retains the original native
turn; `inputOrigins` exposes all attached voice origins for activity projection.
`defer` keeps the original input queued if the provider turn already finished or
has a pending action. Native approvals are never answered by steering. The SDK
does not classify speech or add another model loop: it sends new input to the
existing OpenAI session. If completion races input, the same worker follows the
receipted successor provider turn and accounts for both turns' usage. Results
before the latest received input are not presented as its final answer.

Hosts must supply idempotent claim/receipt/defer callbacks and keep canonical
job authority stable through them. A cancelled job must not leave its claimed
input runnable under another job. Cancellation observes the exact pending input
without sending unsent work; an unresolved provider receipt remains unconfirmed.
Audio End remains independent of these native work controls.

The host schedules `drain()` independently of audio and wakes pending queues
on fresh authenticated traffic after restart. `pendingConversations()` discovers
only identities; every content read and execution still requires native
transaction authorization. No bearer credentials are retained. `turnOrigin()`
returns trusted host-authored voice context for policy, never model metadata.
Queue records use the canonical conversation scope and are covered by its
existing permanent-deletion path. A changed clear-generation cancels old queued
speech. A host must enforce original start-request equality for a queued turn.

Saved voice ingress releases its ordering slot when a canonical turn is waiting
for approval and has released active execution. The original approval and result
remain on that turn; a follow-up never approves it. A rolled-back canonical
revision conflict retries from the new head, preserving the original input key.
`PostgresRealtimeToolActivityStore.projectCanonical` lets an authorized host
project native tool receipts after audio termination. Verify the saved turn's
voice origin and event provenance before projecting; these display records never
authorize or repeat tool execution and do not establish playback.

Native bindings can use `beforeConnect(scope)` to atomically claim provider
creation after context checks. An End received during that claim settles without
provider IO. `enqueue` may return `{handled: 'answer' | 'clarify' | 'silence', reply}`
when native policy determines no work should be admitted. The SDK delivers that
answer without fabricating a queue receipt; intent and permission remain native.

A host that keeps a durable call lifecycle should claim provider creation from
`beforeConnect`, after context authorization has succeeded. Startup authorization
must allow its owned pending call; an active provider identity is required when
admitting speech, not before creating that provider session. A definite HTTP
creation rejection is reported as `LiveTransportError.creationOutcome ===
'not_created'`. Only that provider evidence can settle a started call with no
provider identity (`PostgresRealtimeCallStore.confirmCreationRejected`, using the
original worker). Timeouts, interrupted requests and missing receipts remain
uncertain. This does not authorize repeating the same call identity.

Active hosted input is observed at least every 500 ms while its worker is listening, even when the host uses a slower recovery polling interval. Provider acknowledgements and currently executing native actions still determine when the correction can take effect.

Active speech custody transfers atomically out of pending ingress to the original native worker at claim time. The durable claim survives worker reconstruction; a provider receipt projects the user transcript once. Deferral restores the same FIFO entry, while Stop settles claimed speech with its original job. Overlapping application versions cannot re-admit claimed speech from the pending ingress head.

The shared Live prompt explicitly delegates corrections to already-running tasks, including answer format changes. Live client delegation does not implicitly forward subsequent speech. The host still supplies domain instructions, and native authorization and approval checks remain in the saved agent. See https://developers.openai.com/api/docs/guides/live-prompting#delegation.
