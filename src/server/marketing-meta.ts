import { validateConnectionEnsureInput } from '../contracts/connection.js';
import type { MarketingConnectionBinding } from '../contracts/marketing.js';
import { validateVaultOperationSchema } from '../contracts/vault.js';
import type { EffectRequest } from './effects.js';
import { validEffectRequest } from './effects.js';
import { sameLeaseValue } from './job-lease.js';
import type { VaultTokenRequest } from './vault-request.js';
import type { TrustedVaultExecutor } from './vault-use.js';

/** Secret value supplied ONLY by createVaultEntry/createVaultUse custody ports. */
export type MetaPrivateValue = { readonly token: string };
export interface MetaRecipe extends MarketingConnectionBinding {
  readonly apiVersion: 'v25.0';
  readonly redirectUri: string;
  readonly expiresAt: number;
}
export interface MetaExecutorBinding {
  readonly recipe: MetaRecipe;
  readonly request: VaultTokenRequest;
  readonly action: 'exchange_code' | 'verify_read';
  /** No live registration is shipped. Independent installed-host qualification
   * is required before adding a provider mode. Fixtures cannot upgrade this flag. */
  readonly qualification: 'synthetic';
}
export interface MetaPrivateInspection {
  readonly valid: boolean;
  readonly type: 'USER';
  readonly appId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly adsReadGranted: boolean;
  /** Normalized Unix milliseconds. A documented no-expiry value is null;
   * missing or malformed metadata fails closed, never becomes null implicitly. */
  readonly expiresAt: number | null;
  readonly dataAccessExpiresAt: number | null;
}
export interface MetaReadVerification {
  readonly accountId: string;
  readonly graphId: string;
  readonly reportAccountIds: readonly string[];
}
export interface MetaPrivateGuard {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}
/** Allowlisted private operations, NOT fetch. Adapt the host's existing provider
 * client. Fixed graph.facebook.com/version paths only: oauth/access_token,
 * debug_token, me/permissions, act_ID and act_ID/insights. No redirects, retries,
 * pagination, GET body, user URL, telemetry or raw error propagation. Suppress
 * secret-bearing query URLs/access logs; bound request/response/decompression to
 * 64 KiB and headers to 8 KiB. App credentials remain in the client's custody.
 * Check guard immediately before EACH send, after async preparation. */
export interface MetaPrivateClient {
  readonly qualification: 'synthetic';
  exchangeCode(recipe: MetaRecipe, code: string, guard: MetaPrivateGuard): Promise<{
    readonly token: string; readonly expiresAt: number | null;
  }>;
  inspectToken(recipe: MetaRecipe, token: string, guard: MetaPrivateGuard): Promise<MetaPrivateInspection>;
  /** Exact account fields id,account_id; Insights fields account_id,impressions,
   * date_preset=yesterday, level=account, limit=1. Empty reports are valid. */
  verifyAdsRead(recipe: MetaRecipe, token: string, guard: MetaPrivateGuard): Promise<MetaReadVerification>;
}
export interface MetaPrivateCustody {
  /** Native dispatch ledger CAS: commit a permanent attempted marker BEFORE IO,
   * independently of any surrounding transaction that can roll back after IO.
   * One winner only. False/ambiguous means no dispatch. This is the host's
   * existing effect/outbox mechanism, not an in-memory lock. */
  claimDispatch(binding: MetaExecutorBinding, guard: MetaPrivateGuard): Promise<boolean>;
  /** Fence cached connection readiness on a known failed inspection using the
   * existing connection/grant revision mechanism. Keep any unknown effect and
   * original reconciliation identity. Never renew a grant or erase its history. */
  invalidate(binding: MetaExecutorBinding, reason: 'provider_rejected' | 'expired' | 'scope_changed',
    guard: MetaPrivateGuard): Promise<void>;
  /** Existing encrypted Vault/connection storage. Atomically persist token,
   * bounded expiry and authenticated evidence under this ENTIRE binding and
   * original effect, grant, job and lease fences. Recheck guard inside commit.
   * Never publish readiness on a cancelled/revoked/stale lease. If commit is
   * ambiguous return false; retain correlated private facts for reconciliation. */
  retain(binding: MetaExecutorBinding, value: MetaPrivateValue, expiresAt: number,
    guard: MetaPrivateGuard): Promise<boolean>;
  /** Authenticated read-only reconciliation for EXACT original effect+digest.
   * verified requires a durably correlated validated result, never a token found
   * elsewhere. not_applied requires authoritative proof that claimDispatch has
   * NEVER committed, serialized against all attempts. An attempted exchange with
   * no retained result is permanently unknown, including after reconnect. */
  reconcile(binding: MetaExecutorBinding, signal: AbortSignal): Promise<'verified' | 'not_applied' | 'unknown'>;
}
export interface MetaExecutorHost {
  now(): number;
  /** Native current scope/grant/cancellation AND execution lease check. Bound to
   * this worker's authority, not merely the existence of some active lease.
   * Called again after every await and by the transport immediately before send.
   * Reconcile checks current factual-read authority for the original effect;
   * it may run after Stop/expiry without authorizing dispatch or readiness. */
  isCurrent(binding: MetaExecutorBinding, phase: 'dispatch' | 'reconcile'): boolean;
  /** Existing canonical effect digest/idempotency namespace; hash complete
   * request AND binding (including account/redirect/fixture mode), never secrets. */
  bind(binding: MetaExecutorBinding): EffectRequest;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const digits = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const secret = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x20\x7f]/.test(v);
export function validMetaRecipe(r: MetaRecipe): boolean {
  try {
    const c = r.connection, u = new URL(r.redirectUri);
    return Object.keys(r).sort().join(',') === 'adAccountId,apiVersion,appId,appScopedUserId,connection,destination,expiresAt,permission,provider,redirectUri'
      && validateConnectionEnsureInput(c).ok && r.provider === 'meta' && c.providerRef === 'meta'
      && c.prerequisiteVersion === 'meta-v1.2026-09-28' && r.apiVersion === 'v25.0'
      && c.minimumCapabilities.length === 2 && c.minimumCapabilities.includes('meta.account.read')
      && c.minimumCapabilities.includes('meta.report.read') && r.permission === 'ads_read'
      && [r.appId, r.appScopedUserId, r.adAccountId].every(digits) && time(r.expiresAt)
      && u.href === r.redirectUri && u.protocol === 'https:' && !u.username && !u.password
      && !r.redirectUri.includes('?') && !r.redirectUri.includes('#')
      && sameLeaseValue(r.destination, { endpoint: `https://graph.facebook.com/v25.0/act_${r.adAccountId}/insights`,
        method: 'GET', resourceRef: c.identity.host.accountRef, redirects: 'deny' });
  } catch { return false; }
}

/** Private executor registered with createVaultUse, never invoked as a model
 * callback. Returns enums only. Existing Vault effects journal unknown BEFORE IO. */
export function createMetaVaultExecutor(input: MetaExecutorBinding, host: MetaExecutorHost,
  client: MetaPrivateClient, custody: MetaPrivateCustody): TrustedVaultExecutor<MetaPrivateValue> {
  let b: MetaExecutorBinding;
  try {
    b = copy(input);
    const r = b.request, c = b.recipe.connection;
    const endpoint = b.action === 'exchange_code' ? 'https://graph.facebook.com/v25.0/oauth/access_token'
      : b.recipe.destination.endpoint;
    if (!validMetaRecipe(b.recipe) || b.qualification !== 'synthetic' || client.qualification !== 'synthetic'
      || c.evidenceMode !== 'fixture' || !['exchange_code', 'verify_read'].includes(b.action)
      || !validateVaultOperationSchema(r).ok || r.operation !== 'server_request'
      || r.item.metadata.kind !== 'token' || r.item.metadata.tokenType !== 'api'
      || !sameLeaseValue(r.identity, c.identity) || !sameLeaseValue(r.effect, c.effect)
      || !sameLeaseValue(r.destination, { ...b.recipe.destination, endpoint })) throw Error();
  } catch { throw Error('INVALID_META_BINDING'); }
  const matches = (r: unknown) => sameLeaseValue(r, b.request);
  return {
    operationRef: b.request.effect.operationRef,
    bind(request) {
      try {
        if (!matches(request)) throw Error();
        const effect = host.bind(copy(b));
        if (!validEffectRequest(effect) || !sameLeaseValue(effect.identity, b.request.identity)
          || !(['effectRef', 'actionRef', 'operationRef'] as const).every(k => effect[k] === b.request.effect[k])
          || effect.idempotencyRef !== b.request.effect.effectRef) throw Error();
        return copy(effect);
      } catch { throw Error('INVALID_META_BINDING'); }
    },
    async dispatch(request, value, signal, isCurrent) {
      try {
        const current = () => !signal.aborted && isCurrent() === true && host.isCurrent(copy(b), 'dispatch') === true
          && time(host.now()) && host.now() < b.recipe.expiresAt;
        const guard = { signal, isCurrent: current };
        const reject = async (reason: 'provider_rejected' | 'expired' | 'scope_changed') => {
          await custody.invalidate(copy(b), reason, guard);
          return 'unknown' as const;
        };
        const token = value.token;
        if (!matches(request) || !current() || !secret(token)) return 'unknown';
        if (await custody.claimDispatch(copy(b), guard) !== true || !current()) return 'unknown';
        const response = b.action === 'exchange_code'
          ? await client.exchangeCode(copy(b.recipe), token, guard) : { token, expiresAt: null };
        // Snapshot primitives without JSON coercion: NaN/Infinity must not become
        // the explicitly permitted provider no-expiry value null.
        const exchanged = { token: response.token, expiresAt: response.expiresAt };
        if (!current()) return 'unknown';
        if (!secret(exchanged.token)) return await reject('provider_rejected');
        const inspected = await client.inspectToken(copy(b.recipe), exchanged.token, guard);
        if (!current()) return 'unknown';
        if (inspected.valid !== true || inspected.type !== 'USER' || inspected.appId !== b.recipe.appId
          || inspected.userId !== b.recipe.appScopedUserId) return await reject('provider_rejected');
        if (inspected.adsReadGranted !== true || !Array.isArray(inspected.scopes)
          || inspected.scopes.length > 32 || !inspected.scopes.includes('ads_read')) return await reject('scope_changed');
        const deadlines = [exchanged.expiresAt, inspected.expiresAt, inspected.dataAccessExpiresAt];
        if (deadlines.some(n => n !== null && !time(n))) return await reject('provider_rejected');
        if (deadlines.some(n => n !== null && n <= host.now())) return await reject('expired');
        const expiresAt = Math.min(b.recipe.expiresAt, ...deadlines.filter((n): n is number => n !== null));
        const read = await client.verifyAdsRead(copy(b.recipe), exchanged.token, guard);
        if (!current()) return 'unknown';
        if (host.now() >= expiresAt) return await reject('expired');
        if (read.accountId !== b.recipe.adAccountId
          || read.graphId !== `act_${b.recipe.adAccountId}` || !Array.isArray(read.reportAccountIds)
          || read.reportAccountIds.length > 1 || read.reportAccountIds.some(id => id !== b.recipe.adAccountId)) return await reject('provider_rejected');
        const retained = await custody.retain(copy(b), { token: exchanged.token }, expiresAt, guard);
        return retained === true && current() && host.now() < expiresAt ? 'verified' : 'unknown';
      } catch { return 'unknown'; }
    },
    async reconcile(request, signal) {
      try {
        const current = () => !signal.aborted && host.isCurrent(copy(b), 'reconcile') === true;
        if (!matches(request) || !current()) return 'unknown';
        const result = await custody.reconcile(copy(b), signal);
        return current() && (result === 'verified' || result === 'not_applied') ? result : 'unknown';
      } catch { return 'unknown'; }
    },
  };
}
