import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { JobIdentity } from '../../contracts/job.js';
import type { AgentStateKeys } from '../postgres/keys.js';
import { managedStore, type ManagedStore } from './store.js';

export type PrivateInputEventKind = 'requested' | 'follow_up_requested' | 'form_opened' | 'form_renewed'
  | 'form_expired' | 'form_stale' | 'form_invalid' | 'response_saved' | 'response_reused'
  | 'credentials_unavailable' | 'answer_delivered' | 'answer_delivery_failed'
  | 'provider_accepted' | 'provider_delivery_uncertain' | 'access_rejected';
export type PrivateInputStage = 'request' | 'authentication' | 'interaction' | 'job_authority' | 'answer_delivery'
  | 'feature' | 'form_renewal' | 'form_render' | 'submission' | 'submission_commit';
export interface PrivateInputDiagnostic {
  readonly kind: PrivateInputEventKind;
  readonly at: number;
  readonly jobId: string;
  /** One-way correlation only, never a usable private link or provider request. */
  readonly step: string;
  readonly inputKind: 'credentials' | 'browser_authentication' | 'browser_origin_access';
  readonly decision?: 'submit' | 'cancel' | 'approve' | 'deny';
  readonly source?: 'private_form' | 'credential_provider' | 'saved_account';
  readonly stage?: PrivateInputStage;
}
export interface PrivateInputDiagnostics { total: number; events: PrivateInputDiagnostic[] }
const key = (identity: JobIdentity) => `input-diagnostics:${identity.jobId}`;
export const privateStep = (ref: string) => createHash('sha256').update(`private-input-diagnostic:${ref}`).digest('hex');

/** Small encrypted diagnostic window, independent of credentials. Optional
 * observation cannot block sign-in; persistence failures still reach the host
 * observer. No error text, URLs, labels, field IDs or values are accepted. */
export function privateInputDiagnostics(store: ManagedStore, observe?: (event: PrivateInputDiagnostic) => void | Promise<void>) {
  return async (identity: JobIdentity, event: PrivateInputDiagnostic) => {
    try {
      await store.lock(identity.host, key(identity), async () => {
        const old = await store.get<PrivateInputDiagnostics>(identity.host, key(identity));
        await store.put(identity.host, key(identity), { total: (old?.value.total ?? 0) + 1,
          events: [...(old?.value.events ?? []), event].slice(-64) }, old?.version ?? 0);
      });
    } catch { /* Diagnostic storage is not execution authority. */ }
    try { await observe?.(structuredClone(event)); } catch { /* Optional telemetry fails open. */ }
  };
}

/** Trusted server reader. The caller must authorize inspection of this exact
 * persisted identity; never accept a browser/model-selected scope. This reads
 * only credential-free diagnostics, including after the original job ends. */
export async function readManagedInputDiagnostics(options: {
  database: Pool; schema: string; keys: AgentStateKeys; identity: JobIdentity;
}): Promise<PrivateInputDiagnostics> {
  const store = managedStore(options.database, options.schema, options.keys);
  return (await store.get<PrivateInputDiagnostics>(options.identity.host, key(options.identity)))?.value ?? { total: 0, events: [] };
}
