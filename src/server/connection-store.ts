import type { ConnectionEnsureInput, ConnectionEnsureResult, ConnectionScope, ConnectionValidationCode } from '../contracts/connection.js';
import type { JobAppendFence } from './job-lease.js';

/** Private host state, never credential bytes or a replacement admitted request. */
export interface ConnectionCredentials {
  readonly tokenRef?: string;
  readonly profileRef?: string;
  readonly credentialRevision: number;
  readonly credentialExpiresAt: number;
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly grantExpiresAt: number;
}
export interface ConnectionVerificationBinding {
  readonly credentialRevision: number;
  readonly grantRevision: number;
}
export interface ConnectionSnapshot {
  readonly revision: number;
  readonly result: ConnectionEnsureResult;
  readonly credentials: ConnectionCredentials | null;
  readonly locallyRevoked: boolean;
  readonly verification: ConnectionVerificationBinding | null;
}
export type ConnectionStoreCode = ConnectionValidationCode | 'not_authorized' | 'conflict' | 'unavailable' | 'lease_lost';
export type ConnectionStoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ConnectionStoreCode };
export type ConnectionStoreOperation = 'admit' | 'load' | 'reconnect' | 'rotate' | 'revoke';
export interface ConnectionStoreAuthority {
  readonly scope: ConnectionScope;
  /** Optional composition with the reference job journal; checked under its SQL
   * row lock before the connection lock, and again before transaction completion. */
  readonly job?: JobAppendFence;
}
export interface ConnectionStoreHost {
  /** Authenticate/authorize the exact immutable request on EVERY call, including
   * retries/reads. Hold native ACL, cancellation and custody/grant authority stable
   * through run AND commit. Invoke run once, awaited. Resolve approved references
   * and authenticate verification provenance before reconnect; syntax is not proof.
   * External vault revocation/rotation must commit the local fence before cleanup
   * or deny authority here. Never deserialize these facts from client/model input. */
  withAuthority<T>(request: ConnectionEnsureInput, operation: ConnectionStoreOperation,
    run: (authority: ConnectionStoreAuthority) => Promise<ConnectionStoreResult<T>>): Promise<ConnectionStoreResult<T>>;
  now(): number;
}
export interface ConnectionStore {
  admit(request: ConnectionEnsureInput): Promise<ConnectionStoreResult<ConnectionSnapshot>>;
  /** Current readiness only; expired ready snapshots fail closed. */
  load(request: ConnectionEnsureInput): Promise<ConnectionStoreResult<ConnectionSnapshot>>;
  reconnect(request: ConnectionEnsureInput, expectedRevision: number, result: ConnectionEnsureResult,
    verification?: ConnectionVerificationBinding): Promise<ConnectionStoreResult<ConnectionSnapshot>>;
  /** Install fresh private custody/grant revisions and invalidate readiness in one
   * commit, before asynchronous cleanup. Requires monotonically advancing facts. */
  rotate(request: ConnectionEnsureInput, expectedRevision: number, credentials: ConnectionCredentials): Promise<ConnectionStoreResult<ConnectionSnapshot>>;
  /** Local fence only; does not claim or perform remote provider revocation. */
  revoke(request: ConnectionEnsureInput, expectedRevision: number): Promise<ConnectionStoreResult<ConnectionSnapshot>>;
}
