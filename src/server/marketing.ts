import type { MarketingOnboardingResult } from '../contracts/marketing.js';
import { validateConnectionEnsureResult } from '../contracts/connection.js';
import type { ConnectionStore } from './connection-store.js';
import type { VaultEntryRequest } from '../contracts/vault.js';
import { validateVaultEntryRequest } from '../contracts/vault.js';
import type { VaultEntryHandle, createVaultEntry } from './vault-entry.js';
import { sameLeaseValue } from './job-lease.js';
import { validMetaRecipe } from './marketing-meta.js';
import type { MetaRecipe, MetaPrivateValue } from './marketing-meta.js';
export { createMetaVaultExecutor } from './marketing-meta.js';
export type { MetaRecipe, MetaExecutorBinding, MetaPrivateValue, MetaPrivateInspection, MetaReadVerification,
  MetaPrivateGuard, MetaPrivateClient, MetaPrivateCustody, MetaExecutorHost } from './marketing-meta.js';
export type { MarketingConnectionBinding, MarketingOnboardingResult, MarketingOnboardingPort } from '../contracts/marketing.js';

type Result = MarketingOnboardingResult;
const blocked = (reason: Extract<Result, { state: 'blocked' }>['reason']): Result => ({ state: 'blocked', reason });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const nonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(v);
const reference = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** Native-host adapter: setup/grant are untrusted lookup hints. Authenticate the
 * user independently, resolve the full original admission, ACL, app/account,
 * destination, grant/expiry and instruction revision from native state on EVERY
 * call. Hold authority through callback AND commit. No provider-page authority. */
export interface MarketingOnboardingHost<Setup, Grant> {
  now(): number;
  readonly handoffOrigin: string;
  withAuthority(setup: Setup, grant: Grant, operation: 'inspect' | 'request_access' | 'cancel' | 'revoke',
    run: (recipe: MetaRecipe) => Promise<Result>): Promise<Result>;
  /** Recheck authenticated actor, full original binding and current revisions
   * inside the authority fence. For cancel/revoke allow expired/revoked access
   * only for local fencing. Native ports must also check inside their commits. */
  isCurrent(recipe: MetaRecipe, operation: 'inspect' | 'request_access' | 'cancel' | 'revoke'): boolean;
  /** Explicit authenticated human decision for creation OR expansion of durable
   * access, bound to the entire recipe. A model approval or login is insufficient.
   * Persist the decision in the native approval system; false means no issuance. */
  approvePersistentAccess(recipe: MetaRecipe): Promise<boolean>;
  /** Existing private entry challenge for the original job, never a new job. */
  entryRequest(recipe: MetaRecipe): Promise<VaultEntryRequest>;
  /** Native authenticated route, no bearer authority. Persist binding to the
   * entry handle, recipe, independent OAuth state, user/session and deadline.
   * Return an opaque nonsecret route reference, NEVER state/code/provider URL.
   * The private user route owns Login/consent/MFA. No browser automation. */
  handoff(recipe: MetaRecipe, handle?: VaultEntryHandle): Promise<string | null>;
  /** Durably fence native cancellation / Vault grant revocation and invalidate
   * handoffs BEFORE resolving. Preserve original effect and retained facts.
   * Idempotent; may not dispatch remote revocation or erase unknown outcomes. */
  fence(recipe: MetaRecipe, reason: 'cancel' | 'revoke'): Promise<number | null>;
}

/** No IO at construction. All methods operate through existing native stores. */
export function createMarketingOnboarding<Setup, Grant>(host: MarketingOnboardingHost<Setup, Grant>,
  connections: ConnectionStore, entry: Pick<ReturnType<typeof createVaultEntry<MetaPrivateValue>>, 'issue'>) {
  function url(ref: string): string {
    const u = new URL(host.handoffOrigin);
    if (u.protocol !== 'https:' || u.origin !== host.handoffOrigin || !nonce(ref)) throw Error('INVALID_HANDOFF');
    return `${u.origin}/marketing/connect/${ref}`;
  }
  async function run(setup: Setup, grant: Grant, operation: 'inspect' | 'request_access' | 'cancel' | 'revoke'): Promise<Result> {
    try {
      return await host.withAuthority(setup, grant, operation, async input => {
        const r = copy(input);
        if (!validMetaRecipe(r) || !Number.isSafeInteger(host.now()) || host.now() < 0)
          return blocked('not_authorized');
        const current = () => host.isCurrent(copy(r), operation) === true
          && Number.isSafeInteger(host.now()) && host.now() >= 0
          && (operation === 'cancel' || operation === 'revoke' || host.now() < r.expiresAt);
        if (operation !== 'cancel' && operation !== 'revoke' && r.expiresAt <= host.now())
          return blocked('reauthorization_required');
        if (!current()) return blocked('not_authorized');
        if (operation === 'cancel' || operation === 'revoke') {
          // Native fence returns the canonical connection CAS revision, so an
          // expired ready receipt cannot prevent local revocation.
          const revision = await host.fence(copy(r), operation);
          if (!current() || !Number.isSafeInteger(revision) || revision === null || revision < 1) return blocked('not_authorized');
          const revoked = await connections.revoke(r.connection, revision);
          if (!current()) return blocked('not_authorized');
          return revoked.ok ? blocked(revoked.value.result.state === 'unknown_effect' ? 'unknown_effect' : 'reauthorization_required')
            : blocked('unavailable');
        }
        const head = await connections.load(r.connection);
        if (!current()) return blocked('not_authorized');
        if (!head.ok) return blocked(head.code === 'not_current' ? 'reauthorization_required' : 'not_authorized');
        const snapshot = head.value, result = snapshot.result;
        if (!validateConnectionEnsureResult(result, r.connection, host.now()).ok) return blocked('not_authorized');
        if (result.state === 'unknown_effect') return blocked('unknown_effect');
        if (snapshot.locallyRevoked) return blocked('reauthorization_required');
        if (result.state === 'ready') {
          const c = snapshot.credentials, v = snapshot.verification;
          if (!c || !v || snapshot.locallyRevoked !== false || !reference(c.tokenRef) || !reference(c.grantRef)
            || ![c.credentialRevision, c.grantRevision, c.credentialExpiresAt, c.grantExpiresAt]
              .every(n => Number.isSafeInteger(n) && n > 0)
            || v.credentialRevision !== c.credentialRevision || v.grantRevision !== c.grantRevision
            || Math.min(c.credentialExpiresAt, c.grantExpiresAt) <= host.now()
            || result.authorization.expiresAt > Math.min(c.credentialExpiresAt, c.grantExpiresAt)
            || result.evidence.expiresAt > Math.min(c.credentialExpiresAt, c.grantExpiresAt)) return blocked('reauthorization_required');
          if (result.evidence.provenance.kind !== 'provider') return blocked('synthetic_only');
          return { state: 'ready', capabilities: ['meta.account.read', 'meta.report.read'] };
        }
        if (operation === 'request_access') {
          if (await host.approvePersistentAccess(copy(r)) !== true || !current()) return blocked('not_authorized');
          const request = copy(await host.entryRequest(copy(r)));
          if (!current() || !validateVaultEntryRequest(request).ok || !sameLeaseValue(request.identity, r.connection.identity)
            || !sameLeaseValue(request.effect, r.connection.effect) || request.expiresAt > r.expiresAt
            || host.now() < request.issuedAt || host.now() >= request.expiresAt
            || request.metadata.kind !== 'token' || request.metadata.tokenType !== 'api'
            || request.origin !== new URL(r.redirectUri).origin) return blocked('not_authorized');
          const issued = await entry.issue(copy(request));
          if (!current() || !issued.ok || host.now() >= request.expiresAt) return blocked('not_authorized');
          const ref = await host.handoff(copy(r), copy(issued.value));
          if (!current() || host.now() >= request.expiresAt) return blocked('not_authorized');
          return ref ? { state: 'waiting_human', handoffUrl: url(ref) } : blocked('unavailable');
        }
        const ref = await host.handoff(copy(r));
        if (!current()) return blocked('not_authorized');
        if (ref) return { state: 'waiting_human', handoffUrl: url(ref) };
        return blocked(result.state === 'waiting_for_provider' ? 'provider_pending'
          : result.state === 'reauthorization_required' ? 'reauthorization_required' : 'requires_consent');
      });
    } catch { return blocked('unavailable'); }
  }
  return {
    inspect: (setup: Setup, grant: Grant) => run(setup, grant, 'inspect'),
    reconnect: (setup: Setup, grant: Grant) => run(setup, grant, 'inspect'),
    requestAccess: (setup: Setup, grant: Grant) => run(setup, grant, 'request_access'),
    cancel: (setup: Setup, grant: Grant) => run(setup, grant, 'cancel'),
    revoke: (setup: Setup, grant: Grant) => run(setup, grant, 'revoke'),
  };
}

export interface MetaOAuthSession {
  readonly recipe: MetaRecipe;
  readonly entry: VaultEntryHandle;
  readonly state: string;
  readonly expiresAt: number;
  readonly actorRef: string;
  readonly entryRequest: VaultEntryRequest;
}
export interface MetaOAuthCallbackHost {
  now(): number;
  /** Current authenticated actor/session/CSRF, original approved recipe, entry
   * and grant revisions. Check under the same fence as withSession; never infer
   * authority from state alone. Entry ports must fence capture/delivery commits. */
  isCurrent(session: MetaOAuthSession): boolean;
  /** Authenticate browser session and CSRF independently of state/route. Resolve
   * canonical approved session from native storage, hold its scope/revocation
   * fence through capture/delivery. Serialize callbacks; identical duplicate
   * capture uses Vault's canonical result; a different code must conflict.
   * Never accept session facts or this callback from agent/model input. */
  withSession(run: (session: MetaOAuthSession) => Promise<'captured' | 'denied'>): Promise<'captured' | 'denied'>;
}
/** Invoke only on the private authenticated server callback route. redirectUri
 * is the actual configured callback base from the router (not a query argument).
 * Raw code/state/error never leave this method or appear in an SDK observation. */
export function createMetaOAuthCallback(host: MetaOAuthCallbackHost,
  entry: Pick<ReturnType<typeof createVaultEntry<MetaPrivateValue>>, 'capture' | 'deliver' | 'withdraw'>) {
  return async (redirectUri: string, parameters: Readonly<Record<string, unknown>>): Promise<'captured' | 'denied'> => {
    try {
      const params = copy(parameters);
      return await host.withSession(async input => {
        const s = copy(input);
        const current = () => host.isCurrent(copy(s)) === true && Number.isSafeInteger(host.now())
          && host.now() >= s.entryRequest.issuedAt && host.now() < s.expiresAt;
        if (!validMetaRecipe(s.recipe) || !validateVaultEntryRequest(s.entryRequest).ok
          || !sameLeaseValue(s.entryRequest.identity, s.recipe.connection.identity)
          || !sameLeaseValue(s.entryRequest.effect, s.recipe.connection.effect)
          || s.entryRequest.metadata.kind !== 'token' || s.entryRequest.metadata.tokenType !== 'api'
          || s.entryRequest.origin !== new URL(s.recipe.redirectUri).origin
          || s.actorRef !== s.recipe.connection.identity.host.userRef || redirectUri !== s.recipe.redirectUri
          || !nonce(s.state) || params.state !== s.state || !Number.isSafeInteger(host.now()) || host.now() < 0
          || !Number.isSafeInteger(s.expiresAt) || s.expiresAt > Math.min(s.recipe.expiresAt, s.entryRequest.expiresAt)
          || !current()) return 'denied';
        if (Object.hasOwn(params, 'error')) { await entry.withdraw(copy(s.entry)); return 'denied'; }
        if (Object.keys(params).some(k => !['state', 'code'].includes(k))
          || typeof params.code !== 'string' || !params.code.length || params.code.length > 8192
          || /[\x00-\x20\x7f]/.test(params.code)) return 'denied';
        const captured = await entry.capture(copy(s.entry), { token: params.code });
        if (!current() || !captured.ok || !sameLeaseValue(captured.value.request, s.entryRequest)) return 'denied';
        const delivered = await entry.deliver(copy(s.entry));
        return current() && delivered.ok ? 'captured' : 'denied';
      });
    } catch { return 'denied'; }
  };
}
