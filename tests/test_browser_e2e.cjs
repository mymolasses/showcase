/* SPDX-License-Identifier: GPL-3.0-or-later
 * Optional macOS/Chrome integration: create synthetic AVC with WebCodecs, then
 * play it through the production bridge's MSE page and send real pointer input.
 * Requires playwright (NODE_PATH or local install) and Google Chrome.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const token = '0427'; // synthetic test-only credential

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-browser-e2e-'));
  let browser, server, helper;
  try {
    execFileSync('clang', ['-fobjc-arc', '-Wno-deprecated-declarations', '-framework', 'Foundation',
      path.join(root, 'source/browser_bridge.m'), path.join(root, 'tests/browser_bridge_harness.m'), '-o', path.join(work, 'bridge')]);
    server = http.createServer((_, res) => { res.end('<!doctype html><title>Synthetic AVC fixture</title>'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const encoded = await page.evaluate(async () => {
      if (!window.VideoEncoder) throw Error('Chrome WebCodecs encoder unavailable');
      const frames = []; let description = null, failure = null;
      const encoder = new VideoEncoder({output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); frames.push([...bytes]);
        if (meta.decoderConfig?.description) description = [...new Uint8Array(meta.decoderConfig.description)];
      }, error(error) { failure = error.message; }});
      encoder.configure({codec: 'avc1.4D4028', width: 1920, height: 1080, framerate: 30,
        bitrate: 6000000, latencyMode: 'realtime', avc: {format: 'avc'}});
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext('2d');
      for (let i = 0; i < 60; i++) {
        context.fillStyle = '#13254b'; context.fillRect(0, 0, 1920, 1080);
        context.fillStyle = '#48cfae'; context.fillRect(i * 24, 300, 300, 480);
        const frame = new VideoFrame(canvas, {timestamp: Math.round(i * 1e6 / 30), duration: 33333});
        encoder.encode(frame, {keyFrame: i % 30 === 0}); frame.close();
      }
      await encoder.flush(); encoder.close();
      if (failure || !description || !frames.length) throw Error(failure || 'No AVC output');
      return {description, frames};
    });
    const record = bytes => { const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, Buffer.from(bytes)]); };
    const fixture = path.join(work, 'avc.bin');
    fs.writeFileSync(fixture, Buffer.concat([record(encoded.description), ...encoded.frames.map(record)]));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve)); server = null;
    helper = spawn(path.join(work, 'bridge'), [String(port), token, fixture, '1920x1080'], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', stderr = '';
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const until = async (predicate, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > end) throw Error(`${label}\n${stderr}\n${output.slice(-500)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
    };
    await until(() => output.includes('READY'), 'bridge startup');
    const pageErrors = [];
    let mediaConnections = 0, controls = 0;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('websocket', socket => {
      if (socket.url().endsWith('/media')) mediaConnections++;
      if (socket.url().endsWith('/control')) controls++;
    });
    await page.goto(`http://127.0.0.1:${port}`);
    // Wrong PIN must stop, rather than loop new WS connections forever.
    await page.fill('#token', '9999');
    await page.click('#pair button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#state').textContent.includes('不正确'));
    assert.equal(mediaConnections, 0);
    await page.click('#disconnect');
    await page.fill('#token', token);
    await page.click('#pair button[type=submit]');
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v.videoWidth === 1920 && v.currentTime > 0.1 && v.readyState >= 2; }, {timeout: 15000});
    await until(() => output.includes('TOUCH 3'), 'browser control ownership');
    // Authenticated status polling must enable input after actual frames arrive.
    await page.waitForTimeout(1200);
    const rect = await page.locator('#surface').boundingBox();
    const before = output.match(/TOUCH 0 /g)?.length || 0;
    await page.mouse.click(rect.x + rect.width / 2, rect.y + 3); // letterbox
    await page.waitForTimeout(150);
    assert.equal(output.match(/TOUCH 0 /g)?.length || 0, before);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.6, {steps: 8});
    await page.mouse.up();
    await until(() => /TOUCH 0 960 540/.test(output) && /TOUCH 1 /.test(output) && /TOUCH 2 /.test(output), 'pointer -> production touch callback');
    // Exercise the actual static-screen/gap and repeated-config failure paths.
    const initialTime = await page.locator('video').evaluate(v => v.currentTime);
    helper.stdin.write('s');
    await page.waitForTimeout(2300);
    helper.stdin.write('r');
    await page.waitForTimeout(100);
    assert.equal(mediaConnections, 1);
    helper.stdin.write('tc');
    await page.waitForFunction(time => document.querySelector('video').currentTime > time + 0.1, initialTime, {timeout: 10000});
    for (let i = 0; i < 8; i++) {
      helper.stdin.write('r'); await page.waitForTimeout(1500);
    }
    assert.equal(mediaConnections, 1, 'stable playback must not churn sockets');
    assert.equal(controls, 1);
    assert.equal(await page.locator('#poster').isVisible(), false);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await page.screenshot({path: path.join(work, 'browser.png')});
    await page.click('#reconnect');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('video').readyState >= 2, {timeout: 15000});
    // Actual service loss: retain the last image, back off, recover new sockets.
    helper.stdin.write('q'); await once(helper, 'exit');
    await page.waitForFunction(() => document.querySelector('#state').textContent.includes('重试'));
    assert.equal(await page.locator('#poster').isVisible(), true);
    helper = spawn(path.join(work, 'bridge'), [String(port), token, fixture, '1920x1080'], {stdio: ['pipe', 'pipe', 'pipe']});
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('video').readyState >= 2, {timeout: 15000});
    helper.stdin.write('b');
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('前台'));
    helper.stdin.write('f');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('video').readyState >= 2, {timeout: 15000});
    assert.deepEqual(pageErrors, []);
    console.log('PASS: real Chrome 1080p MSE, PIN rejection, 12s repeated config stability, idle/gap resume, input, retry + retained frame after service loss, foreground reset');
    console.log('Synthetic screenshot:', path.join(work, 'browser.png'));
  } finally {
    if (helper && helper.exitCode === null) { helper.stdin.write('q'); await once(helper, 'exit'); }
    if (server) server.close();
    if (browser) await browser.close();
    // Keep only the synthetic screenshot as visual evidence.
    for (const name of ['bridge', 'avc.bin']) fs.rmSync(path.join(work, name), {force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
