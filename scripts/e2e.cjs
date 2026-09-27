// Run after scripts/build.ps1. Requires Playwright (via installation or NODE_PATH).
// Uses only temporary files, isolated browser storage and a labeled Ilaria fixture.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'swypik-e2e-'));
  const reportDir = process.env.SWYPIK_TEST_REPORT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'swypik-report-'));
  fs.mkdirSync(reportDir, { recursive: true });
  const results = [], errors = [], calls = [];
  let browser, app;
  const fixture = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => body += part);
    req.on('end', () => {
      const request = JSON.parse(body);
      calls.push(request);
      res.setHeader('Content-Type', 'application/json');
      if (request.prompt === 'FAIL_TEST') {
        res.writeHead(503); res.end(JSON.stringify({error:'E2E fixture unavailable'}));
      } else res.end(JSON.stringify({reply:'E2E fixture: <script>window.injected=true</script> ' + request.prompt}));
    });
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  async function test(name, action) {
    const start = Date.now();
    try { await action(); results.push({name, status:'PASS', ms:Date.now()-start}); console.log('PASS:', name); }
    catch (error) { results.push({name, status:'FAIL', error:error.message, ms:Date.now()-start}); console.error('FAIL:',name,error.message); }
  }
  try {
    fs.mkdirSync(path.join(workspace,'empty'));
    fs.writeFileSync(path.join(workspace,'hello.txt'), 'Text fixture <script>window.injected=true</script>');
    fs.writeFileSync(path.join(workspace,'binary.bin'), Buffer.from([0,255,1]));
    fs.writeFileSync(path.join(workspace,'large.txt'), 'x'.repeat(256*1024+1));
    const integration = path.join(workspace,'integrations.json');
    fs.writeFileSync(integration, JSON.stringify({platform_url:'https://example.com',workspaces:[]}));
    app = spawn(path.join(root,'bin','swypik-os.exe'), ['-headless','-port','0','-ilaria-url',`http://127.0.0.1:${fixture.address().port}`], {
      cwd:workspace, windowsHide:true,
      env:{...process.env, ILARIA_API_TOKEN:'', SWYPIK_WORKSPACE_DIR:workspace, SWYPIK_STATE_DIR:path.join(workspace,'data'), SWYPIK_SWARM_ENABLED:'false', SWYPIK_BIND_HOST:'127.0.0.1', SWYPIK_STATIC_DIR:'', SWYPIK_DESKTOP_CONFIG:integration},
    });
    let log = '';
    const endpoint = await new Promise((resolve,reject) => {
      const timeout = setTimeout(()=>reject(new Error('OS startup timed out: '+log)),15000);
      const receive = chunk => { log += chunk; const match = log.match(/READY \((http:\/\/127\.0\.0\.1:\d+)\)/); if(match){clearTimeout(timeout);resolve(match[1]);} };
      app.stdout.on('data',receive); app.stderr.on('data',receive);
      app.once('error',error=>{clearTimeout(timeout);reject(error);});
      app.once('exit',code=>{clearTimeout(timeout);reject(new Error('OS exited: '+code));});
    });
    browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.goto(endpoint);
    await test('Desktop boots with application catalog',async()=>{
      await page.locator('#app-grid .app-card').first().waitFor();
      assert.ok(await page.locator('#app-grid .app-card').count()>5);
    });
    await test('Search, app details, pin and reload persistence',async()=>{
      await page.locator('#workspace-search').fill('movies');
      await page.locator('#app-grid .app-card').first().click();
      await page.locator('#app-dialog').waitFor({state:'visible'});
      const pin = page.locator('#app-detail').getByRole('button',{name:/^(Unpin|Pin app)$/});
      const before = await pin.textContent();
      await pin.click();
      const expected = before === 'Unpin' ? 'Pin app' : 'Unpin';
      assert.equal(await pin.textContent(),expected);
      await page.reload();
      await page.locator('#app-grid .app-card').first().waitFor();
      await page.locator('#workspace-search').fill('movies');
      await page.locator('#app-grid .app-card').first().click();
      assert.equal(await page.locator('#app-detail').getByRole('button',{name:expected,exact:true}).textContent(),expected);
      await page.keyboard.press('Escape');
    });
    await test('File text preview is inert',async()=>{
      await page.getByRole('button',{name:'Files',exact:true}).click();
      await page.getByRole('button',{name:'Preview file hello.txt',exact:true}).click();
      await page.locator('.file-preview').filter({hasText:'Text fixture'}).waitFor();
      assert.equal(await page.evaluate(()=>window.injected),undefined);
    });
    await test('Binary and oversized previews fail visibly',async()=>{
      await page.getByRole('button',{name:'Preview file binary.bin',exact:true}).click();
      await page.locator('.file-preview').filter({hasText:'Binary file'}).waitFor();
      await page.getByRole('button',{name:'Preview file large.txt',exact:true}).click();
      await page.locator('.file-preview').filter({hasText:'256 KB'}).waitFor();
    });
    await test('Empty directory and back navigation',async()=>{
      await page.getByRole('button',{name:'Open folder empty',exact:true}).click();
      await page.locator('#file-grid').filter({hasText:'This folder is empty'}).waitFor();
      await page.getByRole('button',{name:'Previous folder',exact:true}).click();
      await page.getByRole('button',{name:'Preview file hello.txt',exact:true}).waitFor();
    });
    await test('Terminal executes a real harmless Windows command',async()=>{
      await page.locator('[data-view="terminal"]').click();
      await page.locator('#terminal-input').fill('echo SWYPIK_E2E_OK');
      await page.locator('#terminal-input').press('Enter');
      await page.waitForFunction(()=>document.getElementById('terminal-input').value==='');
      assert.match(await page.locator('#terminal-output').textContent(),/SWYPIK_E2E_OK/);
    });
    await test('Blocked terminal command retains input and reports failure',async()=>{
      await page.locator('#terminal-input').fill('shutdown');
      await page.locator('#terminal-input').press('Enter');
      await page.locator('#terminal-output').filter({hasText:'SECURITY REJECTED'}).waitFor();
      assert.equal(await page.locator('#terminal-input').inputValue(),'shutdown');
    });
    await test('Ilaria fixture reply is visible, inert and carries history',async()=>{
      for(const prompt of ['E2E hello','E2E followup']){
        await page.locator('#omnibar-input').fill(prompt);
        await page.locator('#omnibar-input').press('Enter');
        await page.waitForFunction(()=>!document.getElementById('execute-button').disabled);
        await page.locator('#response-history .assistant').filter({hasText:prompt}).waitFor();
      }
      assert.equal(calls.at(-1).history.length,2);
      assert.equal(await page.evaluate(()=>window.injected),undefined);
    });
    await test('Ilaria failure stays visible and preserves prompt',async()=>{
      await page.locator('#omnibar-input').fill('FAIL_TEST');
      await page.locator('#omnibar-input').press('Enter');
      await page.locator('#omnibar-feedback').filter({hasText:'E2E fixture unavailable'}).waitFor();
      assert.equal(await page.locator('#omnibar-input').inputValue(),'FAIL_TEST');
    });
    await test('Keyboard focuses Ilaria',async()=>{
      await page.keyboard.press('Control+l');
      assert.equal(await page.locator('#omnibar-input').evaluate(e=>e===document.activeElement),true);
    });
    await page.keyboard.press('Escape');
    await test('No JavaScript runtime exceptions',async()=>assert.deepEqual(errors,[]));
    await page.screenshot({path:path.join(reportDir,'desktop.png'),fullPage:true});
    fs.writeFileSync(path.join(reportDir,'server.log'),log);
  } finally {
    if(browser) await browser.close();
    if(app && app.pid && app.exitCode===null) { app.kill(); await new Promise(resolve=>app.once('exit',resolve)); }
    await new Promise(resolve=>fixture.close(resolve));
    // Delete only the exact temporary workspace created by this process.
    const resolvedWorkspace = fs.realpathSync(workspace);
    const tempRoot = fs.realpathSync(os.tmpdir());
    if(path.dirname(resolvedWorkspace).toLowerCase() !== tempRoot.toLowerCase() || !path.basename(resolvedWorkspace).startsWith('swypik-e2e-')) {
      throw new Error('Refusing cleanup outside the test workspace');
    }
    fs.rmSync(resolvedWorkspace,{recursive:true,force:true});
    fs.writeFileSync(path.join(reportDir,'results.json'),JSON.stringify({results,errors},null,2));
    console.log('Report:',reportDir);
  }
  if(results.some(r=>r.status==='FAIL')) process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
