/** Trusted host policy facts only. Never deserialize these from model/client input. */
import type { JobSnapshot } from '../contracts/job.js';
import type { VaultEntryCompletion, VaultEntryRequest, VaultItem, VaultOperation } from '../contracts/vault.js';

/** Human Vault policy distinguishes each permission; none implies another. */
export interface VaultPermissions {
  readonly use: boolean;
  readonly reveal: boolean;
  readonly export: boolean;
}
/** Agent reveal/export is disabled regardless of human Vault permissions. */
export interface VaultAgentPermissions extends VaultPermissions {
  readonly reveal: false;
  readonly export: false;
}
interface VaultCurrentAuthority {
  readonly currentJob: JobSnapshot;
  readonly item: VaultItem;
  readonly authenticated: boolean;
  readonly authenticatedActor: { readonly kind: 'user'; readonly actorRef: string };
  readonly authorized: boolean;
  /** Exact current item/version ACL, required for both new input and selection. */
  readonly itemAuthorized: boolean;
  readonly itemState: 'active' | 'revoked' | 'deleted';
  readonly itemExpiresAt: number;
  readonly taskExpiresAt: number;
  /** Positive host policy limit, no greater than the documented maximum. */
  readonly maxLifetimeMs: number;
}
export interface VaultEntryContext extends VaultCurrentAuthority {
  readonly request: VaultEntryRequest;
  readonly state: 'active' | 'revoked';
  /** Approved private-input observation reference resolved by the host. */
  readonly responseRef: string;
  readonly source: 'new_input' | 'existing_item';
  /** Canonical already-consumed completion from durable host state, if any. */
  readonly previous?: VaultEntryCompletion;
}
export interface VaultUseGrant {
  readonly request: VaultOperation;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly state: 'active' | 'revoked';
  readonly permissions: VaultPermissions;
}
export interface VaultUseContext extends VaultCurrentAuthority {
  readonly grant: VaultUseGrant;
}
