import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { managedBrowser } from '../dist/server/managed/browser.js';

// Real Chromium, synthetic provider pages. Only the provider transport and
// optional test-container sandbox prerequisite are substituted. Production keeps its sandbox
// and pinned-address HTTPS proxy; managed-network tests cover that boundary.
test('SDK browser fills private login, isolates accounts, persists session, and supports private human control', async t => {
  const launch = chromium.launch.bind(chromium);
  const password = randomBytes(24).toString('hex');
  t.mock.method(chromium, 'launch', async options => {
    const browser = await launch({ ...options, chromiumSandbox: process.env.HANDRAIL_TEST_BROWSER_SANDBOX !== '0' });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options), newPage = context.newPage.bind(context);
      context.newPage = async () => {
        await context.route('https://airline.example.com/**', async route => {
          if (route.request().url().endsWith('/points')) {
            const cookie = route.request().headers().cookie ?? '';
            return route.fulfill({ contentType: 'text/html', body: cookie.includes('session=')
              ? `<h1>Rewards</h1><p>Family member: 12,345 points</p><button onclick="document.querySelector('p').textContent='Balance refreshed: 12,345 points'">Refresh</button>`
              : '<h1>Sign in required</h1>' });
          }
          return route.fulfill({ contentType: 'text/html', body: `<!doctype html><form action="/points"><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password"></label><button type="button" onclick="document.cookie='session=fixture-session; Secure; SameSite=Strict';location.href='/points'">Sign in</button></form><p id="reflection"></p><button id="boundary">Boundary</button><script>document.querySelector('input[type=password]').addEventListener('input',e=>{document.getElementById('reflection').textContent=e.target.value;document.getElementById('boundary').textContent='x'.repeat(150)+e.target.value;});</script>` });
        });
        return newPage();
      };
      return context;
    };
    return browser;
  });
  const engine = managedBrowser({ executablePath: process.env.HANDRAIL_TEST_BROWSER_EXECUTABLE, maxSessions: 2 }, async () => ({ url: 'http://127.0.0.1:9', close: async () => {} }));
  t.after(() => engine.close());
  const account = { label: 'Family member', url: 'https://airline.example.com/login', origins: ['https://airline.example.com'], username: 'test-user', password, approved: true, revoked: false, expiresAt: Date.now() + 60000 };
  const signal = new AbortController().signal, current = async () => true;
  let opened = await engine.act('first', account, 'open', undefined, signal, current);
  assert.equal(opened.status, 'human_required');
  const filled = await engine.act('first', account, 'fill_login', undefined, signal, current);
  assert.equal(JSON.stringify(filled).includes(password), false); assert.equal(JSON.stringify(filled).includes(password.slice(0, 10)), false); assert.equal(JSON.stringify(filled).includes('test-user'), false);
  const login = filled.elements.find(e => e.label === 'Sign in'); assert.ok(login);
  await engine.act('first', account, 'click', login.ref, signal, current);
  let points;
  for (let n = 0; n < 20; n++) {
    points = await engine.act('first', account, 'inspect', undefined, signal, current);
    if (points.text?.includes('12,345')) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.match(points.text, /12,345 points/); assert.ok(account.state.cookies.some(c => c.name === 'session'));
  const other = { ...account, state: undefined };
  const isolated = await engine.act('second', other, 'open', 'https://airline.example.com/points', signal, current);
  assert.match(isolated.text, /Sign in required/);
  const human = await engine.human('first', account, 'view'); assert.equal(human.status, 'human_in_control'); assert.ok(human.image);
  assert.equal((await engine.act('first', account, 'inspect', undefined, signal, current)).status, 'human_in_control');
  assert.equal((await engine.human('first', account, 'finish')).status, 'ready');
  await engine.closeAccount('first');
  assert.equal((await engine.act('first', account, 'inspect', undefined, signal, current)).status, 'reopen_required');
  const restored = await engine.act('first', account, 'open', 'https://airline.example.com/points', signal, current);
  assert.match(restored.text, /12,345 points/);
  await assert.rejects(engine.act('first', account, 'open', 'https://other.example.com', signal, current));
  await assert.rejects(engine.act('first', account, 'inspect', undefined, signal, async () => false));
});
