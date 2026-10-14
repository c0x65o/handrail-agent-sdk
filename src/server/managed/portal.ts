const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function portalPage(input: { label: string; url: string; csrf: string; kind: 'credentials'; path: string; nonce: string }) {
  const label = escape(input.label), site = escape(input.url), csrf = escape(input.csrf);
  const content = `<h1>Connect ${label}</h1><p>Website: <strong>${site}</strong></p><p>Your login stays in encrypted storage. The assistant can use it for this website without seeing your password.</p>
       <form method="post" action="${escape(input.path)}"><input type="hidden" name="csrf" value="${csrf}">
       <label>Username or membership number<input name="username" autocomplete="username" required maxlength="512"></label>
       <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label>
       <label>Additional sign-in websites (optional)<input name="origins" placeholder="https://accounts.example.com" maxlength="2048"></label>
       <label class="check"><input type="checkbox" name="consent" value="yes" required> Save this login and allow the assistant to use this account on the listed websites for the next 30 days.</label>
       <button>Save securely and continue</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure account access</title>
    <style nonce="${escape(input.nonce)}">body{font:17px system-ui;color:#202820;background:#f7f8f4;margin:32px auto;padding:20px;max-width:1100px}form{max-width:560px}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:6px;font:inherit;border:1px solid #899688;border-radius:6px}.check input{display:inline;width:auto;margin-right:10px}button{font:inherit;background:#24543b;color:white;padding:12px 18px;border:0;border-radius:6px;cursor:pointer}img{max-width:100%;height:auto;border:1px solid #899688}</style></head><body>${content}</body></html>`;
}
export function portalHeaders(nonce: string) {
  // Chromium makes a navigation POST's Origin opaque under no-referrer.
  // Send only the public origin: keep private paths out of Referer while
  // preserving the exact Origin required by the authenticated CSRF boundary.
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
}
