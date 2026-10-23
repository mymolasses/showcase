/* Portable regression: production webpage + real Chrome MSE, synthetic H.264.
 * No iOS/Mac dependency. The native bridge remains covered separately. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const packet = bytes => {
  const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length <= 65535 ? 4 : 10);
  header[0] = 0x82;
  if (header.length === 2) header[1] = bytes.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
  return Buffer.concat([header, bytes]);
};
(async () => {
  let browser, timer, frames, config, sequence = 0, paused = false, timestampMode = 'normal';
  const media = new Set(), sockets = new Set(), errors = [];
  let connections = 0, keyRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({version: 'test', build: '0', active: true, configured: true, viewers: 0, controllers: 0}));
    }
    const name = req.url === '/' ? 'index.html' : req.url === '/player.js' ? 'player.js' : null;
    if (!name) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(root, 'web', name)));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    assert.equal(req.headers['sec-websocket-protocol'], undefined, 'No pairing subprotocol');
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    let input=Buffer.alloc(0);
    socket.on('data', bytes => {
      input=Buffer.concat([input,bytes]);
      while(input.length>=2) {
        const opcode=input[0]&15, size=input[1]&127;
        if(size>=126 || !(input[1]&128)) { socket.destroy();return; }
        if(input.length<6+size)return;
        const mask=input.subarray(2,6), data=Buffer.alloc(size);
        for(let i=0;i<size;i++)data[i]=input[6+i]^mask[i%4];
        input=input.subarray(6+size);
        if(opcode===8){socket.end();return;}
        if(opcode===1 && JSON.parse(data).type==='keyframe')keyRequests++;
      }
    });
    if (req.url === '/media') {
      media.add(socket); connections++; sequence = 0;
      socket.write(packet(config)); socket.on('close', () => media.delete(socket));
    }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({executablePath: process.env.CHROME || undefined, headless: true});
    const page = await browser.newPage({viewport: {width: 1200, height: 900}});
    // Some embedded browsers can submit frames without a usable playing
    // notification. A retained reconnect poster must not obscure that video.
    await page.addInitScript(() => document.addEventListener('playing', event => event.stopImmediatePropagation(), true));
    // Encode in a secure loopback page before loading the production player.
    await page.goto(`http://127.0.0.1:${server.address().port}/status`);
    const encoded = await page.evaluate(async () => {
      const frames = []; let avcc;
      const encoder = new VideoEncoder({output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        frames.push({bytes: [...bytes], key: chunk.type === 'key'});
        if (meta.decoderConfig?.description) avcc = [...new Uint8Array(meta.decoderConfig.description)];
      }, error(error) { throw error; }});
      encoder.configure({codec: 'avc1.42001f', width: 640, height: 360, framerate: 30, bitrate: 1000000, latencyMode: 'realtime', avc: {format: 'avc'}});
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = i < 30 ? '#ff0000' : '#0000ff'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(i * 8, 100, 30, 40);
        const frame = new VideoFrame(canvas, {timestamp: Math.round(i * 1e6 / 30)});
        encoder.encode(frame, {keyFrame: i % 30 === 0}); frame.close();
      }
      await encoder.flush(); encoder.close(); return {frames, avcc};
    });
    frames = encoded.frames;
    config = Buffer.alloc(9 + encoded.avcc.length); config[0] = 1; config.writeUInt32BE(1, 1);
    config.writeUInt16BE(640, 5); config.writeUInt16BE(360, 7); Buffer.from(encoded.avcc).copy(config, 9);
    timer = setInterval(() => {
      if (paused || !media.size) return;
      const frame = frames[sequence % frames.length];
      const head = Buffer.alloc(14); head[0] = 2; head.writeUInt32BE(1, 1); head[5] = +frame.key;
      head.writeBigUInt64BE(BigInt(timestampMode === 'normal' ? Math.round(sequence * 1e6 / 30) : timestampMode === 'repeat' ? 1000000 : 0), 6);
      sequence++;
      // Ignore the first IDR request while delta frames continue arriving.
      // The production page must retry instead of waiting forever in black.
      if(frame.key && keyRequests<2)return;
      for (const socket of media) socket.write(packet(Buffer.concat([head, Buffer.from(frame.bytes)])));
    }, 33);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.locator('input').count(), 0);
    const decoded = () => page.locator('video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames);
    await page.waitForFunction(() => document.querySelector('video').currentTime > 1);
    assert(keyRequests>=2,'startup must retry the missing IDR');
    await page.click('#menu'); await page.click('#diagnostics');
    await page.waitForFunction(() => {
      const text=document.querySelector('#diagnostic-data').textContent;
      if(!text)return false;const d=JSON.parse(text);return d.receivedFps>0 && d.presentedFps>0 && d.version==='test' &&
        d.videoPaused===false && d.videoCurrentTime>0 && d.totalVideoFrames>0 && d.nonDroppedFrames>0 && d.frameCallbackFps>0 && d.documentVisibility==='visible' &&
        d.lastPresentedAgeMs!==null && d.presentedMediaTime>0;
    });
    // Public HTTP IPs may lack navigator.clipboard: exercise the copy fallback.
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    await page.click('#diagnostic-copy');
    await page.waitForFunction(()=>document.querySelector('#diagnostic-copy').textContent==='已复制');
    await page.click('#diagnostic-close'); await page.click('#menu');
    const first = await decoded(); await page.waitForTimeout(2200);
    assert(await decoded() > first + 30, 'Frames must keep decoding without reconnect');
    const position = () => page.locator('video').evaluate(v => v.currentTime);
    timestampMode = 'repeat'; const repeated = await decoded(), repeatedTime = await position(); await page.waitForTimeout(2200);
    assert(await decoded() > repeated + 30, 'Repeated timestamps must not freeze picture');
    assert(await position() > repeatedTime + 0.5, 'Repeated timestamps must advance presentation');
    timestampMode = 'backwards'; const backwards = await decoded(), backwardsTime = await position(); await page.waitForTimeout(2200);
    assert(await decoded() > backwards + 30, 'Regressing timestamps must not freeze picture');
    assert(await position() > backwardsTime + 0.5, 'Regressing timestamps must advance presentation');
    paused = true; await page.waitForTimeout(1800); const idle = await decoded();
    paused = false; await page.waitForTimeout(2200);
    assert(await decoded() > idle + 30, 'Must resume after live buffer starvation');
    const surface = await page.locator('#surface').boundingBox();
    assert.deepEqual(surface, {x: 0, y: 0, width: 1200, height: 900});
    assert.equal(await page.locator('video').evaluate(v => getComputedStyle(v).objectFit), 'fill');
    await page.click('#menu'); await page.click('#fit');
    assert.equal(await page.locator('video').evaluate(v => getComputedStyle(v).objectFit), 'contain');
    await page.click('#reconnect');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.5);
    assert.equal(await page.locator('#poster').isVisible(),false,'new frames must remove the retained reconnect image');
    assert.equal(await page.locator('#notice').isVisible(),false,'new frames must enable the player without playing events');
    assert.equal(connections, 2, 'No automatic socket churn during playback');
    assert.deepEqual(errors, []);
    console.log('PASS: real Chrome continuous decode, repeated/backwards PTS, starvation recovery, automatic passwordless entry, full viewport, fit toggle, reconnect');
  } finally {
    clearInterval(timer); if (browser) await browser.close();
    for (const socket of sockets) socket.destroy(); server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
