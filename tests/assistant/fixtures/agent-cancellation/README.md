# Agent cancellation fixture

This fixture now resolves the Agent SDK and its application gateway from the same package under test. It has no separate npm install or legacy Assistant dependency. Build the root package first. The Dart projection uses the package configuration from `packages/handrail_agent_client` after its normal `dart pub get`.

The PostgreSQL fixture must only run against the guarded disposable test database; it creates and removes its own schema. Historical mixed-version reproduction remains in the original Assistant repository.
