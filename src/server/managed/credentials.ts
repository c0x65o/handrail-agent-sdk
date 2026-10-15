import type { JobIdentity } from '../../contracts/job.js';
import type { HostedAction, HostedActionResult } from '../hosted-session.js';
import { hostedApprovalResponse } from './hosted-approval.js';

export type CredentialRequest = {
  identity: JobIdentity;
  requestId: string;
  request: Extract<Extract<HostedAction, { type: 'computer_use_approval_request' }>['request'], { type: 'browser_authentication' }>;
};
/** Only opaque references and field mappings, never credential values. */
export interface CredentialSelection {
  credentialRef: string;
  revision: string;
  optionId: string | null;
  fields: Array<{ fieldId: string; source: string }>;
}
/** Optional application-owned Vault. The host owns scope, account selection,
 * field semantics, fresh authorization and auditing. Values go exclusively to
 * the registered private browser response, not tools or model input. */
export interface ManagedCredentialProvider {
  select(input: CredentialRequest): Promise<CredentialSelection | null>;
  resolve(input: CredentialRequest, selection: CredentialSelection): Promise<Record<string, string> | null>;
}

export function validateCredentialSelection(input: CredentialRequest, selection: CredentialSelection): void {
  const { request } = input;
  const option = request.options.find(o => o.id === selection.optionId);
  const active = request.fields.filter(f => !option || option.field_ids.includes(f.id));
  if (!selection.credentialRef || !selection.revision || !selection.fields.length
    || (request.options.length ? !option : selection.optionId !== null)
    || new Set(request.fields.map(f => f.id)).size !== request.fields.length
    || new Set(selection.fields.map(f => f.fieldId)).size !== selection.fields.length
    || selection.fields.some(f => !f.source || !active.some(a => a.id === f.fieldId))
    || active.some(f => f.required && !selection.fields.some(s => s.fieldId === f.id)))
    throw Error('CREDENTIAL_SELECTION_INVALID');
}

export function credentialResponse(input: CredentialRequest, selection: CredentialSelection,
  values: Record<string, string>): HostedActionResult {
  validateCredentialSelection(input, selection);
  const form: Record<string, unknown> = { action: 'submit', option: selection.optionId };
  for (const field of selection.fields) {
    const value = values[field.source];
    if (typeof value !== 'string' || !value || value.length > 4096) throw Error('CREDENTIAL_VALUE_UNAVAILABLE');
    form[`field_${input.request.fields.findIndex(f => f.id === field.fieldId)}`] = value;
  }
  return hostedApprovalResponse({ request_id: input.requestId,
    request: input.request }, form);
}
