const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('E:/Swypik/swypik/app/node_modules/@playwright/test');
const root = 'E:/Swypik/swypik-mobile-pilot';
const audit = 'E:/Swypik/audit-20260928-mobile-auth';
const log = fs.openSync(path.join(audit, 'browser-preview.log'), 'w');
const server = spawn(process.execPath, ['node_modules/expo/bin/cli', 'start', '--localhost', '--port', '8081'], {cwd: root, env: {...process.env, CI: '1'}, stdio: ['ignore', log, log]});
let browser;
(async () => {
  const url = 'http://127.0.0.1:8081';
  let ready = false;
  for (let i = 0; i < 45; i++) {
    if (server.exitCode !== null) throw new Error('Preview server exited');
    try { const response = await fetch(url + '/status', {signal: AbortSignal.timeout(1200)}); if (response.ok) {ready = true; break;} } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, 'Preview ready');
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 1});
  const errors = []; const consoleErrors = []; const authRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  page.on('request', request => {if (new URL(request.url()).pathname.startsWith('/api/auth/')) authRequests.push(request.url());});
  await page.goto(url + '/account', {waitUntil: 'networkidle', timeout: 45000});
  await page.getByText('Locul tău în Swypik.', {exact: true}).waitFor();
  assert.equal(await page.locator('input').count(), 0, 'No credentials requested when disabled');
  await page.screenshot({path: path.join(audit, 'account-mobile-web.png'), fullPage: true});
  const links = await page.locator('a').evaluateAll(anchors => anchors.map(a => ({text: a.textContent, href: a.getAttribute('href')})));
  const navigated = [];
  for (const route of ['/shop', '/', '/account']) {
    const link = page.locator('a').filter({has: undefined});
    const target = page.locator('a[href="' + route + '"]').first();
    assert.equal(await target.count(), 1, 'Navigation link exists: ' + route);
    await target.click();
    await page.waitForURL(url + route, {timeout: 15000});
    navigated.push(new URL(page.url()).pathname);
  }
  await page.getByText('Locul tău în Swypik.', {exact: true}).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'No horizontal overflow at mobile viewport');
  assert.deepEqual(errors, [], 'No uncaught JavaScript errors');
  assert.deepEqual(authRequests, [], 'Disabled auth never calls backend');
  const result = {status: 'passed', viewport: '390x844', navigated, credentialInputs: 0, authRequests: 0, pageErrors: errors, consoleErrors, horizontalOverflow: overflow, links, note: 'Browser web preview only, not physical Android/iOS or native login validation.'};
  fs.writeFileSync(path.join(audit, 'browser-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close();
  if (server.pid && server.exitCode === null) {try {execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {stdio: 'ignore'});} catch {}}
  fs.closeSync(log);
});