/* SPDX-License-Identifier: GPL-3.0-or-later
 * Real HTTP server + Chrome probe page. Desktop alias writes are disabled.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-probe-e2e-'));
  let helper, browser;
  try {
    execFileSync('clang', ['-fobjc-arc', '-DSC_PROBE_TEST=1', '-Wno-deprecated-declarations', '-framework', 'Foundation', '-framework', 'Security',
      path.join(root, 'source/browser_probe.m'), path.join(root, 'source/browser_network.c'), path.join(root, 'source/browser_web_tls.m'), '-o', path.join(work, 'probe')]);
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const statePath = path.join(work, 'state.json');
    const args = ['--parent', String(process.pid), '--test-port', String(port), '--test-state', statePath];
    helper = spawn(path.join(work, 'probe'), args, {stdio: ['ignore', 'pipe', 'pipe']});
    let logs = ''; helper.stderr.on('data', b => logs += b.toString());
    const until = async (fn, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (!await fn()) { if (Date.now() > end) throw Error(label + '\n' + logs); await sleep(50); }
    };
    await until(() => fs.existsSync(statePath), 'probe startup');
    const base = `http://127.0.0.1:${port}`;
    const entry = await (await fetch(base)).text();
    assert(entry.includes('id="surface"'));
    assert(!entry.includes('id="pair"'));
    const response = await fetch(base + '/probe'); assert.equal(response.status, 200);
    assert((await response.text()).includes('Browser4'));
    let state = await (await fetch(base + '/probe.json')).json();
    assert.equal(state.version, 'Browser4'); assert.equal(state.localReady, false);
    assert(state.probeRequests >= 2); assert(!JSON.stringify(state).includes('token'));
    assert.equal((await fetch(base + '/probe.json', {method: 'POST'})).status, 400);
    const badHost = await new Promise((resolve, reject) => {
      http.get(base, {headers: {Host: `attacker.invalid:${port}`}}, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(badHost, 400);
    assert.equal((await fetch(base + '/status')).status, 503); // player backend not running
    const tls = net.createConnection(port, '127.0.0.1'); await once(tls, 'connect');
    tls.write(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01, 0x00])); await once(tls, 'close');
    state = await (await fetch(base + '/probe.json')).json(); assert.equal(state.tlsOnHTTP, 1);
    // A second helper must fail before touching the address/guard.
    const duplicate = spawn(path.join(work, 'probe'), args, {stdio: 'ignore'});
    const [duplicateCode] = await once(duplicate, 'exit'); assert.equal(duplicateCode, 4);
    browser = await chromium.launch({executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/probe');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('2 次'));
    assert((await page.locator('#details').innerText()).includes('Browser4'));
    assert.equal(await page.locator('#player').getAttribute('href'), base + '/');
    assert.equal(await page.locator('input').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({path: path.join(work, 'probe.png')});
    helper.kill('SIGTERM'); const [code] = await once(helper, 'exit'); assert.equal(code, 0);
    state = JSON.parse(fs.readFileSync(statePath)); assert.equal(state.phase, 'stopped'); assert.equal(state.localReady, false);
    assert(logs.includes('guard cleanup=ok'));
    console.log('PASS: independent probe HTTP, live Chrome responses, Host validation, TLS-on-HTTP diagnostic, singleton lock, no PIN/media dependency, graceful guard cleanup');
    console.log('Probe screenshot:', path.join(work, 'probe.png'));
  } finally {
    if (helper && helper.exitCode === null) { helper.kill('SIGTERM'); await once(helper, 'exit'); }
    if (browser) await browser.close();
    fs.rmSync(path.join(work, 'probe'), {force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
