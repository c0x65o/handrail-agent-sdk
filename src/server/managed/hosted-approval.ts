import type { HostedAction, HostedActionResult } from '../hosted-session.js';

type Approval = Extract<HostedAction, { type: 'computer_use_approval_request' }>;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Nonsecret conversation notice. Authentication details and the provider's
 * full reason stay on the authenticated form, never in a transport notice. */
export function hostedApprovalNotice(action: Approval, link: string): string {
  const request = action.request;
  const value = request.type === 'browser_origin_access' ? request.origin : request.credential_origin;
  let website = 'the requested website';
  try {
    const url = new URL(value ?? '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) website = url.origin;
  } catch { /* The private form retains the exact provider request. */ }
  if (request.type === 'browser_origin_access')
    return `The cloud browser needs your approval to open ${website}. [Review website access](${link}). After you allow access, I’ll continue your original request and return the result here.`;
  return `The website ${website} needs you to complete sign-in. [Complete sign-in privately](${link}). I’ll continue your original request afterward. Do not send passwords or verification codes in chat.`;
}

/** Values flow from the authenticated private portal directly to the registered
 * provider control, never into the model input, tool log or conversation. */
export function hostedApprovalResponse(action: Pick<Approval, 'request' | 'request_id'>, form: Record<string, unknown>): HostedActionResult {
  const request = action.request;
  const response = (value: Extract<HostedActionResult, { type: 'agent.session.input.computer_use_approval_request_result' }>['response']): HostedActionResult =>
    ({ type: 'agent.session.input.computer_use_approval_request_result', request_id: action.request_id, response: value });
  if (request.type === 'browser_origin_access') {
    if (form.decision !== 'approve' && form.decision !== 'deny' && form.decision !== 'cancel') throw Error('INVALID_BROWSER_DECISION');
    return response({ type: request.type, decision: form.decision });
  }
  if (form.action === 'cancel') return response({ type: request.type, action: 'cancel' });
  if (form.action !== 'submit') throw Error('INVALID_BROWSER_DECISION');
  const option = request.options.find(o => o.id === form.option);
  if (request.options.length && !option) throw Error('INVALID_BROWSER_OPTION');
  const active = request.fields.filter(f => !option || option.field_ids.includes(f.id));
  if (active.length > 6 || new Set(active.map(f => f.id)).size !== active.length) throw Error('INVALID_BROWSER_FIELDS');
  const fields = active.flatMap(f => {
    const value = form[`field_${request.fields.indexOf(f)}`];
    if (value === undefined || value === '') { if (f.required) throw Error('BROWSER_FIELD_REQUIRED'); return []; }
    if (typeof value !== 'string' || value.length > 4096) throw Error('INVALID_BROWSER_FIELD');
    return [{ field_id: f.id, value }];
  });
  return response({ type: request.type, action: 'submit', fields, ...(option ? { selected_option: option.id } : {}) });
}

export function hostedApprovalPage(input: { action: Approval; csrf: string; path: string; nonce: string; accounts?: Array<{ ref: string; label: string }> }): string {
  const r = input.action.request;
  const form = (body: string) => `<form method="post" action="${escape(input.path)}"><input type="hidden" name="csrf" value="${escape(input.csrf)}">${body}</form>`;
  const origin = r.type === 'browser_origin_access' ? r.origin : r.credential_origin;
  let content = `<h1>${r.type === 'browser_origin_access' ? 'Allow website access' : 'Complete sign-in privately'}</h1><p>Website: <strong>${escape(origin ?? 'Not supplied by the provider')}</strong></p>`;
  if (r.reason) content += `<p>${escape(r.reason)}</p>`;
  if (r.type === 'browser_origin_access') {
    content += form('<button name="decision" value="approve">Allow this website</button> <button name="decision" value="deny">Deny</button>');
  } else {
    content += '<p>Your entries go to the registered browser form through OpenAI. They are kept out of chat and model input.</p>';
    const options = r.options.length ? r.options : [{ id: '', label: 'Sign in', field_ids: r.fields.map(f => f.id) }];
    for (const option of options) {
      const fields = r.fields.filter(f => option.field_ids.includes(f.id)).map(f => {
        const type = ['email', 'password', 'tel', 'text'].includes(f.type) ? f.type : 'text';
        return `<label>${escape(f.label)}<input name="field_${r.fields.indexOf(f)}" type="${type}" autocomplete="off" maxlength="4096" ></label>${input.accounts?.length ? `<label>Use saved value for ${escape(f.label)}<select name="source_${r.fields.indexOf(f)}"><option value="">Use typed entry</option><option value="username">Saved username</option><option value="password">Saved password</option></select></label>` : ''}`;
      }).join('');
      content += form(`<h2>${escape(option.label)}</h2><input type="hidden" name="option" value="${escape(option.id)}">${input.accounts?.length ? `<label>Saved account<select name="accountRef"><option value="">Choose an account</option>${input.accounts.map(a => `<option value="${escape(a.ref)}">${escape(a.label)}</option>`).join('')}</select></label>` : ''}${fields}<button name="action" value="submit">Continue securely</button>`);
    }
    content += form('<button name="action" value="cancel">Cancel sign-in</button>');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private browser access</title><style nonce="${escape(input.nonce)}">body{font:17px system-ui;margin:32px auto;padding:20px;max-width:680px}label{display:block;margin:18px 0}input{display:block;padding:12px;font:inherit;max-width:100%}button{font:inherit;padding:12px;margin:8px 0}</style></head><body>${content}</body></html>`;
}
