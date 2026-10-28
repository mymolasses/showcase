/* SPDX-License-Identifier: GPL-3.0-or-later
 * Optional macOS/Chrome integration: create synthetic AVC with WebCodecs, then
 * play it through production Worker/WebCodecs/WebGL renderer and send real pointer input.
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
const profile = process.env.SHOWCASE_TEST_AVC_PROFILE || 'baseline';
const codecs = {baseline:'avc1.42002a',main:'avc1.4d002a',high:'avc1.64002a'};
assert(codecs[profile], 'Unknown AVC test profile');
const fullHD = profile==='baseline';
const width = fullHD ? 1920 : 1600, height = fullHD ? 1080 : 900;
// This suite checks native forwarding/lifecycle, not software-GPU throughput.
// CI can pace full-resolution fixtures below real-time; the separate Worker
// browser suite still exercises a 30 fps source and all three AVC profiles.
const fps = Number(process.env.SHOWCASE_TEST_SOURCE_FPS || 30);
assert(Number.isInteger(fps) && fps >= 1 && fps <= 60);

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-browser-e2e-'));
  let browser, page, server, helper, gateway, output = '', stderr = '';
  let stage='compile';
  const progress=name=>{stage=name;console.log('[native-browser] '+name);};
  const bounded=(promise,label,ms=20000)=>{
    let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out during '+stage)),ms);})]).finally(()=>clearTimeout(timer));
  };
  const evaluate=(...args)=>bounded(page.evaluate(...args),'page evaluation');
  const watchdog=setTimeout(()=>{console.error('Native browser suite exceeded 180s during '+stage);helper?.kill('SIGKILL');gateway?.kill('SIGKILL');process.exit(1);},180000);
  const certificate = useTLS ? fixtureTLS(work, domain) : null;
  try {
    require('./native_browser_fixture.cjs')(path.join(work,'bridge'));
    execFileSync('clang', ['-fobjc-arc', '-DSC_PROBE_TEST=1', '-Wno-deprecated-declarations', '-framework', 'Foundation', '-framework', 'Security',
      path.join(root,'source/browser_probe.m'),path.join(root,'source/browser_network.c'),path.join(root,'source/browser_web_tls.m'),'-o',path.join(work,'gateway')]);
    server = http.createServer((_, res) => { res.end('<!doctype html><title>Synthetic AVC fixture</title>'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-proxy-server', ...(useTLS ? ['--host-resolver-rules=MAP '+domain+' 127.0.0.1', '--ignore-certificate-errors-spki-list='+certificate.spki] : [])]});
    page = await browser.newPage({viewport: {width: 1280, height: 900}});
    // Worker rendering must not depend on main-page animation callbacks.
    const waitFor=(fn,arg,options={})=>page.waitForFunction(fn,arg,{polling:100,...options});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    progress('encode fixture');
    const encoded = await evaluate(async ({codec,width,height,fps}) => {
      if (!window.VideoEncoder) throw Error('Chrome WebCodecs encoder unavailable');
      const frames = []; let description = null, failure = null;
      const encoder = new VideoEncoder({output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); frames.push([...bytes]);
        if (meta.decoderConfig?.description) description = [...new Uint8Array(meta.decoderConfig.description)];
      }, error(error) { failure = error.message; }});
      encoder.configure({codec, width, height, framerate: fps,
        bitrate: 6000000, latencyMode: 'realtime', avc: {format: 'avc'}});
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      for (let i = 0; i < 60; i++) {
        context.fillStyle = '#13254b'; context.fillRect(0, 0, width, height);
        context.fillStyle = '#48cfae'; context.fillRect(i * 24, 300, 300, 480);
        context.fillStyle = '#e43a32'; context.fillRect(20,20,60,60);
        const frame = new VideoFrame(canvas, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6/fps)});
        encoder.encode(frame, {keyFrame: i % fps === 0}); frame.close();
      }
      await encoder.flush(); encoder.close();
      if (failure || !description || !frames.length) throw Error(failure || 'No AVC output');
      return {description, frames};
    },{codec:codecs[profile],width,height,fps});
    assert.equal(encoded.description[1],{baseline:66,main:77,high:100}[profile],'Encoder must produce the requested AVC profile');
    const record = bytes => { const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, Buffer.from(bytes)]); };
    const fixture = path.join(work, 'avc.bin');
    fs.writeFileSync(fixture, Buffer.concat([record(encoded.description), ...encoded.frames.map(record)]));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve)); server = null;
    helper = spawn(path.join(work, 'bridge'), [String(port), fixture, `${width}x${height}`], {stdio: ['pipe', 'pipe', 'pipe']});
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
    const connections=role=>stderr.split('[BROWSER] '+role+' connected').length-1;
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(useTLS ? `https://${domain}:${tlsPort}/` : `http://127.0.0.1:${frontPort}/`);
    progress('first decoded frame');
    assert.equal(await page.locator('input').count(), 0);
    await waitFor(()=>window.showcaseDiagnostics?.().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    await until(() => stderr.includes('[BROWSER] control connected'), 'browser control channel');
    // Status polling must enable input after actual frames arrive.
    await page.waitForTimeout(1200);
    await page.click('#menu',{force:true});
    assert.equal(await page.locator('#renderer').count(),0);
    assert.equal(await page.locator('#display canvas').evaluate(c=>getComputedStyle(c).objectFit),'contain');
    const rect = await page.locator('#surface').boundingBox();
    progress('pointer drag and long press');
    const before = output.match(/TOUCH 0 /g)?.length || 0;
    await page.mouse.click(rect.x + rect.width / 2, rect.y + 3); // letterbox
    await page.waitForTimeout(150);
    assert.equal(output.match(/TOUCH 0 /g)?.length || 0, before);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.6, {steps: 8});
    await page.mouse.up();
    await until(() => output.includes(`TOUCH 0 ${width/2} ${height/2}`) && /TOUCH 1 /.test(output) && /TOUCH 2 /.test(output), 'pointer -> production touch callback');
    // A stationary long press survives the server's 750ms deadman because
    // the production page sends holds. Blur must then cancel it immediately.
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    let downs = output.match(/TOUCH 0 /g)?.length || 0;
    await page.mouse.down();
    await until(() => (output.match(/TOUCH 0 /g)?.length || 0) > downs, 'long-press down');
    const cancels = output.match(/TOUCH 3 /g)?.length || 0;
    await page.waitForTimeout(1300);
    assert.equal(output.match(/TOUCH 3 /g)?.length || 0, cancels, 'long press must remain down');
    await evaluate(() => window.dispatchEvent(new Event('blur')));
    await until(() => (output.match(/TOUCH 3 /g)?.length || 0) > cancels, 'blur -> production touch cancel');
    await page.mouse.up();
    // A 1.5s route check must not block HTTP or the active media/control relay.
    const diagURL=useTLS ? `https://${domain}:${tlsPort}/probe.json` : `http://127.0.0.1:${frontPort}/probe.json`;
    progress('route checks during playback');
    for(let i=0;i<8;i++) {
      const elapsed=await evaluate(async url=>{const start=performance.now();const r=await fetch(url);if(!r.ok)throw Error('probe response');await r.json();return performance.now()-start;},diagURL);
      assert(elapsed<1000, 'route worker blocked forwarding: '+elapsed+'ms');
      await page.waitForTimeout(250);
    }
    // Exercise the actual static-screen/gap and repeated-config failure paths.
    progress('static screen and timestamp gap');
    const initialTime = await evaluate(()=>showcaseDiagnostics().drawnFrames);
    helper.stdin.write('s');
    await page.waitForTimeout(2300);
    assert.equal(await evaluate(()=>showcaseDiagnostics().displayed),true);
    helper.stdin.write('r');
    await page.waitForTimeout(100);
    assert.equal(connections('media'), 1);
    helper.stdin.write('tc');
    assert(Number.isFinite(initialTime),'resume baseline must be a frame count');
    await waitFor(time=>showcaseDiagnostics().drawnFrames>time,initialTime,{timeout:15000,polling:100});
    for (let i = 0; i < 8; i++) {
      helper.stdin.write('r'); await page.waitForTimeout(1500);
    }
    assert.equal(connections('media'), 1, 'stable playback must not churn sockets');
    assert.equal(connections('control'), 1);
    assert.equal(await evaluate(()=>showcaseDiagnostics().retainedFrame), false);
    assert.equal(await page.locator('#notice').isVisible(), false);
    progress('manual reconnect');
    await page.click('#reconnect',{force:true});
    await waitFor(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    // Sample actual pixels after draining GPU work. Full-canvas readback during
    // live software rendering serializes the GPU and does not test playback.
    helper.stdin.write('s');await page.waitForTimeout(700);progress('decoded pixel checks');
    const color=await evaluate(()=>{const source=document.querySelector('#display canvas');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(source,10,source.height-10,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
    assert(color[2]>color[0] && color[2]>40 && color[3]===255,'decoded fixture pixels: '+color);
    const corner=await evaluate(()=>{const source=document.querySelector('#display canvas');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(source,source.width/64,source.height/36,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
    assert(corner[0]>corner[2]+50,'red marker must remain at top-left: '+corner);
    helper.stdin.write('c');
    assert.equal(await page.locator('video,img').count(),0);
    // Actual service loss: retain the last image, back off, recover new sockets.
    progress('native service loss and restart');
    helper.stdin.write('q'); await bounded(once(helper, 'exit'),'native service exit');
    await waitFor(() => document.querySelector('#state').textContent.includes('重试'));
    assert.equal(await evaluate(()=>showcaseDiagnostics().retainedFrame), true);
    helper = spawn(path.join(work, 'bridge'), [String(port), fixture, `${width}x${height}`], {stdio: ['pipe', 'pipe', 'pipe']});
    helper.stdout.on('data', bytes => { output += bytes.toString(); });
    helper.stderr.on('data', bytes => { stderr += bytes.toString(); });
    await waitFor(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    progress('native foreground transition');
    helper.stdin.write('b');
    await waitFor(() => document.querySelector('#notice').textContent.includes('前台'));
    helper.stdin.write('f');
    await waitFor(()=>showcaseDiagnostics().displayed && showcaseDiagnostics().drawnFrames>2,null,{timeout:20000});
    assert.deepEqual(pageErrors, []);
    console.log(`PASS (${useTLS?'HTTPS/WSS':'HTTP/WS'}, ${profile} ${width}x${height}): pixels/crop/orientation, touch, static flush, reconnect, foreground without a new VideoConfig`);
  } catch(error) {
    console.error('Playback diagnostics:',await bounded(page?.evaluate(()=>JSON.stringify(window.showcaseDiagnostics?.())),'diagnostics',5000).catch(()=> 'page unavailable'));
    console.error('Bridge stderr:',stderr.slice(-6000),'Bridge output:',output.slice(-2000));
    throw error;
  } finally {
    if (helper && helper.exitCode === null) { helper.stdin.write('q'); await bounded(once(helper, 'exit'),'native service cleanup',5000).catch(()=>helper.kill('SIGKILL')); }
    if (gateway && gateway.exitCode === null) { gateway.kill('SIGTERM'); await bounded(once(gateway,'exit'),'gateway cleanup',5000).catch(()=>gateway.kill('SIGKILL')); }
    if (server) server.close();
    if (browser) await bounded(browser.close(),'Chrome cleanup',10000).catch(()=>{});
    clearTimeout(watchdog);
    for (const name of fs.readdirSync(work)) fs.rmSync(path.join(work, name), {recursive:true,force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
