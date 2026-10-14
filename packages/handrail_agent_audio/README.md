# Handrail audio primitives

Optional microphone capture and authenticated transcription for custom Flutter shells.
Install this package from the public HTTPS SDK repository pinned to a full commit SHA.
It has no file picker, secure-storage, conversation UI or live-call dependency.

`HandrailPcmAudioRecorder` captures native/web PCM as WAV. `HandrailTranscriptionControl`
accepts the host's authenticated transcription callback and current text controller/scope.
Stop inserts into the latest draft for review; `GlobalKey<HandrailTranscriptionControlState>`
exposes `finish()` for finish-and-send. Submit only when it returns true and the current
host scope, permissions and attachments still permit sending. The host owns submission,
provider configuration and metering; capture, discard, stale-result exclusion and draft
insertion live here. The full optional composer uses these same primitives.

Declare microphone permissions in the native application. No provider secret belongs
in the client. Tests for capture and composer integration live in handrail_agent_widgets.
