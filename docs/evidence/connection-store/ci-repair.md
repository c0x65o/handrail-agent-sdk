# Disposable PostgreSQL CI repair

Same work request `b0cd16f7-dbcc-405a-b0d1-9110d30cca4b`, selected item `26112afc-09aa-42d2-8ec9-df98a00b07e7`. Repair baseline remains `e3c0e6d5790cf02fcd9fbc005c705d09148ba3e3` on `lane/agent-sdk-v1`. The existing connection-store candidate was present and uncommitted at repair admission. Current-context MCP confirmed the same project, lane, goal and task. Native workflow retains publication ownership.

Post-change check `59ec22ae-e990-4562-8160-6d2c1d410fe5` failed running `node tests/run-local-postgres.mjs`. Its truncated output omitted the failing middle section. A focused real PostgreSQL reproduction, `node tests/run-local-postgres.mjs test:vault-lifecycle`, exited 1: 17 passed, 1 failed, 0 skipped. The failure was `one-time generated upgrade preserves existing v1 envelopes and initializes their durable fence`; saved redacted receipt: `ci-repair-before.txt`.

That test reconstructs a pre-lifecycle schema by dropping later objects and rewinding the migration ledger. It omitted the three newly introduced connection tables, so forward migration replay collided with existing objects. The only code repair adds those three drops in foreign-key dependency order inside the owned disposable fixture and updates its comment. No runtime implementation, migration, assertion or error-redaction boundary changed. All original `candidate.json` file hashes remain identical.

The repaired focused command exited 0: 18 passed, 0 failed, 0 skipped. `ci-repair-focused.txt` retains the receipt. This verifies preserved v1 ciphertext, initialized lifecycle fences, private read and subsequent rotation through the real generated migration path. Compiles are checks, not test coverage.

Final commands, per-suite totals, source hashes and cleanup results are recorded in `ci-repair.json`; the full rerun receipt is `ci-repair-disposable-run.txt`. Evidence is synthetic disposable PostgreSQL only, with no live provider or installed-host QA claim. Source changes remain uncommitted.
