/* SPDX-License-Identifier: GPL-3.0-or-later. No external scripts or services. */
(() => {
  'use strict';
  const join = (...parts) => {
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes;
  };
  const ascii = value => Uint8Array.from(value, c => c.charCodeAt(0));
  const integer = (size, value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (size * 8)) throw Error('Invalid MP4 integer');
    const bytes = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256); } return bytes;
  };
  const u16 = value => integer(2, value), u32 = value => integer(4, value), u64 = value => integer(8, value);
  const zero = size => new Uint8Array(size);
  const box = (name, ...parts) => { const data = join(...parts); return join(u32(data.length + 8), ascii(name), data); };
  const full = (name, version, flags, ...parts) => box(name, integer(1, version), integer(3, flags), ...parts);
  function initMp4(avcc, width, height) {
    if (avcc.length < 7 || avcc[0] !== 1 || (avcc[4] & 3) !== 3 || !width || !height) throw Error('Invalid AVC configuration');
    const matrix = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824].map(u32);
    const entry = box('avc1', zero(6), u16(1), zero(16), u16(width), u16(height), u32(72 * 65536),
      u32(72 * 65536), u32(0), u16(1), zero(32), u16(24), u16(65535), box('avcC', avcc));
    const table = box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)),
      full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
    const media = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(90000), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), ascii('vide'), zero(12), ascii('Showcase\0')),
      box('minf', full('vmhd', 0, 1, zero(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), table));
    const track = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zero(8), zero(8),
      ...matrix, u32(width * 65536), u32(height * 65536)), media);
    return join(box('ftyp', ascii('isom'), u32(512), ascii('isomiso6mp41')),
      box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(65536), u16(256), zero(10), ...matrix, zero(24), u32(2)),
        track, box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))));
  }
  function fragment(sequence, frame, key, time, duration) {
    const moof = offset => box('moof', full('mfhd', 0, 0, u32(sequence)), box('traf',
      full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(time)),
      full('trun', 0, 0x701, u32(1), u32(offset), u32(duration), u32(frame.length), u32(key ? 0x02000000 : 0x01010000))));
    return join(moof(moof(0).length + 8), box('mdat', frame));
  }
  function mapPoint(rect, width, height, x, y, clamp) {
    if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    let px = (x - rect.left - (rect.width - width * scale) / 2) / scale;
    let py = (y - rect.top - (rect.height - height * scale) / 2) / scale;
    if (!clamp && (px < 0 || px > width || py < 0 || py > height)) return null;
    px = Math.max(0, Math.min(width, px)); py = Math.max(0, Math.min(height, py));
    return {x: Math.round(px), y: Math.round(py)};
  }
  /* MP4 path deliberately supports low-delay AVC only. Detect B slices rather
   * than silently pretending their PTS is a decode timestamp. */
  function checkFrame(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0, idr = false;
    while (offset + 4 < bytes.length) {
      const size = view.getUint32(offset); offset += 4;
      if (!size || size > bytes.length - offset) throw Error('Invalid AVC frame');
      const type = bytes[offset] & 31; idr ||= type === 5;
      if (type === 1 || type === 5) {
        const rbsp = []; let zeros = 0;
        for (let i = offset + 1; i < offset + size && rbsp.length < 32; i++) {
          const value = bytes[i];
          if (zeros >= 2 && value === 3) { zeros = 0; continue; }
          rbsp.push(value); zeros = value === 0 ? zeros + 1 : 0;
        }
        let bit = 0;
        const read = () => { if (bit >= rbsp.length * 8) throw Error('Invalid AVC slice'); return (rbsp[bit >> 3] >> (7 - (bit++ & 7))) & 1; };
        const ue = () => { let count = 0; while (!read()) if (++count > 24) throw Error('Invalid AVC slice');
          let value = 1; for (let i = 0; i < count; i++) value = value * 2 + read(); return value - 1; };
        ue(); if (ue() % 5 === 1) throw Error('当前 MSE 原型不支持 B 帧，请使用低延迟 CarPlay 视频');
      }
      offset += size;
    }
    if (offset !== bytes.length) throw Error('Invalid AVC frame');
    return idr;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {join, integer, box, initMp4, fragment, mapPoint, checkFrame}; return;
  }
  const $ = id => document.getElementById(id);
  const video = document.querySelector('video'), surface = $('surface'), poster = $('poster');
  let token = '', media = null, control = null, reconnectTimer = null, desired = false, epoch = 0;
  let config = null, player = null, pointer = null, displayed = false;
  let statusBusy = false, active = false, lastFrame = 0, lastKeyRequest = 0, retry = 0, failureTimes = [];
  const state = message => { $('state').textContent = message; };
  const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
  const send = object => { if (control?.readyState !== WebSocket.OPEN) return false; control.send(JSON.stringify(object)); return true; };
  function requestKey() {
    const now = performance.now();
    if (now - lastKeyRequest >= 2000 && send({type: 'keyframe'})) lastKeyRequest = now;
  }
  function release() {
    if (pointer !== null) { send({type: 'release'}); pointer = null; }
  }
  function snapshot() {
    if (video.readyState < 2 || !video.videoWidth) return;
    try {
      poster.width = video.videoWidth; poster.height = video.videoHeight;
      poster.getContext('2d').drawImage(video, 0, 0); poster.hidden = false;
    } catch (_) { /* A frame may disappear during decoder teardown. */ }
  }
  function resetPlayer(keep = true) {
    release(); if (keep) snapshot();
    player?.close(); player = null; config = null; displayed = false;
    if (!keep) poster.hidden = true;
  }
  function stop(message) {
    desired = false; closeSockets(); state(message); notice(message);
  }
  function recover(message) {
    const now = performance.now(); failureTimes = failureTimes.filter(t => now - t < 30000);
    if (!desired) return;
    if (failureTimes.length >= 3) { stop(message + '；请尝试降低接收机网页分辨率后重启 CarPlay'); return; }
    failureTimes.push(now);
    const info = config; resetPlayer(); notice('正在恢复视频：' + message);
    if (info && media?.readyState === WebSocket.OPEN) {
      config = info;
      try { player = makePlayer(info); requestKey(); } catch (error) { stop(error.message); }
    }
  }
  function makePlayer(info) {
    const Source = window.MediaSource;
    const codec = 'avc1.' + [...info.avcc.slice(1, 4)].map(n => n.toString(16).padStart(2, '0')).join('');
    const mime = `video/mp4; codecs="${codec}"`;
    if (!Source || !Source.isTypeSupported(mime)) throw Error('车机不支持此 H.264 MSE 格式');
    const source = new Source(), url = URL.createObjectURL(source);
    let buffer = null, closed = false, queue = [], queued = 0, waitingKey = true, failed = false;
    let previous = null, cursor = 0, sequence = 0, lastMicros = null, lastKey = 0, flushTimer = null;
    const fail = message => {
      if (!closed && !failed) { failed = true; setTimeout(() => { if (!closed) recover(message); }, 300); }
    };
    const pump = () => {
      if (closed || failed || !buffer || buffer.updating || !queue.length) return;
      const next = queue.shift(); queued -= next.length;
      try { buffer.appendBuffer(next); } catch (_) { fail('视频缓冲积压'); }
    };
    const append = bytes => {
      if (queue.length >= 90 || queued + bytes.length > 8 * 1024 * 1024) { fail('热点传输或解码速度不足'); return; }
      queue.push(bytes); queued += bytes.length; pump();
    };
    // Flush the final sample even when the sender stops at a static screen.
    // Long idle gaps are compacted; they are not a broken CarPlay session.
    const flush = duration => {
      if (!previous) return;
      append(fragment(++sequence, previous.bytes, previous.key, cursor, duration));
      cursor += duration; previous = null;
    };
    video.src = url;
    source.addEventListener('sourceopen', () => {
      if (closed) return;
      URL.revokeObjectURL(url);
      try {
        buffer = source.addSourceBuffer(mime);
        buffer.addEventListener('updateend', () => {
          if (closed) return; pump(); video.play().catch(() => { if (!closed) notice('请点重连以允许播放'); });
        });
        buffer.addEventListener('error', () => fail('视频解码失败'));
        const init = initMp4(info.avcc, info.width, info.height);
        queue.unshift(init); queued += init.length; pump();
      } catch (_) { fail('无法建立视频缓冲'); }
    }, {once: true});
    const timer = setInterval(() => {
      if (closed || failed || !buffer || !video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1), lag = end - video.currentTime;
      if (lag > 0.65) video.currentTime = Math.max(video.buffered.start(0), end - 0.15);
      video.playbackRate = lag > 0.3 ? 1.08 : 1;
      const trim = Math.min(lastKey, video.currentTime - 8);
      if (!buffer.updating && !queue.length && trim > video.buffered.start(0) + 2)
        try { buffer.remove(0, trim); } catch (_) { /* next tick */ }
    }, 250);
    return {
      feed(bytes, key, micros) {
        if (closed || failed || waitingKey && !key) return;
        const actualKey = checkFrame(bytes);
        if (key && !actualKey) throw Error('Invalid keyframe');
        if (!Number.isSafeInteger(micros) || micros < 0) throw Error('Invalid frame timestamp');
        if (lastMicros !== null && micros <= lastMicros) return;
        const delta = lastMicros === null ? 3000 : Math.round((micros - lastMicros) * 0.09);
        clearTimeout(flushTimer);
        flush(delta > 0 && delta <= 22500 ? delta : 3000);
        waitingKey = false; lastMicros = micros;
        if (key) lastKey = cursor / 90000;
        previous = {bytes: bytes.slice(), key};
        flushTimer = setTimeout(() => { if (!closed) flush(3000); }, 80);
      },
      close() {
        closed = true; clearInterval(timer); clearTimeout(flushTimer); URL.revokeObjectURL(url); queue = [];
        video.removeAttribute('src'); video.load(); video.playbackRate = 1;
      }
    };
  }
  async function readStatus() {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 4000);
    try {
      const response = await fetch('/status', {headers: {'X-Showcase-Token': token}, cache: 'no-store', signal: abort.signal});
      if (response.status === 403) throw Object.assign(Error('四位配对码不正确，请点断开后重新输入'), {permanent: true});
      if (response.status === 429) throw Object.assign(Error('配对尝试过多，请等 30 秒后重连'), {permanent: true});
      if (!response.ok) throw Error('接收机状态暂时不可用');
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function scheduleReconnect(message) {
    closeSockets(); if (!desired || document.hidden) return;
    const seconds = Math.min(10, 2 ** Math.min(retry++, 4));
    state(`${message} · ${seconds} 秒后重试`); notice('正在恢复连接，接收机请保持 Showcase 前台');
    reconnectTimer = setTimeout(connect, seconds * 1000);
  }
  async function connect() {
    closeSockets(); if (!desired || document.hidden) return;
    const current = ++epoch;
    state('正在连接'); notice('等待 CarPlay 画面…');
    try {
      const status = await readStatus(); if (current !== epoch) return;
      if (status.viewers || status.controllers) { scheduleReconnect('其他页面仍占用连接，请关闭'); return; }
      active = status.active && status.configured;
    } catch (error) {
      if (current !== epoch) return;
      if (error.permanent) stop(error.message); else scheduleReconnect('接收机暂时不可达');
      return;
    }
    const endpoint = 'ws://' + location.host, protocol = 'showcase.' + token;
    control = new WebSocket(endpoint + '/control', protocol);
    media = new WebSocket(endpoint + '/media', protocol); media.binaryType = 'arraybuffer';
    control.onopen = () => { if (current === epoch) { lastKeyRequest = -Infinity; requestKey(); } };
    media.onmessage = event => {
      if (current !== epoch || !(event.data instanceof ArrayBuffer)) return;
      try {
        const data = new Uint8Array(event.data), view = new DataView(event.data);
        if (data[0] === 3) { resetPlayer(); notice('等待新的 CarPlay 会话…'); return; }
        if (data[0] === 1) {
          if (data.length < 16) throw Error('Invalid configuration');
          const next = {generation: view.getUint32(1), width: view.getUint16(5), height: view.getUint16(7), avcc: data.slice(9)};
          if (config && config.generation === next.generation && config.width === next.width && config.height === next.height &&
              config.avcc.length === next.avcc.length && config.avcc.every((v, i) => v === next.avcc[i])) return;
          resetPlayer(); config = next; player = makePlayer(config); requestKey();
        } else if (data[0] === 2 && data.length > 14 && config && view.getUint32(1) === config.generation) {
          const micros = view.getUint32(6) * 4294967296 + view.getUint32(10);
          player.feed(data.subarray(14), data[5] === 1, micros); lastFrame = performance.now();
        }
      } catch (error) { stop(error.message); }
    };
    const disconnected = event => {
      if (current === epoch) scheduleReconnect(`连接中断 (${event.code})`);
    };
    media.onclose = disconnected; control.onclose = disconnected;
    media.onerror = control.onerror = () => {};
  }
  function closeSockets() {
    clearTimeout(reconnectTimer); reconnectTimer = null; release(); ++epoch;
    for (const socket of [media, control]) if (socket) { socket.onclose = socket.onmessage = null; socket.close(); }
    media = control = null; resetPlayer(); active = false;
  }
  video.addEventListener('playing', () => {
    displayed = true; poster.hidden = true; retry = 0; notice('');
    state(`CarPlay · ${config?.width || video.videoWidth} × ${config?.height || video.videoHeight} · 单指触控`);
  });
  video.addEventListener('error', () => { if (player) recover('视频播放错误'); });
  function point(event, clamp) {
    return config && mapPoint(surface.getBoundingClientRect(), config.width, config.height, event.clientX, event.clientY, clamp);
  }
  surface.addEventListener('pointerdown', event => {
    if (!active || !displayed || pointer !== null || event.pointerType === 'mouse' && event.button !== 0) return;
    const p = point(event, false); if (!p) return;
    event.preventDefault();
    if (send({type: 'touch', phase: 0, ...p, generation: config.generation})) {
      pointer = event.pointerId; surface.setPointerCapture(pointer);
    }
  });
  surface.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); const p = point(event, true);
    if (p) send({type: 'touch', phase: 1, ...p, generation: config.generation});
  });
  function lift(event) {
    if (event.pointerId !== pointer) return;
    const p = point(event, true);
    if (p && config) send({type: 'touch', phase: event.type === 'pointerup' ? 2 : 3, ...p, generation: config.generation});
    release();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, lift);
  surface.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', release);
  window.addEventListener('pagehide', closeSockets);
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeSockets(); else if (desired) connect(); });
  setInterval(() => { if (pointer !== null && config) send({type: 'hold', generation: config.generation}); }, 200);
  setInterval(() => {
    send({type: 'ping'});
    if (media?.readyState === WebSocket.OPEN) media.send('{"type":"ping"}');
    // Static screens are normal. Request an occasional IDR, without clearing
    // the existing frame, disabling input or hammering the sender every 2 s.
    if (desired && config && performance.now() - lastFrame > 10000 && performance.now() - lastKeyRequest > 10000) requestKey();
  }, 2000);
  setInterval(async () => {
    if (!desired || document.hidden || statusBusy || media?.readyState !== WebSocket.OPEN) return;
    statusBusy = true; const current = epoch;
    try {
      const status = await readStatus(); if (current !== epoch) return;
      active = status.active && status.configured;
      if (!active) { release(); notice('保持 Showcase 在前台，并连接发送 iPhone'); }
      else if (displayed) notice('');
    } catch (error) {
      if (current === epoch) {
        active = false; release();
        if (error.permanent) stop(error.message); else state('正在确认接收机状态');
      }
    } finally { statusBusy = false; }
  }, 1500);
  $('pair').onsubmit = event => {
    event.preventDefault(); const value = $('token').value.trim();
    if (!/^[0-9]{4}$/.test(value)) { state('请输入四位数字配对码'); return; }
    token = value; $('pair').hidden = true; surface.hidden = false;
    $('reconnect').hidden = $('disconnect').hidden = false;
    desired = true; retry = 0; failureTimes = []; lastKeyRequest = -Infinity; connect();
  };
  $('reconnect').onclick = () => { desired = true; retry = 0; failureTimes = []; connect(); };
  $('disconnect').onclick = () => {
    desired = false; closeSockets(); token = ''; $('token').value = ''; poster.hidden = true;
    surface.hidden = true; $('pair').hidden = false; $('reconnect').hidden = $('disconnect').hidden = true; state('未连接');
  };
  $('fullscreen').onclick = () => {
    const action = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
    action?.catch(() => state('请使用车机浏览器菜单调整窗口'));
  };
})();
