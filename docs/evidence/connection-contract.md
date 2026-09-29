# Connection contract acceptance evidence

Date: 2026-09-27. Selected Owner Task item: `cf9d0eea-9715-4732-9975-37b5f98b6a93`; task `7ccb807a-4e38-42c7-bf23-73d62adec118`; goal `1b13c4ab-38c2-4d78-a5cb-238e2f257c62`; work request `28a7b65e-f564-43f4-aaba-16459c91d7c3`.

## Checkout and authority

- Workspace: `/opt/handrail/repos/handrail/handrail-agent-sdk/.handrail/worktrees/convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e/handrail-agent-sdk`.
- Branch: `lane/agent-sdk-v1`; HEAD: `c32b6ac702bc324192e28dd0e112b1ad5890d416`, verified before editing and after testing.
- Initial `git status --short`: empty. Changes below are intentionally uncommitted; no version bump, commit, push or PR.
- `handrail_current_context` confirmed the project, lane, work request, goal and task above. The selected item was marked running with `handrail_owner_task_update_item`; progress recorded passing acceptance checks.
- Read published KB `handrail-ai-sdk-implementation-contract`, revision 1, entry `664f7487-aeda-476a-8aed-35d93426b07b`; applied host authority, scoped authorization and stable execution identity with the stricter Agent secret-output policy.

## Changed files

| File | Change |
| --- | --- |
| `src/contracts/connection.ts` | Readonly ensure input/results, ten states, typed requirements, bound API evidence, expiry/revocation, explicit provenance, unknown effects and pure input/result/reconnect validation |
| `src/index.ts` | Public contract/validator export |
| `tests/contracts/connection.test.mjs` | One focused table-driven synthetic contract suite |
| `package.json` | Include connection suite in ordinary test command |
| `tests/packaging.test.mjs` | Root export/import-graph checks and private connection implementation path |
| `tests/fixtures/consumer.mts` | Compiled declaration consumption, readonly/discriminant checks and required evidence/reconciliation fields |
| `docs/connection-contract.md` | Contract semantics, host duties, safe reconnect and structural-verification limits |
| `docs/evidence/connection-contract.md` | This acceptance record |

## Executed checks

Environment: Node `v22.23.1`, npm `10.9.8`, repository TypeScript `5.9.3`. Checks ran sequentially using the existing compiled-dist/package-name convention and test concurrency 1.

| Exact command | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Exit 0; no diagnostics |
| `npm run build` | Exit 0; declarations and JavaScript compiled |
| `node --test --test-concurrency=1 --test-reporter=tap tests/contracts/connection.test.mjs` | Exit 0; 63 passed, 0 failed, 0 skipped |
| `npm test` | Exit 0; pretest build and 130 tests passed, 0 failed, 0 skipped; includes connection, existing job and packaging/consumer regression checks |
| `git diff --check` | Exit 0; no whitespace errors |

Coverage includes both provenance modes in all ten states; every evidence scope dimension; wrong provider/account/prerequisite/capabilities; expired and revoked readiness; future/expired evidence; browser-login/token-presence/setup-grant substitutions; fixture-to-provider promotion through reconnect, intermediate waits and replay; changed receipt content; every original request/identity leaf; retained unknown effects; typed wait requirements; immutable inputs; nested unknown fields, malformed collections, accessors, raw errors and bounded non-echoing validation failures.

No unrelated pre-existing failures were observed. This is pure structural contract verification with synthetic identifiers and receipts, including synthetic provider-shaped receipts. No database harness is required or used; no persistence, live provider facts, Marketing integration, browser execution, runtime service, deployment or cross-process recovery is proven. Trusted hosts must authenticate receipt provenance and current authority. Those runtime/integration checks remain assigned to separate checklist items; they do not block this scoped contract acceptance.
