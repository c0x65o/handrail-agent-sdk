# Agent SDK Flutter contracts

These contracts belong to the moved native Dart packages. Current source,
installed-revision and hosted qualification are recorded separately in
[the consolidation work record](assistant-consolidation.md).

## Conversation deletion

`HandrailAssistantController.permanentlyDelete` binds a confirmed deletion to
one conversation and reviewed version. Preserve the account/API-scoped deletion
journal across package upgrades. Save the exact operation before dispatch and
reuse its identity after a lost reply or restart. Storage failure prevents
sending; a version conflict requires a new review. Permission changes are
rechecked and the gateway remains authoritative.

A verified receipt evicts that conversation's local catalog, session, activity,
draft and selected files. Late responses cannot restore the deleted identity.
This does not prove physical removal of external business files, host-owned
caches or settlement records. See the client README's permanent deletion section.

## Approval decisions

`assistant.approvals` owns canonical proposal review and exact-version decisions;
the workspace renders `HandrailApprovalDecisionsView`. Host review adapters must
validate conversation, proposal/version, turn, call, tool and argument reference
before constructing `HandrailApprovalReview.forProposal`. Incomplete review
cannot authorize a decision. Domain rendering formats validated data; it does
not replace server authorization or supply execution input.

Preserve the exact saved decision across uncertain delivery and restart. Account
or conversation changes invalidate stale review callbacks. Host permission
checks can restrict decisions but cannot grant authority denied by the gateway.
The approval preference on a message and a business approval are distinct;
hiding controls must not silently change either policy.

## Realtime voice

`HandrailRealtimeVoiceSurface<T>` supplies shared startup, status, mute, playback
recovery, Stop, close/Back and uncertain-end controls. The host supplies the
protected session gateway and business/speaker context. A UI flag cannot create
an absent live-call endpoint.

`HandrailWebRtcVoiceSession<T>` owns capture, peer/data-channel setup, playback
and teardown. Account replacement and background lifecycle fence late startup;
returning to the app does not automatically start another call. Pending remote
end acknowledgements retain their original identity. Follow the client and
widget README lifecycle APIs when integrating custom native routes.

Widget/platform-channel fixtures do not establish device microphone permissions,
audio playback or actual provider execution. Those require separate authorized
device and hosted validation.
