/** Trusted facts from authenticated host services; never deserialize client claims. */
import type { JobSnapshot } from '../contracts/job.js';
import type { BrowserLease, BrowserOperation, BrowserProfile, BrowserTakeover } from '../contracts/browser.js';
import type { VaultUseContext } from './vault-policy.js';

interface BrowserCurrentContext {
  readonly currentJob: JobSnapshot;
  readonly profile: BrowserProfile;
  readonly currentLease: BrowserLease;
  readonly authenticated: boolean;
  readonly authorized: boolean;
  readonly taskExpiresAt: number;
}
export interface BrowserOperationContext extends BrowserCurrentContext {
  /** Exact host-admitted request; aliases must be resolved/authorized in its scope. */
  readonly admittedOperation: BrowserOperation;
  /** Host reviewed exact text and destination; a model label cannot set this. */
  readonly nonSensitiveTextAuthorized: boolean;
  /** Qualified transfer gate approved exact artifact/content/type/size/destination. */
  readonly transferAuthorized: boolean;
  readonly vaultUse?: VaultUseContext;
}
export interface BrowserHandbackAuthorization {
  readonly authorizationRef: string;
  readonly revision: number;
  readonly leaseEpoch: number;
  readonly jobRevision: number;
  readonly requirementRef: string;
  readonly requirementRevision: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface BrowserTakeoverContext extends BrowserCurrentContext {
  readonly previous: BrowserTakeover | null;
  /** Host proved the old context cannot act/write/stream; otherwise quarantine. */
  readonly priorControllerFenced: boolean;
  readonly previousAuthorizationRef: string;
  /** Newly authenticated authorization for this challenge and successor epoch. */
  readonly handbackAuthorization?: BrowserHandbackAuthorization;
}
