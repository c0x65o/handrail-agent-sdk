import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from 'playwright-core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserProxy, website } from './network.js';

export type SavedBrowserState = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface PrivateAccount {
  label: string; url: string; origins: string[]; username: string; password: string;
  approved: boolean; revoked: boolean; expiresAt: number; state?: SavedBrowserState;
  humanControl?: { interactionRef: string; expiresAt: number };
}
type Session = { browser: Browser; context: BrowserContext; page: Page; close(): Promise<void>;
  generation: string; lastUsed: number; human: boolean; elements: Map<string, { handle: ElementHandle<HTMLElement | SVGElement>; label: string; document: string }> };
export interface BrowserView { status: 'ready' | 'verification_required'; loginAvailable: boolean; text: string; elements: Array<{ ref: string; role: string; label: string }> }

/** SDK-owned Chromium controller. Only private authenticated portal routes may
 * call screenshot/human. Agent output passes through the bounded text filter. */
export function managedBrowser(options: { executablePath?: string; maxSessions?: number; idleMs?: number },
  // Internal test seam: not exposed by createManagedAgentCapabilities.
  proxyFactory = createBrowserProxy) {
  const sessions = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  let stopped = false;
  let cleanup: ReturnType<typeof setInterval> | undefined;
  const maxSessions = options.maxSessions ?? 4, idleMs = options.idleMs ?? 300_000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 32 || !Number.isSafeInteger(idleMs) || idleMs < 1000)
    throw Error('BROWSER_CONFIG_INVALID');
  function allowed(page: Page, account: PrivateAccount) {
    try { return account.origins.includes(new URL(page.url()).origin); } catch { return false; }
  }
  async function stop(id: string) { const s = sessions.get(id); if (s) { sessions.delete(id); await s.close(); } }
  async function start(id: string, account: PrivateAccount): Promise<Session> {
    if (stopped || !account.approved || account.revoked || account.expiresAt <= Date.now()) throw Error('ACCOUNT_UNAVAILABLE');
    for (const [key, s] of sessions) if (s.lastUsed + idleMs < Date.now()) await stop(key);
    const existing = sessions.get(id);
    if (existing) { existing.lastUsed = Date.now(); return existing; }
    if (opening.has(id)) return opening.get(id)!;
    if (sessions.size + opening.size >= maxSessions) throw Error('BROWSER_CAPACITY');
    const launch = (async () => {
      const proxy = await proxyFactory(account.origins);
      let browser: Browser | undefined;
      let temporary: string | undefined;
      try {
        if (process.env.PWDEBUG || /pw:|\*/.test(process.env.DEBUG ?? '')) throw Error('PRIVATE_BROWSER_DEBUG_FORBIDDEN');
        temporary = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ha-browser-'));
        browser = await chromium.launch({ ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }), headless: true, timeout: 15000,
          env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
          chromiumSandbox: true, proxy: { server: proxy.url, bypass: '<-loopback>' },
          args: ['--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter', '--disable-quic',
            '--disable-extensions', '--disable-component-update', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
        });
        const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: false,
          serviceWorkers: 'block', ...(account.state === undefined ? {} : { storageState: account.state }) });
        context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(15000);
        await context.routeWebSocket('**/*', socket => socket.close());
        await context.route('**/*', route => {
          try {
            const u = website(route.request().url());
            return account.origins.includes(u.origin) ? route.continue() : route.abort();
          } catch { return route.abort(); }
        });
        const page = await context.newPage();
        context.on('page', p => { if (p !== page) void p.close().catch(() => {}); });
        const owned = browser, directory = temporary;
        const s: Session = { browser, context, page, generation: randomUUID(), lastUsed: Date.now(), human: false, elements: new Map(),
          async close() { try { await owned.close(); } finally { await proxy.close(); await rm(directory, { recursive: true, force: true }); } } };
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) { s.generation = randomUUID(); s.elements.clear(); } });
        page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
        if (stopped) { await s.close(); throw Error('BROWSER_CLOSED'); }
        sessions.set(id, s);
        if (!cleanup) {
          cleanup = setInterval(() => {
            for (const [key, entry] of sessions) if (entry.lastUsed + idleMs < Date.now()) void stop(key).catch(() => {});
          }, Math.min(idleMs, 30_000));
          cleanup.unref();
        }
        return s;
      } catch { if (browser) await browser.close().catch(() => {}); await proxy.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); throw Error('BROWSER_LAUNCH_FAILED'); }
    })();
    opening.set(id, launch);
    try { return await launch; } finally { opening.delete(id); }
  }
  async function view(s: Session, account: PrivateAccount): Promise<BrowserView> {
    if (!allowed(s.page, account)) throw Error('BROWSER_ORIGIN_CHANGED');
    const generation = s.generation;
    // No input values, HTML attributes, URLs, scripts, storage or markup returned.
    const raw = await s.page.evaluate(() => {
      const root = document.body.cloneNode(true) as HTMLElement;
      root.querySelectorAll('input,textarea,select,script,style,noscript,svg,canvas,iframe,[hidden]').forEach(e => e.remove());
      const content = (root.textContent ?? '').replace(/\s+/g, ' ');
      // Never truncate through a secret before redaction. Oversized pages are withheld.
      const text = content.length <= 1_000_000 ? content : '[Page text exceeds inspection limit]';
      const elements = [...document.querySelectorAll('button,a[href],input[type=submit],[role=button]')]
        .map((e, index) => ({ index, role: e.tagName.toLowerCase(), label: (e.textContent || e.getAttribute('aria-label') || (e as HTMLInputElement).value || '').trim(),
          visible: (e as HTMLElement).offsetWidth > 0 && (e as HTMLElement).offsetHeight > 0 }))
        .filter(e => e.visible && e.label && e.label.length <= 10_000).slice(0, 60);
      return { text, elements, password: !!document.querySelector('input[type=password]') };
    });
    const state = await s.context.storageState();
    const secrets = [account.password, account.username, ...state.cookies.map(c => c.value),
      ...state.origins.flatMap(o => o.localStorage.map(x => x.value))].filter(Boolean).sort((a, b) => b.length - a.length);
    const scrub = (input: string) => {
      let text = input;
      for (const value of secrets) for (const variant of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) text = text.split(variant).join('[private]');
      return text.replace(/[A-Za-z0-9_+/=-]{32,}/g, '[private]').slice(0, 8000);
    };
    if (generation !== s.generation || !allowed(s.page, account)) throw Error('BROWSER_DOCUMENT_CHANGED');
    await Promise.all([...s.elements.values()].map(e => e.handle.dispose())); s.elements.clear();
    const handles = await s.page.$$('button,a[href],input[type=submit],[role=button]');
    const elements = raw.elements.flatMap(e => {
      const handle = handles[e.index]; if (!handle) return [];
      const ref = createHash('sha256').update(`${generation}:${e.index}:${e.label}`).digest('hex').slice(0, 24);
      s.elements.set(ref, { handle, label: e.label, document: generation });
      return [{ ref, role: e.role, label: scrub(e.label).slice(0, 160) }];
    });
    const retained = new Set([...s.elements.values()].map(e => e.handle));
    await Promise.all(handles.filter(h => !retained.has(h)).map(h => h.dispose()));
    // A login form is an agent action, not a human blocker. Verification is a
    // separate signal; incidental mentions in page copy do not prove a challenge.
    const verification = await s.page.locator('input[autocomplete="one-time-code"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [data-sitekey]').evaluateAll(nodes =>
      nodes.some(node => (node as HTMLElement).offsetWidth > 0 && (node as HTMLElement).offsetHeight > 0));
    return { status: verification ? 'verification_required' : 'ready', loginAvailable: raw.password, text: scrub(raw.text), elements };
  }
  async function fill(s: Session, account: PrivateAccount) {
    if (!allowed(s.page, account)) throw Error('BROWSER_ORIGIN_CHANGED');
    // Synchronous renderer check and assignment bind the exact document, origin,
    // field and form endpoint. Cross-frame and ambiguous logins require a human.
    return s.page.evaluate(({ origin, username, password }) => {
      if (location.origin !== origin) return false;
      const fields = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].filter(e => e.offsetWidth > 0 && e.offsetHeight > 0);
      if (fields.length !== 1) return false;
      const target = fields[0]!, form = target.form;
      if (!form || new URL(form.action || location.href).origin !== origin) return false;
      const users = [...form.querySelectorAll<HTMLInputElement>('input[type=email],input[autocomplete=username],input[name*=user i],input[name*=account i],input[name*=login i]')]
        .filter(e => e !== target && e.type !== 'hidden' && e.type !== 'password' && e.offsetWidth > 0);
      if (users.length !== 1) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(users[0], username); setter.call(target, password);
      users[0]!.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('input', { bubbles: true }));
      users[0]!.dispatchEvent(new Event('change', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { origin: new URL(s.page.url()).origin, username: account.username, password: account.password });
  }
  return {
    async act(id: string, account: PrivateAccount, action: 'open' | 'inspect' | 'click' | 'fill_login', input: string | undefined,
      signal: AbortSignal, current: () => Promise<boolean>) {
      const check = async () => { if (signal.aborted || !await current()) throw Error('BROWSER_AUTHORITY_LOST'); };
      await check();
      const previous = sessions.get(id);
      if (action !== 'open' && !previous) return { status: 'reopen_required' };
      const s = await start(id, account);
      const abort = () => { void stop(id).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await check(); if (s.human) return { status: 'human_in_control' };
        if (action === 'open') {
          const url = website(input || account.url); if (!account.origins.includes(url.origin)) throw Error('BROWSER_DESTINATION_DENIED');
          await s.page.goto(url.href, { waitUntil: 'domcontentloaded' });
        } else if (action === 'click') {
          const e = s.elements.get(input ?? '');
          if (!e || e.document !== s.generation || !allowed(s.page, account)) return { status: 'inspect_required' };
          await check();
          const same = await e.handle.evaluate((node, label) => node.isConnected &&
            (node.textContent || node.getAttribute('aria-label') || (node as HTMLInputElement).value || '').trim() === label, e.label).catch(() => false);
          if (!same) return { status: 'inspect_required' };
          await e.handle.click();
        } else if (action === 'fill_login') { await check(); if (!await fill(s, account)) return { status: 'human_required' }; }
        await check();
        const output = await view(s, account);
        account.state = await s.context.storageState();
        await check(); return output;
      } finally { signal.removeEventListener('abort', abort); }
    },
    async human(id: string, account: PrivateAccount, action: 'view' | 'click' | 'type' | 'key' | 'finish', value?: string, x?: number, y?: number) {
      const s = sessions.get(id);
      if (!s) return { status: action === 'finish' ? 'ready' : 'reopen_required' };
      s.human = true; s.lastUsed = Date.now(); s.elements.clear();
      if (!allowed(s.page, account)) throw Error('BROWSER_ORIGIN_CHANGED');
      if (action === 'click') {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x! < 0 || x! >= 1100 || y! < 0 || y! >= 760) throw Error('BROWSER_INPUT_INVALID');
        await s.page.mouse.click(x!, y!);
      } else if (action === 'type') {
        if (!value || value.length > 4096) throw Error('BROWSER_INPUT_INVALID');
        await s.page.keyboard.insertText(value);
      } else if (action === 'key') {
        if (!['Tab', 'Enter', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp'].includes(value ?? '')) throw Error('BROWSER_INPUT_INVALID');
        await s.page.keyboard.press(value!);
      } else if (action === 'finish') { account.state = await s.context.storageState(); s.human = false; return { status: 'ready' }; }
      const bytes = await s.page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 8000 });
      return { status: 'human_in_control', image: bytes.toString('base64') };
    },
    closeAccount: stop,
    async close() { stopped = true; if (cleanup) clearInterval(cleanup); await Promise.allSettled(opening.values()); await Promise.allSettled([...sessions.keys()].map(stop)); },
    async ready() {
      const { access } = await import('node:fs/promises');
      try { await access(options.executablePath ?? chromium.executablePath()); return true; } catch { return false; }
    },
  };
}
