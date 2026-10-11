const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function portalPage(input: { label: string; url: string; csrf: string; kind: 'credentials' | 'browser'; path: string; nonce: string }) {
  const label = escape(input.label), site = escape(input.url), csrf = escape(input.csrf);
  const content = input.kind === 'credentials'
    ? `<h1>Connect ${label}</h1><p>Website: <strong>${site}</strong></p><p>Your login stays in encrypted storage. The assistant can use it for this website without seeing your password.</p>
       <form method="post" action="${escape(input.path)}"><input type="hidden" name="csrf" value="${csrf}">
       <label>Username or membership number<input name="username" autocomplete="username" required maxlength="512"></label>
       <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label>
       <label>Additional website origins, if needed for sign-in<input name="origins" placeholder="https://accounts.example.com" maxlength="2048"></label>
       <label class="check"><input type="checkbox" name="consent" value="yes" required> Save this login and allow the assistant to use this account on the listed websites for the next 30 days.</label>
       <button>Save securely and continue</button></form>`
    : `<h1>Continue ${label} sign-in</h1><p>Website: <strong>${site}</strong></p><p>You control this browser while this page is open. Click the image, then enter text below or use the keyboard buttons. Verification codes stay out of chat.</p>
       <p id="status" role="status">Loading browser…</p><img id="screen" alt="Your private browser session" width="1100" height="760">
       <form id="entry"><label>Text for the selected field<input id="private" type="password" autocomplete="off" maxlength="4096"></label><button>Type privately</button></form>
       <button data-key="Tab">Tab</button> <button data-key="Enter">Enter</button> <button data-key="Backspace">Backspace</button> <button id="refresh">Refresh view</button>
       <p><button id="finish">I'm done — return control to the assistant</button></p>
       <script nonce="${escape(input.nonce)}">
       const endpoint=${JSON.stringify(input.path)}, csrf=${JSON.stringify(input.csrf)};
       const screen=document.getElementById('screen'), status=document.getElementById('status');let busy=false;
       async function send(action,extra={}){if(busy)return;busy=true;status.textContent='Working…';try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf,action,...extra})});const v=await r.json();if(!r.ok)throw Error();if(v.image)screen.src='data:image/jpeg;base64,'+v.image;status.textContent=v.status==='ready'?'Control returned. You can close this page.':v.status==='reopen_required'?'This browser session ended. Click “I’m done” so the assistant can reopen the account.':'You are in control.';}catch{status.textContent='This session is unavailable. Return to your conversation.';}finally{busy=false;}}
       screen.addEventListener('click',e=>{const r=screen.getBoundingClientRect();send('click',{x:Math.floor((e.clientX-r.left)*1100/r.width),y:Math.floor((e.clientY-r.top)*760/r.height)});});
       document.getElementById('entry').addEventListener('submit',e=>{e.preventDefault();const field=document.getElementById('private'),value=field.value;field.value='';send('type',{value});});
       document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>send('key',{value:b.dataset.key}));
       document.getElementById('refresh').onclick=()=>send('view');document.getElementById('finish').onclick=()=>send('finish');send('view');
       </script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure account access</title>
    <style nonce="${escape(input.nonce)}">body{font:17px system-ui;color:#202820;background:#f7f8f4;margin:32px auto;padding:20px;max-width:1100px}form{max-width:560px}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:6px;font:inherit;border:1px solid #899688;border-radius:6px}.check input{display:inline;width:auto;margin-right:10px}button{font:inherit;background:#24543b;color:white;padding:12px 18px;border:0;border-radius:6px;cursor:pointer}img{max-width:100%;height:auto;border:1px solid #899688}</style></head><body>${content}</body></html>`;
}
export function portalHeaders(nonce: string) {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
}
