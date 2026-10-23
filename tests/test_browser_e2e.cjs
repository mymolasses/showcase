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
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const fixtureTLS = require('./browser_web_fixture.cjs');
const useTLS = process.env.SHOWCASE_TEST_TLS === '1';
const domain = 'carplay.showcase.test';

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-browser-e2e-'));
  let browser, server, helper, gateway;
  const certificate = useTLS ? fixtureTLS(work, domain) : null;
  try {
    require('./native_browser_fixture.cjs')(path.join(work,'bridge'));
    execFileSync('clang', ['-fobjc-arc', '-DSC_PROBE_TEST=1', '-Wno-deprecated-declarations', '-framework', 'Foundation', '-framework', 'Security',
      path.join(root,'source/browser_probe.m'),path.join(root,'source/browser_network.c'),path.join(root,'source/browser_web_tls.m'),'-o',path.join(work,'gateway')]);
    server = http.createServer((_, res) => { res.end('<!doctype html><title>Synthetic AVC fixture</title>'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-proxy-server', ...(useTLS ? ['--host-resolver-rules=MAP '+domain+' 127.0.0.1', '--ignore-certificate-errors-spki-list='+certificate.spki] : [])]});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const encoded = await page.evaluate(async () => {
      if (!window.VideoEncoder) throw Error('Chrome WebCodecs encoder unavailable');
      const frames = []; let description = null, failure = null;
      const encoder = new VideoEncoder({output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); frames.push([...bytes]);
        if (meta.decoderConfig?.description) description = [...new Uint8Array(meta.decoderConfig.description)];
      }, error(error) { failure = error.message; }});
      encoder.configure({codec: 'avc1.42002a', width: 1920, height: 1080, framerate: 30,
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
    helper = spawn(path.join(work, 'bridge'), [String(port), fixture, '1920x1080'], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', stderr = '';
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const until = async (predicate, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > end) throw Error(`${label}\n${stderr}\n${output.slice(-500)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
    };
    await until(() => output.includes('READY'), 'bridge startup');
    const reserve = net.createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
    const frontPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const tlsReserve=net.createServer(); tlsReserve.listen(0,'127.0.0.1'); await once(tlsReserve,'listening');
    const tlsPort=tlsReserve.address().port; await new Promise(resolve=>tlsReserve.close(resolve));
    fs.writeFileSync(path.join(work,'browser-web.json'),JSON.stringify({testBackendPort:port, ...(useTLS ? {domain, identityPassword:certificate.password,testAnchor:certificate.root} : {})}));
    const gatewayState = path.join(work,'web-state.json');
    gateway=spawn(path.join(work,'gateway'),['--parent',String(process.pid),'--test-route-delay-ms','1500','--test-port',String(frontPort),'--test-state',gatewayState,...(useTLS ? ['--test-https-port',String(tlsPort)] : [])],{stdio:['ignore','pipe','pipe']});
    gateway.stderr.on('data',bytes=>{stderr+=bytes.toString();});
    await until(()=>fs.existsSync(gatewayState),'gateway startup');
    const pageErrors = [];
    let mediaConnections = 0, controls = 0;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('websocket', socket => {
      if (['/media','/jpeg','/rtc'].some(route=>socket.url().endsWith(route))) mediaConnections++;
      if (socket.url().endsWith('/control')) controls++;
    });
    await page.goto(useTLS ? `https://${domain}:${tlsPort}/` : `http://127.0.0.1:${frontPort}/`);
    assert.equal(await page.locator('input').count(), 0);
    await page.waitForFunction(()=>window.showcaseDiagnostics?.().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    await until(() => stderr.includes('[BROWSER] control connected'), 'browser control channel');
    // Status polling must enable input after actual frames arrive.
    await page.waitForTimeout(1200);
    await page.click('#menu');
    await page.click('#fit'); // verify original aspect-ratio mapping too
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
    // A stationary long press survives the server's 750ms deadman because
    // the production page sends holds. Blur must then cancel it immediately.
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    let downs = output.match(/TOUCH 0 /g)?.length || 0;
    await page.mouse.down();
    await until(() => (output.match(/TOUCH 0 /g)?.length || 0) > downs, 'long-press down');
    const cancels = output.match(/TOUCH 3 /g)?.length || 0;
    await page.waitForTimeout(1300);
    assert.equal(output.match(/TOUCH 3 /g)?.length || 0, cancels, 'long press must remain down');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await until(() => (output.match(/TOUCH 3 /g)?.length || 0) > cancels, 'blur -> production touch cancel');
    await page.mouse.up();
    // A 1.5s route check must not block HTTP or the active media/control relay.
    const diagURL=useTLS ? `https://${domain}:${tlsPort}/probe.json` : `http://127.0.0.1:${frontPort}/probe.json`;
    for(let i=0;i<8;i++) {
      const elapsed=await page.evaluate(async url=>{const start=performance.now();const r=await fetch(url);if(!r.ok)throw Error('probe response');await r.json();return performance.now()-start;},diagURL);
      assert(elapsed<1000, 'route worker blocked forwarding: '+elapsed+'ms');
      await page.waitForTimeout(250);
    }
    // Exercise the actual static-screen/gap and repeated-config failure paths.
    const initialTime = await page.evaluate(()=>showcaseDiagnostics().drawnFrames);
    helper.stdin.write('s');
    await page.waitForTimeout(2300);
    helper.stdin.write('r');
    await page.waitForTimeout(100);
    assert.equal(mediaConnections, 1);
    helper.stdin.write('tc');
    await page.waitForFunction(time=>showcaseDiagnostics().drawnFrames>time,initialTime,{timeout:15000});
    for (let i = 0; i < 8; i++) {
      helper.stdin.write('r'); await page.waitForTimeout(1500);
    }
    assert.equal(mediaConnections, 1, 'stable playback must not churn sockets');
    assert.equal(controls, 1);
    assert.equal(await page.locator('#poster').isVisible(), false);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await page.screenshot({path: path.join(work, 'browser.png')});
    await page.click('#reconnect');
    await page.waitForFunction(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    // Every offered backend must actually decode/render through production
    // native services; no synthetic server or permissive asset interception.
    for(const mode of ['webcodecs','software','mjpeg','webrtc','jpeg']) {
      await page.selectOption('#renderer',mode);
      try {
        await page.waitForFunction(mode=>{const d=showcaseDiagnostics();return d.renderer===mode && d.displayed && (mode==='mjpeg'||d.drawnFrames>2);},mode,{timeout:25000});
        const drawn=await page.evaluate(()=>showcaseDiagnostics().drawnFrames);
        if(mode!=='mjpeg') await page.waitForFunction(count=>showcaseDiagnostics().drawnFrames>count+2,drawn,{timeout:15000});
      } catch(error) { throw Error(mode+' failed: '+await page.evaluate(()=>JSON.stringify(showcaseDiagnostics()))+'\n'+stderr+'\n'+error); }
      assert.equal(await page.locator('#poster').isVisible(),false);
      const color=await page.evaluate(()=>{const source=document.querySelector('#display canvas,#display img');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');const height=source.naturalHeight||source.height;ctx.drawImage(source,10,height-10,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
      assert(color[2]>color[0] && color[2]>40 && color[3]===255,'native decoded pixels must match the fixture in '+mode+': '+color);
      if(mode==='jpeg') assert.equal(await page.locator('#display canvas').evaluate(c=>c.width),1280,'native JPEG caps width');
    }
    // Actual service loss: retain the last image, back off, recover new sockets.
    helper.stdin.write('q'); await once(helper, 'exit');
    await page.waitForFunction(() => document.querySelector('#state').textContent.includes('重试'));
    assert.equal(await page.locator('#poster').isVisible(), true);
    helper = spawn(path.join(work, 'bridge'), [String(port), fixture, '1920x1080'], {stdio: ['pipe', 'pipe', 'pipe']});
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    await page.waitForFunction(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    helper.stdin.write('b');
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('前台'));
    helper.stdin.write('f');
    await page.waitForFunction(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    assert.deepEqual(pageErrors, []);
    console.log('PASS ('+(useTLS ? 'HTTPS/WSS' : 'HTTP/WS')+'): native 1080p JPEG/MJPEG/WebCodecs/Broadway/WebRTC, HTTP/TLS gateway, touch/hold, idle resume, repeated config, retry + retained frame, foreground reset');
    console.log('Synthetic screenshot:', path.join(work, 'browser.png'));
  } finally {
    if (helper && helper.exitCode === null) { helper.stdin.write('q'); await once(helper, 'exit'); }
    if (gateway && gateway.exitCode === null) { gateway.kill('SIGTERM'); await once(gateway,'exit'); }
    if (server) server.close();
    if (browser) await browser.close();
    // Keep only the synthetic screenshot as visual evidence.
    for (const name of fs.readdirSync(work)) if(name !== 'browser.png') fs.rmSync(path.join(work, name), {recursive:true,force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
