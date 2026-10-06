import { createHash } from 'node:crypto';
import { createMetaVaultExecutor } from 'handrail-agent-sdk/server/marketing';
export const clone = v => structuredClone(v);
export const identity = { jobId: 'marketing-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'report' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' } };
export function binding() {
  const effect = { effectRef: 'exchange-effect', actionRef: 'consented-action', operationRef: 'meta-exchange' };
  const connection = { operation: 'connection.ensure', identity: clone(identity), connectionRef: 'meta-connection', providerRef: 'meta',
    prerequisiteVersion: 'meta-v1.2026-09-28', minimumCapabilities: ['meta.account.read', 'meta.report.read'], evidenceMode: 'fixture', effect };
  const destination = { endpoint: 'https://graph.facebook.com/v25.0/act_123/insights', method: 'GET', resourceRef: 'account', redirects: 'deny' };
  return { qualification: 'synthetic', action: 'exchange_code', recipe: { connection, provider: 'meta', appId: '456',
    appScopedUserId: '789', adAccountId: '123', permission: 'ads_read', destination, apiVersion: 'v25.0',
    redirectUri: 'https://host.invalid/private/meta/callback', expiresAt: 200_000 },
  request: { operation: 'server_request', identity: clone(identity), jobRevision: 2, grantRef: 'grant', grantRevision: 1,
    effect: clone(effect), item: { metadata: { kind: 'token', tokenType: 'api' }, reference: { kind: 'secret', itemRef: 'code-item', revision: 1 } },
    destination: { ...destination, endpoint: 'https://graph.facebook.com/v25.0/oauth/access_token' } } };
}
export const entryRequest = b => ({ operation: 'vault.secure_entry', identity: clone(b.request.identity), jobRevision: 1,
  requirement: { kind: 'secure_input', requirementRef: 'consent-entry', revision: 1, actor: { kind: 'user', actorRef: 'actor' } },
  origin: 'https://host.invalid', metadata: clone(b.request.item.metadata), effect: clone(b.request.effect), issuedAt: 1000, expiresAt: 100_000 });
export function fixture(b = binding()) {
  const state = { now: 1000, current: true, attempted: false, retained: false, calls: [], hook: async () => {} };
  const inspection = { valid: true, type: 'USER', appId: '456', userId: '789', scopes: ['public_profile', 'ads_read'],
    adsReadGranted: true, expiresAt: 120_000, dataAccessExpiresAt: 110_000 };
  const read = { accountId: '123', graphId: 'act_123', reportAccountIds: [] };
  const privateToken = 'SYNTHETIC_PRIVATE_TOKEN', privateCode = 'SYNTHETIC_PRIVATE_CODE';
  const host = { now: () => state.now, isCurrent: () => state.current, bind: value => ({ identity: clone(value.request.identity), ...value.request.effect,
    requestDigest: `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`,
    providerRef: 'meta-account-fixture', idempotencyRef: value.request.effect.effectRef }) };
  const client = { qualification: 'synthetic',
    exchangeCode: async (recipe, code, guard) => {
      state.calls.push('exchange'); await state.hook('exchange', guard);
      if (code !== privateCode || recipe.redirectUri !== b.recipe.redirectUri) throw Error('PRIVATE_BINDING_FAILED');
      return { token: privateToken, expiresAt: 130_000 };
    },
    inspectToken: async (_recipe, token, guard) => {
      state.calls.push('inspect'); await state.hook('inspect', guard);
      if (token !== privateToken) throw Error('PRIVATE_BINDING_FAILED'); return clone(inspection);
    },
    verifyAdsRead: async (_recipe, _token, guard) => { state.calls.push('read'); await state.hook('read', guard); return clone(read); },
  };
  // Narrow synthetic native-custody boundary, NOT a durable storage implementation.
  // PostgreSQL integration separately exercises the SDK's real effect/Vault stores.
  const custody = {
    invalidate: async (_binding, reason, guard) => { if (guard.isCurrent()) state.invalidated = reason; },
    claimDispatch: async (_binding, guard) => {
      if (state.attempted || !guard.isCurrent()) return false; state.attempted = true; return true;
    },
    retain: async (_binding, _value, expiresAt, guard) => {
      await state.hook('retain', guard);
      if (!guard.isCurrent()) return false; state.retained = true; state.expiresAt = expiresAt; return true;
    },
    reconcile: async () => state.retained ? 'verified' : state.attempted ? 'unknown' : 'not_applied',
  };
  const controller = new AbortController();
  const executor = () => createMetaVaultExecutor(b, host, client, custody);
  const dispatch = () => executor().dispatch(b.request, { token: privateCode }, controller.signal, () => state.current);
  return { b, state, inspection, read, privateToken, privateCode, host, client, custody, controller, executor, dispatch };
}
