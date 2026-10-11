# Consolidated assistant source provenance

The Agent SDK now owns the application gateway, clients, React presentation and Flutter packages. The initial import preserves their existing wire and persisted-data formats.

- JavaScript source and regression tests: `handrail-sdk-ai-assistant-js` commit `41de2dd3c23517311d83734481825805b102e099`.
- Flutter packages: `handrail-sdk-ai-assistant-flutter` commit `71854eb568dd546477eee6c780063f1ce7791f19`.
- Original copyright: Handrail, all rights reserved; proprietary source.

JavaScript consumers replace `@handrail/ai-assistant[/subpath]` with `handrail-agent-sdk/assistant[/subpath]`. Existing Agent SDK entrypoints retain their meanings. Flutter packages are `packages/handrail_agent_client` and `packages/handrail_agent_widgets` in the Agent SDK repository; public Dart class names remain unchanged. Neither package depends on the legacy Assistant SDK.

This is source consolidation in progress, not evidence of published or deployed consumer adoption. Consumer Git revisions and lockfiles must move only after qualification and publication. Usage model integration, provisioning, consumer migrations and full release acceptance remain outstanding.
