// Runs ONLY inside browser-private.ts's isolated child. No raw IPC or artifacts.
import { randomBytes } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';
import { createPaymentFillExecutor } from 'handrail-agent-sdk/server';
import type { VaultOperation, VaultPaymentDestination } from 'handrail-agent-sdk';

export async function cardFixture(context: BrowserContext, check: (v: unknown) => void): Promise<void> {
  const origin = 'https://card-fixture.invalid';
  // Fulfilled entirely in the browser fixture; the existing transport proxy
  // denies all outbound HTTPS. No payment server or form submission exists.
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === origin + '/') return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><title>Private card fixture</title><iframe src="/frame"></iframe>' });
    if (url === origin + '/frame') return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><form action="/unused"><input id="card" type="password" autocomplete="off" data-kind="card_number"></form>' });
    return route.abort();
  });
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push(e.message));
  await page.goto(origin + '/');
  const frame = page.frames().find(f => f.parentFrame() === page.mainFrame());
  if (!frame) throw Error('PRIVATE_CHECK_FAILED');
  await frame.locator('#card').waitFor();
  const destination: VaultPaymentDestination = { origin, profileRef: 'fixture-profile', leaseEpoch: 1,
    documentRef: 'fixture-document', navigationRevision: 1, frames: [{ frameRef: 'top', origin }, { frameRef: 'form', origin }],
    fieldRef: 'card', fieldKind: 'card_number', formEndpoint: origin + '/unused', purposeRef: 'fixture' };
  const request: VaultOperation = { operation: 'fill', identity: { jobId: 'job', originTaskRef: 'task', requestKey: 'request', instructionRevision: 1,
    host: { tenantRef: 'tenant', userRef: 'user', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'fixture' },
    native: {}, origin: { channelRef: 'web', routeRef: 'route', correlationRef: 'correlation' } }, jobRevision: 2, grantRef: 'grant', grantRevision: 1,
    effect: { actionRef: 'action', operationRef: 'private-card-fill', effectRef: 'effect' },
    item: { metadata: { kind: 'payment_method', instrument: 'credit_card' }, reference: { kind: 'payment_method', paymentRef: 'card', revision: 1 } }, destination };
  const value = { pan: `9${Array.from(randomBytes(15), b => b % 10).join('')}`, cardholderName: randomBytes(24).toString('hex'), expiryMonth: '12', expiryYear: '2099' };
  let current = true, writes = 0;
  let live = structuredClone(destination);
  const executor = createPaymentFillExecutor({ operationRef: 'private-card-fill',
    bind: r => ({ identity: r.identity, ...r.effect, providerRef: 'private-browser', idempotencyRef: 'effect', requestDigest: `sha256:${'a'.repeat(64)}` }),
    reconcile: async () => 'unknown',
  }, { withTarget: async (_r, _signal, run) => run({ destination: live, fill: async (field, isCurrent) => {
    // Browser owner derives target facts independently, then checks again in the
    // synchronous renderer assignment. No await occurs inside the final write.
    if (!current || !isCurrent() || frame.parentFrame() !== page.mainFrame()
      || new URL(page.url()).origin !== live.origin || new URL(frame.url()).origin !== live.frames[1].origin) return 'unknown';
    const applied = await frame.evaluate(({ field, expected }) => {
      const input = document.querySelector<HTMLInputElement>('#card');
      if (!input || location.origin !== expected.origin || input.id !== expected.fieldRef
        || input.type !== 'password' || input.dataset.kind !== expected.fieldKind || input.form?.action !== expected.formEndpoint) return false;
      input.value = field;
      return true;
    }, { field, expected: live });
    if (applied) writes++;
    return applied ? 'verified' : 'unknown';
  } }) });
  const signal = new AbortController().signal;
  for (const change of [
    (d: VaultPaymentDestination) => { (d as any).origin = 'https://wrong.invalid'; },
    (d: VaultPaymentDestination) => { (d.frames[1] as any).frameRef = 'wrong'; },
    (d: VaultPaymentDestination) => { (d as any).fieldRef = 'wrong'; },
    (d: VaultPaymentDestination) => { (d as any).navigationRevision++; },
  ]) {
    live = structuredClone(destination); change(live);
    check(await executor.dispatch(request, value, signal, () => current) === 'unknown');
    check(writes === 0);
  }
  live = structuredClone(destination); current = false;
  check(await executor.dispatch(request, value, signal, () => current) === 'unknown'); check(writes === 0);
  current = true;
  check(await executor.dispatch(request, value, signal, () => current) === 'verified'); check(writes === 1);
  check(await frame.locator('#card').inputValue() === value.pan);
  // Hostile reflected text is withheld in the private process, never emitted as
  // an observation. No screenshot/trace/HAR/video API is called for this surface.
  await frame.evaluate(v => { document.body.append(document.createTextNode(v)); }, value.pan);
  const dom = await frame.locator('body').innerText();
  check(dom.includes(value.pan));
  const observation = { status: 'observation_withheld' };
  const retained = JSON.stringify([logs, observation]);
  check(!retained.includes(value.pan) && !retained.includes(value.cardholderName));
  await page.close();
}
