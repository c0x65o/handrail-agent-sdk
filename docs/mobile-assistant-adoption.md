# Agent SDK mobile adoption

Install both native Dart packages from the public Agent SDK repository, using
one full published commit SHA for both and committing `pubspec.lock`:

```yaml
dependencies:
  handrail_agent_client:
    git:
      url: https://github.com/c0x65o/handrail-agent-sdk.git
      ref: 2d0d1ff54a65b1d8ce52c7a017c09b16300955d2
      path: packages/handrail_agent_client
  handrail_agent_widgets:
    git:
      url: https://github.com/c0x65o/handrail-agent-sdk.git
      ref: 2d0d1ff54a65b1d8ce52c7a017c09b16300955d2
      path: packages/handrail_agent_widgets
```

This is the published 0.3.1 baseline. Later local fixes require a new published
SHA; see [qualification and publication status](assistant-consolidation.md).
Remove `handrail_ai_client` and `handrail_ai_widgets` from the app manifest and
replace those package names in imports. Run normal `flutter pub get`; do not
use dependency overrides or copy the shared client/UI into the application.
Public Dart class names and stored conversation identities remain compatible.

Use one account controller and draft controller per authenticated account/API
realm. The host supplies authenticated transport, encrypted pending storage,
immutable business request context and domain review. The SDK supplies history,
admission, recovery, Send/Stop, attachments and approval controls.

```dart
import 'package:handrail_agent_client/handrail_agent_client.dart';
import 'package:handrail_agent_widgets/handrail_agent_widgets.dart';

// After the host creates its authenticated client and account-scoped store:
late final HandrailComposerController drafts;
final assistant = HandrailAssistantController(
  client: client,
  pendingStore: accountStore,
  clientId: 'my-project-mobile',
  beforePendingRecovery: (id) => drafts.capturePendingAcceptance(id),
);
drafts = HandrailComposerController.forAssistant(assistant.uiBinding);

// Within a bounded Flutter view:
HandrailAssistantWorkspace(binding: assistant.uiBinding, drafts: drafts);
```

Retain these controllers when the view closes. At account teardown, dispose
`drafts`, await `assistant.dispose()`, then close the host-owned transport.
Preserve existing account/API storage namespaces during package migration so
pending messages and decisions remain recoverable. Closing the sheet does not
cancel server work. Stop requests canonical cancellation; uncertain delivery
keeps the saved operation identity for retry.

Use workspace `captureContext` and `buildRequest` for immutable business context,
`approvalReviewBuilder` for already validated domain review, and protected service
adapters for existing file/transcription routes. UI visibility never grants
server permission. Keep provider and telemetry credentials on the server. The
server reports actual usage through its durable outbox; the mobile client does
not submit duplicate billing receipts.

See the [client API](../packages/handrail_agent_client/README.md),
[optional widgets](../packages/handrail_agent_widgets/README.md),
[approval/deletion/voice contracts](flutter-contracts.md), and
[server setup](setup.md). Local widget and protocol tests do not establish native
device audio, hosted Mobile Preview or production acceptance.
