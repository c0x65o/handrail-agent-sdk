# Agent SDK distribution

The former `consumer-distribution/agent-sdk` directory was an unconsumed static
candidate containing copied contracts. The canonical root is now the single
public HTTPS Git install path and includes the Agents runtime. The copies were
removed to prevent installing an admission-only package by mistake.

See [README](../README.md) for exact-SHA installation and
[the runtime guide](agent-runtime.md) for exports and host responsibilities.
Anonymous Git access to the root repository and the pre-change committed package
are checked separately from the uncommitted implementation. Only the delivery
pipeline can produce the new immutable SHA; its installed-runtime verification
must run after push. No separate packaging or publishing workflow is introduced.
