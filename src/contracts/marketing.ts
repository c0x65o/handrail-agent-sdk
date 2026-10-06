import type { ConnectionEnsureInput } from './connection.js';
import type { VaultRequestDestination } from './vault.js';

/** Host-admitted mapping, never authority supplied by a setup form or model. */
export interface MarketingConnectionBinding {
  readonly connection: ConnectionEnsureInput;
  readonly provider: 'meta';
  readonly appId: string;
  readonly appScopedUserId: string;
  readonly adAccountId: string;
  readonly permission: 'ads_read';
  readonly destination: VaultRequestDestination;
}
export type MarketingOnboardingResult =
  | { readonly state: 'ready'; readonly capabilities: readonly ['meta.account.read', 'meta.report.read'] }
  | { readonly state: 'waiting_human'; readonly handoffUrl: string }
  | { readonly state: 'blocked'; readonly reason: 'not_authorized' | 'unavailable' | 'requires_consent'
      | 'provider_pending' | 'reauthorization_required' | 'unknown_effect' | 'synthetic_only' };

/** Optional structural bridge. Marketing owns its setup/grant types and capability
 * vocabulary; the host translates them under native authority, never by casting. */
export interface MarketingOnboardingPort<Setup, Grant> {
  inspect(setup: Setup, grant: Grant): Promise<MarketingOnboardingResult>;
}
