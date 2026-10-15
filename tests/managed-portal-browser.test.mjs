import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { portalHeaders, portalPage } from '../dist/server/managed/portal.js';
import { hostedApprovalPage, privateInputReceipt } from '../dist/server/managed/hosted-approval.js';

test('real browser private forms preserve CSRF origin without disclosing the private link', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const origin = 'https://private-portal.example.test';
    const path = `/agent-access/${'a'.repeat(64)}`;
    const csrf = 'test-only-csrf';
    const submissions = [];
    let html;
    await context.route(`${origin}/**`, async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        submissions.push({ headers: await request.allHeaders(), form: new URLSearchParams(request.postData()) });
        await route.fulfill({ status: 200, body: 'Saved' });
      } else await route.fulfill({ status: 200, headers: portalHeaders('fixture-nonce'), body: html });
    });
    const page = await context.newPage();
    html = hostedApprovalPage({ csrf, path, nonce: 'fixture-nonce', action: {
      type: 'computer_use_approval_request', request_id: 'original-request', turn_id: 'original-turn',
      request: { type: 'browser_origin_access', origin: 'https://example.com', reason: null },
    } });
    await page.goto(origin + path);
    await page.getByRole('button', { name: 'Allow this website', exact: true }).click();
    await page.waitForLoadState();
    assert.equal(submissions[0].form.get('decision'), 'approve');
    html = portalPage({ csrf, path, nonce: 'fixture-nonce', kind: 'credentials', label: 'Test account', url: 'https://example.com' });
    await page.goto(origin + path);
    await page.getByLabel('Username or membership number').fill('test-user');
    await page.getByLabel('Password', { exact: true }).fill('test-only-secret');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save securely and continue' }).click();
    await page.waitForLoadState();
    assert.equal(submissions.length, 2);
    html = hostedApprovalPage({ csrf, path, nonce: 'fixture-nonce', action: {
      type: 'computer_use_approval_request', request_id: 'login-request', turn_id: 'original-turn',
      request: {type:'browser_authentication',credential_origin:'https://example.com',reason:null,options:[],fields:[
        {id:'email',label:'Email',type:'email',required:true},{id:'password',label:'Password',type:'password',required:true}]},
    } });
    await page.goto(origin + path);
    await page.getByLabel('Email', {exact:true}).fill('fixture@example.com');
    await page.getByLabel('Password', {exact:true}).fill('test-only-private-value');
    await page.getByLabel('Password', {exact:true}).press('Enter');
    await page.waitForLoadState();
    assert.equal(submissions[2].form.get('action'),'submit','Enter in a password field must submit, never cancel');
    await page.goto(origin + path);
    await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
    await page.waitForLoadState();
    assert.equal(submissions[3].form.get('action'),'cancel');
    assert.equal(submissions[3].form.has('field_1'),false);
    for (const { headers, form } of submissions) {
      assert.equal(headers.origin, origin);
      assert.equal(headers.referer, `${origin}/`);
      assert.equal(form.get('csrf'), csrf);
    }
  } finally { await browser.close(); }
});

test('private receipt follows the next verification step on mobile without reposting a secret',async()=>{
  const browser=await chromium.launch({headless:true});
  const path='/agent-access/original',next='/agent-access/next';let posts=0;
  const action={type:'computer_use_approval_request',request_id:'otp-request',turn_id:'original-turn',
    request:{type:'browser_authentication',credential_origin:'https://example.com',reason:null,options:[],
      fields:[{id:'code',label:'Verification code',type:'text',required:true}]}};
  const server=createServer((request,response)=>{
    if(request.method==='POST') {
      posts++;request.resume();
      response.writeHead(200,portalHeaders('receipt'));
      response.end(privateInputReceipt({path,nonce:'receipt',decision:'submit',refresh:true}));return;
    }
    if(posts&&request.url===path){response.writeHead(303,{location:next});response.end();return;}
    response.writeHead(200,portalHeaders('form'));
    response.end(hostedApprovalPage({action,csrf:'csrf',path:posts?next:path,nonce:'form',followUp:posts>0}));
  });
  try {
    // Loopback HTTP fixture exercises real redirects/navigation, not a proxy
    // or a production credential surface. The separate test above checks HTTPS.
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
    await page.goto(origin+path);
    await page.getByLabel('Verification code',{exact:true}).fill('fixture-private-code');
    await page.getByRole('button',{name:'Continue securely'}).click();
    await page.waitForURL(origin+next,{timeout:10000});
    assert.equal(posts,1);assert.equal(await page.getByLabel('Verification code',{exact:true}).inputValue(),'');
    assert.match(await page.textContent('body'),/another sign-in step/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
