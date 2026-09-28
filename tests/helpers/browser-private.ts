// PRIVATE child entrypoint: do not import into tests or public SDK exports.
// No screenshots, traces, HAR, video, dumps, console forwarding or raw errors.
import { randomBytes } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserServer } from 'playwright-core';

const [caseId, root] = process.argv.slice(2);
const report = { kind: 'receipt', status: 'failed', checks: 0, contextsClosed: 0, browsersClosed: 0, listenersClosed: 0 };
const servers: Server[] = [];
const sockets = new Set<Socket>();
const contexts: BrowserContext[] = [];
let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let browserPid: number | undefined;
let injected = false;
let fixtureHits = 0;
let denied = 0;
const deniedDestinations = new Map<string, number>();
const destinationKey = (url: URL) => url.origin + url.pathname;
const origins: string[] = [];
// Reserved invalid name; the allowlist rejects it before any DNS or connection.
const forbidden = 'http://outside.invalid';
const check = (value: unknown) => { if (!value) throw new Error('PRIVATE_CHECK_FAILED'); report.checks++; };
const inject = () => { injected = true; throw new Error(randomBytes(32).toString('hex')); };

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  servers.push(server); // ownership precedes any await, including bind failure
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_req, socket) => { denied++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => { denied++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); server.on('error', () => {}); resolve(); });
  });
  return server;
}
function origin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('PRIVATE_BIND_FAILED');
  return `http://127.0.0.1:${address.port}`;
}
function allowed(url: URL): boolean {
  return url.protocol === 'http:' && !url.username && !url.password && origins.includes(url.origin);
}

async function fixtures(): Promise<string> {
  const html = await readFile(new URL('../tests/fixtures/protected-page.html', import.meta.url), 'utf8');
  for (let index = 0; index < 2; index++) {
    const server = await listen((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Prevent untrusted Host headers and absolute request targets.
      if (!origins[index] || req.headers.host !== new URL(origins[index]).host || !req.url?.startsWith('/')) { res.writeHead(403).end(); return; }
      fixtureHits++;
      const url = new URL(req.url, origins[index]);
      if (url.pathname === '/redirect-ok') { res.writeHead(302, { Location: origins[1] + '/frame' }).end(); return; }
      if (url.pathname === '/redirect-denied') {
        // A reflected value in the redirect must never reach diagnostics.
        res.writeHead(302, { Location: forbidden + '/?value=' + (url.searchParams.get('value') ?? '') }).end(); return;
      }
      if (url.pathname === '/frame') { res.end('<!doctype html><title>Private frame</title><p id="frame-ready">Ready</p>'); return; }
      if (url.pathname === '/reflect') {
        const value = url.searchParams.get('value') ?? '';
        // Only generated hex canaries may be reflected by this fixture.
        if (!/^[a-f0-9]{64}$/.test(value)) { res.writeHead(400).end(); return; }
        res.end('<!doctype html><output id="network-reflection">' + value + '</output>'); return;
      }
      if (url.pathname === '/protected') { res.end(html.replace('{{FRAME}}', origins[1] + '/frame')); return; }
      res.writeHead(404).end();
    });
    origins.push(origin(server));
    if (caseId === 'F02_PARTIAL_LISTENER') inject();
  }
  // A transport proxy checks EVERY hop. Playwright route interception alone
  // does not re-intercept redirected requests. No forward DNS lookup occurs:
  // all accepted destinations have an exact generated 127.0.0.1 origin.
  const proxy = await listen((req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { denied++; res.writeHead(403).end(); return; }
    if (!allowed(url) || req.method !== 'GET') {
      denied++;
      const key = destinationKey(url); // no query/canary retained in this counter
      deniedDestinations.set(key, (deniedDestinations.get(key) ?? 0) + 1);
      res.writeHead(403).end(); return;
    }
    const upstream = request(url, { method: 'GET', headers: { host: url.host } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.setTimeout(5_000, () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    upstream.end();
  });
  return origin(proxy);
}

async function policyChecks(proxy: string): Promise<void> {
  const get = (target: string) => new Promise<number>((resolve, reject) => {
    const req = request(proxy, { path: target, method: 'GET' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject); req.setTimeout(5_000, () => req.destroy()); req.end();
  });
  check(await get(origins[0] + '/protected') === 200);
  check(await get(origins[1] + '/frame') === 200);
  check(await get(origins[0] + '/redirect-ok') === 302);
  check(await get(origins[0] + '/redirect-denied') === 302);
  const before = fixtureHits;
  for (const target of [forbidden, 'https://127.0.0.1:1', 'http://127.0.0.1:1', 'http://127.0.0.1:80', origins[0].replace('127.0.0.1', 'localhost'), origins[0].replace('http://', 'http://user:pass@')]) {
    check(await get(target) === 403);
  }
  check(fixtureHits === before);
  check(denied === 6);
}

async function launch(proxy: string): Promise<void> {
  let chromium: typeof import('playwright-core')['chromium'];
  try { ({ chromium } = await import('playwright-core')); }
  catch { report.status = 'unverified_dependency_prerequisite'; throw new Error('PRIVATE_PREREQUISITE'); }
  const executable = process.env.HANDRAIL_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
  try { await access(executable, constants.X_OK); }
  catch { report.status = 'unverified_browser_prerequisite'; throw new Error('PRIVATE_PREREQUISITE'); }
  try {
    browserServer = await chromium.launchServer({
      executablePath: executable, host: '127.0.0.1', headless: true, timeout: 15_000,
      artifactsDir: root,
      proxy: { server: proxy, bypass: '<-loopback>' },
      args: [
        '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
        '--disable-quic', '--disable-extensions', '--disable-component-update',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    });
  } catch { report.status = 'unverified_browser_prerequisite'; throw new Error('PRIVATE_PREREQUISITE'); }
  browserPid = browserServer.process().pid;
  process.send?.({ kind: 'browser_pid', pid: browserPid });
  browser = await chromium.connect(browserServer.wsEndpoint());
  if (caseId === 'B02_PARTIAL_BROWSER') inject();
}

async function context(): Promise<BrowserContext> {
  const result = await browser!.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  contexts.push(result);
  result.setDefaultTimeout(5_000);
  result.setDefaultNavigationTimeout(5_000);
  // Transport proxy remains authoritative for redirects. Block WebSockets even
  // at fixture origins; there are no WebSocket fixture operations in this suite.
  await result.routeWebSocket('**/*', socket => socket.close());
  if (caseId === 'B03_PARTIAL_CONTEXT') inject();
  return result;
}

async function isolation(): Promise<void> {
  const first = await context();
  const second = await context();
  check(first !== second && browser!.contexts().length === 2);
  const pages = [await first.newPage(), await second.newPage()];
  const values = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  check(values[0] !== values[1]);
  for (let i = 0; i < 2; i++) {
    const page = pages[i];
    await page.goto(origins[0] + '/protected');
    check(await page.evaluate(() => !document.cookie && localStorage.length === 0 && sessionStorage.length === 0));
    check(await page.evaluate(async () => (await indexedDB.databases()).length === 0));
    await page.evaluate(async value => {
      document.cookie = `private=${value}; SameSite=Strict; Path=/`;
      localStorage.setItem('private', value);
      sessionStorage.setItem('private', value);
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('private', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('values');
        open.onerror = () => reject(new Error('STORE_FAILED'));
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('values', 'readwrite');
          transaction.objectStore('values').put(value, 'private');
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(new Error('STORE_FAILED')); };
        };
      });
      (document.querySelector('#protected') as HTMLInputElement).value = value;
      document.querySelector('#reflection')!.textContent = value;
      document.querySelector('#hidden')!.setAttribute('aria-label', value);
      document.querySelector('#hidden')!.setAttribute('data-encoded', btoa(value));
      (document.querySelector('#pixels') as HTMLCanvasElement).getContext('2d')!.fillText(value, 0, 20);
      console.log(value); // deliberate tainted console sink; no listener forwards it
    }, values[i]);
    check(await page.evaluate(value =>
      (document.querySelector('#protected') as HTMLInputElement).value === value &&
      document.querySelector('#reflection')!.textContent === value &&
      document.querySelector('#hidden')!.getAttribute('aria-label') === value &&
      document.querySelector('#hidden')!.getAttribute('data-encoded') === btoa(value) &&
      (document.querySelector('#pixels') as HTMLCanvasElement).getContext('2d')!
        .getImageData(0, 0, 800, 40).data.some(channel => channel !== 0), values[i]));
    const frame = page.frames().find(frame => frame.url() === origins[1] + '/frame');
    check(!!frame && await frame.evaluate(() => !!document.querySelector('#frame-ready')));
    check(await frame!.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
    await frame!.evaluate(() => localStorage.setItem('frame-only', 'yes'));
    check(await page.evaluate(() => localStorage.getItem('frame-only') === null));
  }
  // Read back BOTH after all writes: catches shared contexts and storage.
  for (let i = 0; i < 2; i++) {
    check(await pages[i].evaluate(async value => {
      const stored = await new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('private', 1);
        open.onerror = () => reject(new Error('STORE_FAILED'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction('values').objectStore('values').get('private');
          read.onsuccess = () => { db.close(); resolve(read.result); };
          read.onerror = () => { db.close(); reject(new Error('STORE_FAILED')); };
        };
      });
      return document.cookie === `private=${value}` && localStorage.getItem('private') === value &&
        sessionStorage.getItem('private') === value && stored === value;
    }, values[i]));
  }
  const page = pages[0];
  const reflected = await first.newPage();
  await reflected.goto(origins[0] + '/reflect?value=' + values[0]);
  check(await reflected.evaluate(value => document.querySelector('#network-reflection')!.textContent === value, values[0]));
  await reflected.close();
  if (caseId === 'B04_TEST_FAILURE') inject();
  await page.goto(origins[0] + '/redirect-ok');
  check(page.url() === origins[1] + '/frame');
  // No route abort can mask a proxy bypass: each request must reach the proxy's
  // deny branch, and the fixture listeners must receive no destination request.
  async function deniedNavigation(target: string, destination = target): Promise<void> {
    const key = destinationKey(new URL(destination));
    const before = deniedDestinations.get(key) ?? 0;
    await page.goto(target).catch(() => {});
    check((deniedDestinations.get(key) ?? 0) > before);
  }
  await deniedNavigation(origins[0] + '/redirect-denied?value=' + values[0], forbidden + '/');
  // Port 80 is browser-eligible and cannot be either ephemeral fixture port.
  // Both this wrong-port destination and the unrelated hostname must reach the
  // same proxy deny branch; a navigation error alone proves nothing about it.
  for (const target of [forbidden + '/?value=' + values[0], origins[0].replace('127.0.0.1', 'localhost') + '/', 'http://127.0.0.1:80/']) {
    await deniedNavigation(target);
  }
  // Chromium rejects unsafe ports before proxy admission. Keep the triggering
  // case, but require its exact private browser-policy failure and no proxy hit.
  // F01 separately sends port 1 through the proxy and requires a 403 response.
  const unsafeTarget = 'http://127.0.0.1:1/';
  const unsafeKey = destinationKey(new URL(unsafeTarget));
  const unsafeBefore = deniedDestinations.get(unsafeKey) ?? 0;
  const [unsafeRequest] = await Promise.all([
    page.waitForEvent('requestfailed', {
      predicate: req => req.isNavigationRequest() && req.url() === unsafeTarget,
    }),
    page.goto(unsafeTarget).catch(() => {}),
  ]);
  check(unsafeRequest.failure()?.errorText === 'net::ERR_UNSAFE_PORT');
  check((deniedDestinations.get(unsafeKey) ?? 0) === unsafeBefore);
  await page.goto(origins[0] + '/protected');
  const frameDestination = forbidden + '/';
  const before = deniedDestinations.get(frameDestination) ?? 0;
  await page.evaluate(target => new Promise<void>(resolve => {
    const frame = document.createElement('iframe');
    frame.onload = () => resolve(); frame.onerror = () => resolve();
    frame.src = target; document.body.append(frame);
  }), forbidden + '/?value=' + values[0]);
  check((deniedDestinations.get(frameDestination) ?? 0) > before);
}

async function cleanup(): Promise<boolean> {
  let ok = true;
  for (const context of contexts) {
    try { await context.close(); check(context.pages().length === 0); report.contextsClosed++; }
    catch { ok = false; }
  }
  if (browserServer) {
    try {
      await browserServer.close();
      check(!browser?.isConnected());
      const child = browserServer.process();
      check(child.exitCode !== null || child.signalCode !== null);
      // The root process exiting is insufficient if a Chromium child survives.
      if (browserPid) {
        let alive = false;
        try { process.kill(-browserPid, 0); alive = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('PRIVATE_CHILD_CLEANUP_FAILED'); }
        if (alive) {
          try { process.kill(-browserPid, 'SIGKILL'); } catch {}
          throw new Error('PRIVATE_CHILD_CLEANUP_FAILED');
        }
      }
      report.browsersClosed++;
    } catch { ok = false; try { await browserServer.kill(); } catch {} }
  }
  // Close all sockets (including keepalives) before awaiting listener close.
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      check(!server.listening); report.listenersClosed++;
    } catch { ok = false; }
  }
  return ok;
}

async function main(): Promise<void> {
  process.umask(0o077);
  try {
    check((await stat(root)).mode % 0o1000 === 0o700);
    // Nonsecret marker verifies owned artifact cleanup without retaining canaries.
    await writeFile(join(root, 'owned-marker'), 'private-fixture', { mode: 0o600 });
    if (caseId === 'F03_OUTPUT_GATE') {
      // Raw stdout/stderr and thrown canaries are intentionally discarded.
      const value = randomBytes(32).toString('hex');
      console.log(value); console.error(value); inject();
    }
    const proxy = await fixtures();
    if (caseId === 'F01_NETWORK_POLICY') await policyChecks(proxy);
    else { await launch(proxy); await isolation(); }
    report.status = 'passed';
  } catch {
    if (injected) report.status = 'passed';
    // All other raw failures are discarded, preserving only fixed prerequisite codes.
  } finally {
    if (!await cleanup()) report.status = 'failed';
  }
  process.send?.(report);
  process.disconnect?.();
}
void main().catch(() => { process.exitCode = 1; process.disconnect?.(); });
