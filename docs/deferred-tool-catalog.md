# Bounded deferred catalogs

`createDeferredToolDiscoveryPlan` and both OpenAI Responses provider entrypoints
accept the host-only `maximumTotalTools` option. It defaults to **256** and must
be a safe integer from **1 through 1024**. An oversized catalog fails before the
provider transport opens; it is never truncated. Invalid limits fail even for an
empty catalog. Provider invocations report failure through their existing stream
error path; the standalone planner throws `TypeError`.

Set the same explicit budget at every planner and provider construction site:

```ts
import { createDeferredToolDiscoveryPlan } from 'handrail-agent-sdk/assistant';
import { openaiResponses } from 'handrail-agent-sdk/assistant/server/assistant';

const maximumTotalTools = 512;
// authorizedTools must already be filtered for the current actor/capabilities.
// Namespace references at this standalone planner must also be authorized.
const plan = createDeferredToolDiscoveryPlan({
  tools: authorizedTools,
  namespaces: authorizedNamespaces,
  maximumTotalTools,
});
const provider = openaiResponses({
  model,
  namespaces,
  maximumTotalTools,
  supportsToolSearch: true,
  // Keep the host's existing request/authentication and other provider options.
});
```

The lower-level `createOpenAIResponsesProviderAdapter`, exported by
`handrail-agent-sdk/assistant/providers/openai`, accepts the same option. The
server provider forwards it on every invocation, including continuations and
saved-file requests, and includes it in durable request fingerprints.

The budget counts the complete authorized function catalog, including domain
tools, application auxiliary tools, and SDK-added tools such as
`handrail_files_list` and `handrail_files_open`. Hosted `tool_search` and
`web_search` entries are provider projections, not functions counted by the
planner. A fixture with 259 domain functions plus two application auxiliaries
needs at least 261; enabling the two saved-file functions needs at least 263.
Choose a bounded host budget with appropriate headroom (for example, 512).

`maximumEagerTools` remains independent, defaults to 16, and retains its existing
1–1024 validation. Configure deferred namespaces for large domain catalogs;
increasing the total budget does not increase the eager budget or enable tool
search. When tool search is unsupported or explicitly disabled, the existing
eager-only fallback remains in effect. Use the host's existing supported model
and provider configuration to expose the full deferred catalog. Existing schema
projection, schema validation, namespace membership, current actor/capability
filtering, execution authorization and approval policies remain in effect.

## Hitcents ERP adoption still required

This source repair does not update ERP or establish that its administrator
finance-ledger-discovery regression passes. That test and its actual failure
trace are outside this SDK checkout. SDK fixtures prove confirmed/rejected
approval handling, restart, continuation and retained catalogs, but do not
establish the cause of the consumer's ledger failure.

1. Let the authorized Handrail finalization step version, commit and push this
   SDK source. Obtain the actual available full commit SHA containing this fix;
   the inspected base `f8a57ed9be317814090eb4af378d4ea209385dab` is not corrected.
2. In a separately authorized ERP adoption step, pin
   `git+https://github.com/c0x65o/handrail-agent-sdk.git#<actual-full-commit-SHA>`
   and regenerate the matching package-manager lockfile. Use the normal install
   pipeline, whose `prepare` compiles the SDK. No registry publication, tarball,
   separate packaging step or `node_modules` patch is needed.
3. Set `maximumTotalTools: 512` (or another sufficient budget no greater than
   1024) on ERP's standalone planner calls and its actual Responses provider
   configuration. Preserve its namespace, eager limit and authorization setup.
4. From that installed revision, run ERP's complete native catalog regression
   and administrator finance-ledger-discovery approval regression. If the ledger
   failure persists after successful catalog discovery, investigate its actual
   trace separately; do not infer that catalog capacity explains it.
5. Keep dependency item `2cc53946-2851-4e77-9dab-b8e6d27c7133` unfinished until
   adoption and both regressions are proven. Existing Web Unit Tests item
   `a30d9713-fec4-4b28-8743-79c49d21ea42` owns the subsequent final-source full
   suite check; preserve its partial repairs and historical failures.
