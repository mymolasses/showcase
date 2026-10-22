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
const token = '0123456789abcdef0123456789abcdef'; // synthetic test-only credential

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
      encoder.configure({codec: 'avc1.42E01E', width: 320, height: 180, framerate: 30,
        bitrate: 400000, latencyMode: 'realtime', avc: {format: 'avc'}});
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      for (let i = 0; i < 60; i++) {
        context.fillStyle = '#13254b'; context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#48cfae'; context.fillRect(i * 4, 50, 50, 80);
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
    helper = spawn(path.join(work, 'bridge'), [String(port), token, fixture, '320x180'], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', stderr = '';
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const until = async (predicate, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > end) throw Error(`${label}\n${stderr}\n${output.slice(-500)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
    };
    await until(() => output.includes('READY'), 'bridge startup');
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.fill('#token', token);
    await page.click('#pair button[type=submit]');
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v.videoWidth === 320 && v.currentTime > 0.1 && v.readyState >= 2; }, {timeout: 15000});
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
    await until(() => /TOUCH 0 160 90/.test(output) && /TOUCH 1 /.test(output) && /TOUCH 2 /.test(output), 'pointer -> production touch callback');
    await page.screenshot({path: path.join(work, 'browser.png')});
    await page.click('#reconnect');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('video').readyState >= 2, {timeout: 15000});
    helper.stdin.write('b');
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('前台'));
    helper.stdin.write('f');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('video').readyState >= 2, {timeout: 15000});
    assert.deepEqual(pageErrors, []);
    console.log('PASS: Chrome AVC encoding -> production WS -> actual MSE video, letterbox rejection, pointer drag/up, reconnect, foreground reset');
    console.log('Synthetic screenshot:', path.join(work, 'browser.png'));
  } finally {
    if (helper && helper.exitCode === null) { helper.stdin.write('q'); await once(helper, 'exit'); }
    if (server) server.close();
    if (browser) await browser.close();
    // Keep only the synthetic screenshot as visual evidence.
    for (const name of ['bridge', 'avc.bin']) fs.rmSync(path.join(work, name), {force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
