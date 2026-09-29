import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { pathToFileURL } from 'node:url';

// Frozen recipe boundaries, not a runtime registration or provider fact verifier.
// Changes require a new prerequisite review; the input cannot define its own allowlist.
const frozen = {
  "authority": {"ownerGoalId": "1b13c4ab-38c2-4d78-a5cb-238e2f257c62", "ownerTaskId": "7ccb807a-4e38-42c7-bf23-73d62adec118", "itemId": "10a00f02-f34d-4680-856c-a54c7a0687d5"},
  "tokenPolicy": {"class": "user", "requestedScopes": ["ads_read"], "implicitLoginPermission": "public_profile", "lifetime": "provider_metadata_and_finite_host_deadline", "extension": "valid_short_lived_user_token_server_exchange", "refresh": "no_background_refresh_contract", "reconnect": "human_reauthorization_then_fresh_verification", "revocation": "deny_immediately_and_invalidate_receipts"},
  "boundaries": {"browserFallback": "disabled_no_permitted_gap", "readiness": "fresh_scoped_api_receipt_only", "fixtureEvidence": "never_provider_proof", "originalIdentity": "preserve_job_task_native_route_action_operation_effect", "cancellation": "deny_dispatch_and_release", "expiry": "deny_and_reauthorize", "revocation": "deny_and_reauthorize", "scopeChange": "deny_no_silent_widening", "staleAnswer": "reject_revision_mismatch", "duplicate": "canonical_receipt_only_no_new_effect", "unknownExchange": "retain_original_unknown_effect_no_retry", "reconciliation": "qualified_domain_receipt_only_no_contract_transition", "secretOutput": "deny_including_errors_urls_traces"},
  "liveProofRequired": ["approved_account_environment_authority_mapping", "app_redirect_version_and_access_review", "current_host_sources_and_adapter_qualification", "installed_runtime_scoped_provider_receipts", "same_original_task_recovery_evidence"]
};

const operations = [
  {"id": "authorize", "capability": "meta.setup.consent", "method": "GET", "endpoint": "https://www.facebook.com/v25.0/dialog/oauth", "parameters": "response_type=code&scope=ads_read", "authorizationOwner": "user", "adapterRef": "marketing-agent", "prerequisiteRefs": ["app", "account", "access", "consent", "callback", "fences"], "sourceRefs": ["manual-flow", "authorization"]},
  {"id": "exchange", "capability": "meta.setup.exchange", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/oauth/access_token", "parameters": "authorization_code_private", "authorizationOwner": "host_authorization_owner", "adapterRef": "marketing-agent", "prerequisiteRefs": ["app", "account", "access", "consent", "callback", "custody", "fences"], "sourceRefs": ["manual-flow", "authentication"]},
  {"id": "extend", "capability": "meta.setup.extend", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/oauth/access_token", "parameters": "grant_type=fb_exchange_token", "authorizationOwner": "host_provider_owner", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "consent", "custody", "token", "fences"], "sourceRefs": ["long-lived"]},
  {"id": "inspect-token", "capability": "meta.setup.inspect", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/debug_token", "parameters": "input_token_private", "authorizationOwner": "host_provider_owner", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "custody", "fences"], "sourceRefs": ["manual-flow"]},
  {"id": "permissions", "capability": "meta.setup.permissions", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/me/permissions", "parameters": "none", "authorizationOwner": "host_provider_owner", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "custody", "token", "fences"], "sourceRefs": ["manual-flow", "revocation"]},
  {"id": "account-read", "capability": "meta.account.read", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/act_{ad_account_id}", "parameters": "fields=id,account_id", "authorizationOwner": "account_owner", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "access", "consent", "custody", "token", "fences"], "sourceRefs": ["ad-account", "authorization"]},
  {"id": "report-read", "capability": "meta.report.read", "method": "GET", "endpoint": "https://graph.facebook.com/v25.0/act_{ad_account_id}/insights", "parameters": "fields=account_id,impressions&date_preset=yesterday&level=account&limit=1", "authorizationOwner": "account_owner", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "access", "consent", "custody", "token", "fences"], "sourceRefs": ["insights", "account-insights", "authorization"]},
  {"id": "revoke", "capability": "meta.setup.revoke", "method": "DELETE", "endpoint": "https://graph.facebook.com/v25.0/{app_scoped_user_id}/permissions", "parameters": "none", "authorizationOwner": "user", "adapterRef": "marketing-provider", "prerequisiteRefs": ["app", "account", "consent", "custody", "token", "fences"], "sourceRefs": ["revocation"]}
];

const prerequisites = [
  {"id": "app", "owner": "host_app_owner", "sourceRefs": ["get-started", "manual-flow"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Registered developer/app, Marketing API and Facebook Login configured; approved HTTPS redirect exactly matched at authorization and exchange; app secret stays private."},
  {"id": "account", "owner": "account_owner", "sourceRefs": ["get-started", "authorization", "ad-account"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Approved mapping of tenant/user/project/account/environment/purpose to exact Meta ad account and app-scoped user; current role and read authority required."},
  {"id": "access", "owner": "meta_and_app_owner", "sourceRefs": ["authorization", "insights"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "ads_read permission access level and Marketing API Access Tier separately approved for this use case; review/business verification when required; no assumed sandbox."},
  {"id": "consent", "owner": "user", "sourceRefs": ["manual-flow", "revocation"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Human grants only requested permission; human handles login, MFA, checkpoint and consent; denial is a wait, never a bypass."},
  {"id": "callback", "owner": "host_authorization_owner", "sourceRefs": ["manual-flow"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "One-time state and callback bound to authenticated user, exact redirect, original work, challenge revision and expiry."},
  {"id": "custody", "owner": "host_vault_owner", "sourceRefs": ["authentication", "manual-flow"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Qualified encrypted Vault capture/use and redacted private executor required for app secret, code and tokens."},
  {"id": "token", "owner": "host_provider_owner", "sourceRefs": ["manual-flow", "access-tokens", "long-lived", "revocation"], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Verify USER type, app/user binding, current validity, granted ads_read and actual expiration; token presence is insufficient."},
  {"id": "fences", "owner": "host_job_owner", "sourceRefs": [], "localRefs": ["docs/connection-contract.md", "docs/agent-security-boundary.md"], "requirement": "Recheck canonical admission, grant and instruction revisions, cancellation, lease, expiry, revocation and scope at dispatch and release; preserve original work and effect identities."}
];
const adapters = [
  {
    "id": "marketing-agent",
    "seam": "marketing-sdk/server/agent.ts; AgentPort in ports.ts; service.ts callers unresolved",
    "qualification": "pending",
    "selected": false
  },
  {
    "id": "marketing-provider",
    "seam": "marketing-sdk/server/providers.ts; ports.ts and service.ts callers unresolved; native Vault custody candidate from M1 via SDK security document",
    "qualification": "pending",
    "selected": false
  }
];
const sources = {
  "insights": ["https://developers.facebook.com/docs/marketing-api/insights/", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights"],
  "get-started": ["https://developers.facebook.com/docs/marketing-api/get-started/", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started"],
  "authorization": ["https://developers.facebook.com/docs/marketing-api/access/", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization"],
  "authentication": ["https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication"],
  "manual-flow": ["https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/", "https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow"],
  "access-tokens": ["https://developers.facebook.com/docs/facebook-login/guides/access-tokens/", "https://developers.facebook.com/documentation/facebook-login/guides/access-tokens"],
  "long-lived": ["https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/", "https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived"],
  "revocation": ["https://developers.facebook.com/docs/facebook-login/permissions/requesting-and-revoking/", "https://developers.facebook.com/documentation/facebook-login/guides/permissions/request-revoke"],
  "ad-account": ["https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account"],
  "account-insights": ["https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights", "https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights"]
};

// This validator consumes decoded JSON only. Reject accessors and hidden payloads
// before reading fields; error results never echo input or raw exception text.
function data(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (array && (value.length > 256 || keys.length !== value.length + 1)) return false;
  const ok = keys.every(key => {
    if (array && key === 'length') return true;
    if (typeof key !== 'string') return false;
    const d = descriptors[key];
    return d.enumerable && 'value' in d && (!array || /^(0|[1-9][0-9]*)$/.test(key)) && data(d.value, seen);
  });
  seen.delete(value);
  return ok;
}
const keys = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && same(Object.keys(v).sort(), names.split(' ').sort());
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 1500;
function require(value, code) { if (!value) throw new Error(code); }

/** Deterministic table shared with the document consistency check. */
export function recipeTable(m) {
  return ['| Operation | Capability | Request | Authority owner | Candidate seam | Prerequisites | Public sources |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...m.operations.map(o => `| ${o.id} | ${o.capability} | ${o.method} ${o.endpoint}; ${o.parameters} | ${o.authorizationOwner} | ${o.adapterRef} (pending) | ${o.prerequisiteRefs.join(', ')} | ${o.sourceRefs.join(', ')} |`)].join('\n');
}

/** Source consistency only; cannot authenticate facts or enable a provider path. */
export function validateMetaRecipe(m, document) {
  let code = 'invalid_manifest';
  try {
    require(data(m), code);
    require(keys(m, 'schemaVersion recipeVersion provider status graphApiVersion reviewedAt authority provenance publicSources tokenPolicy account adapters prerequisites operations boundaries liveProofRequired minimumCapabilities'), code);
    require(m.schemaVersion === 1 && m.recipeVersion === 'meta-v1.2026-09-28' && m.provider === 'meta'
      && m.status === 'documentation_only' && m.graphApiVersion === 'v25.0' && m.reviewedAt === '2026-09-28', code);
    code = 'invalid_authority'; require(same(m.authority, frozen.authority), code);
    code = 'missing_provenance';
    const p = m.provenance;
    require(keys(p, 'kind sdkBaseCommit branch localSources hostSource') && p.kind === 'source_review'
      && p.sdkBaseCommit === '34a21d6673d940bd59fb9800d4ddeef6b3d7e051' && p.branch === 'lane/agent-sdk-v1', code);
    const paths = ['docs/connection-contract.md', 'src/contracts/connection.ts', 'docs/agent-security-boundary.md', 'fixtures/convergence-v1.json'];
    require(Array.isArray(p.localSources) && same(p.localSources.map(s => s.path), paths)
      && p.localSources.every(s => keys(s, 'path sha256') && digest(s.sha256)), code);
    const h = p.hostSource;
    require(keys(h, 'status projectId repoId currentRevision dirtySourceDigests inventoryWorkRequestId reportedInventoryBaseline reportedInventorySha256 unresolvedPaths reason')
      && h.status === 'unavailable' && h.currentRevision === null && h.dirtySourceDigests === null
      && h.projectId === '07b11eec-aac0-4ec4-a1a6-d5be88b41948' && h.repoId === '4d92b94f-7234-4318-99ab-c19b0bb65855'
      && h.inventoryWorkRequestId === 'c08b2fdf-888d-4d37-bc75-26f66a2c48c0'
      && h.reportedInventoryBaseline === '847c632b0718f52669f5adcbf3a377d6d0b4187e'
      && h.reportedInventorySha256 === 'b1bd9b24fee983cb2dc03b26e5a25f42fac72900f68408d47b381eac86ca122b'
      && h.reason === 'source_reader_inherits_sdk_lane'
      && same(h.unresolvedPaths, ['docs/agent-sdk-native-ownership.md', 'marketing-sdk/server/agent.ts', 'marketing-sdk/server/providers.ts', 'marketing-sdk/server/ports.ts', 'marketing-sdk/server/service.ts', 'actual Marketing SDK callers']), code);
    require(Array.isArray(m.publicSources) && m.publicSources.length === Object.keys(sources).length
      && new Set(m.publicSources.map(s => s.id)).size === m.publicSources.length, code);
    for (const s of m.publicSources) require(keys(s, 'id url retrievedUrl reviewedAt sha256 httpStatus')
      && same(sources[s.id], [s.url, s.retrievedUrl]) && s.reviewedAt === m.reviewedAt && digest(s.sha256) && s.httpStatus === 200, code);
    code = 'unsupported_token_policy'; require(same(m.tokenPolicy, frozen.tokenPolicy), code);
    code = 'guessed_account_readiness';
    require(keys(m.account, 'status reference environment authorityRef ready metadataSearch') && m.account.status === 'unresolved'
      && m.account.reference === null && m.account.environment === null && m.account.authorityRef === null
      && m.account.ready === false && text(m.account.metadataSearch), code);
    code = 'unqualified_adapter';
    require(same(m.adapters, adapters), code);
    code = 'invalid_prerequisite';
    require(Array.isArray(m.prerequisites) && m.prerequisites.length === prerequisites.length, code);
    for (const [i, p] of m.prerequisites.entries()) {
      require(keys(p, 'id owner sourceRefs localRefs requirement') && text(p.requirement), code);
      require(same(p, prerequisites[i]), code);
    }
    code = 'unsupported_operation';
    require(same(m.minimumCapabilities, ['meta.account.read', 'meta.report.read']), code);
    require(Array.isArray(m.operations) && m.operations.length === operations.length, code);
    for (const [i, o] of m.operations.entries()) {
      require(keys(o, 'id capability method endpoint parameters authorizationOwner adapterRef prerequisiteRefs sourceRefs enabled') && o.enabled === false, code);
      const { enabled, ...mapping } = o;
      require(same(mapping, operations[i]), code);
    }
    code = 'unsafe_boundary'; require(same(m.boundaries, frozen.boundaries), code);
    code = 'missing_live_prerequisite'; require(same(m.liveProofRequired, frozen.liveProofRequired), code);
    if (document !== undefined) {
      code = 'document_mismatch';
      require(typeof document === 'string' && document.includes(recipeTable(m))
        && document.includes(`Recipe version: \`${m.recipeVersion}\``)
        && document.includes(`Graph API pin: \`${m.graphApiVersion}\``), code);
    }
    return { ok: true, operationCount: operations.length, proof: 'recipe_consistency_only' };
  } catch { return { ok: false, code }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const manifest = JSON.parse(readFileSync(process.argv[2] ?? new URL('../docs/providers/meta-v1.recipe.json', import.meta.url), 'utf8'));
    const document = readFileSync(new URL('../docs/providers/meta-v1.md', import.meta.url), 'utf8');
    result = validateMetaRecipe(manifest, document);
  } catch { result = { ok: false, code: 'manifest_read_failed' }; }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
