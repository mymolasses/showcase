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
  function mapPoint(rect, width, height, x, y, clamp, fill = false) {
    if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    let px = fill ? (x - rect.left) * width / rect.width : (x - rect.left - (rect.width - width * scale) / 2) / scale;
    let py = fill ? (y - rect.top) * height / rect.height : (y - rect.top - (rect.height - height * scale) / 2) / scale;
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
  let media = null, control = null, reconnectTimer = null, socketTimer = null, desired = true, epoch = 0;
  let fill = true;
  let config = null, player = null, pointer = null, displayed = false;
  let pendingMove = null, moveFrame = null;
  let statusBusy = false, active = false, lastFrame = 0, lastKeyRequest = 0, retry = 0, failureTimes = [];
  const metrics = {received: 0, bytes: 0, presented: 0, frameSignal: '不可用', recoveries: 0, reconnects: 0, lastReason: '首次连接', server: null,
    lastPresentedAt: null, presentedMediaTime: null, browserPresentedFrames: null, lastPlayError: null, pauseCount: 0,
    frameCallbacks: 0, repeatedFrameCallbacks: 0, lastFrameCallbackAt: null};
  const playError = error => { metrics.lastPlayError = {name: error.name || 'Error', message: error.message || String(error)}; };
  const state = message => { $('state').textContent = message; };
  const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
  const send = object => {
    if (control?.readyState !== WebSocket.OPEN) return false;
    // Do not let a stalled radio accumulate seconds of obsolete gestures.
    if (control.bufferedAmount > 4096) {
      release(false); scheduleReconnect('控制通道积压，重新连接'); return false;
    }
    try { control.send(JSON.stringify(object)); return true; }
    catch (_) { release(false); scheduleReconnect('控制通道发送失败'); return false; }
  };
  function requestKey() {
    const now = performance.now();
    if (now - lastKeyRequest >= 2000 && send({type: 'keyframe'})) lastKeyRequest = now;
  }
  function release(notify = true) {
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    moveFrame = pendingMove = null;
    const previous = pointer; pointer = null;
    // Clear our state before releasing capture, which can synchronously emit
    // lostpointercapture. Failure/reconnect paths must not recursively send.
    if (previous !== null) {
      if (surface.hasPointerCapture(previous)) surface.releasePointerCapture(previous);
      if (notify) send({type: 'release'});
    }
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
  function showFrame() {
    if (displayed || !player || !config) return;
    displayed = true; poster.hidden = true; retry = 0; notice('');
    state(`CarPlay · ${config.width} × ${config.height} · 单指触控`);
  }
  function recover(message) {
    const now = performance.now(); failureTimes = failureTimes.filter(t => now - t < 30000);
    if (!desired) return;
    metrics.recoveries++; metrics.lastReason = message;
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
    let lastPosition = 0, progressedAt = performance.now(), lastInputAt = 0, lastSeekAt = -Infinity;
    let inputCount = 0, progressedInput = 0, seekAttempts = 0, frameCallback = null, qualityFrames = 0;
    let keyTimes = [], trimBefore = 0, lastMediaTime = null;
    metrics.lastPresentedAt = metrics.lastFrameCallbackAt = null;
    metrics.presentedMediaTime = metrics.browserPresentedFrames = null;
    metrics.frameSignal = '不可用';
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const markProgress = () => {
      // A single picture produced by our own seek is not sustained playback.
      if (performance.now() - lastSeekAt < 500) return;
      progressedAt = performance.now(); progressedInput = inputCount; seekAttempts = 0;
    };
    const observeProgress = (mediaTimeAdvanced = false) => {
      const quality = video.getVideoPlaybackQuality?.();
      const hasQuality = quality && Number.isFinite(quality.totalVideoFrames) &&
        Number.isFinite(quality.droppedVideoFrames) && quality.totalVideoFrames >= quality.droppedVideoFrames;
      let frames = 0;
      if (hasQuality) {
        // totalVideoFrames includes drops, including frames dropped before
        // decode. Callback counts alone can keep advancing on a frozen video.
        const count = quality.totalVideoFrames - quality.droppedVideoFrames;
        frames = Math.max(0, count - qualityFrames); qualityFrames = count;
        metrics.frameSignal = '浏览器非丢弃帧计数';
      } else if (hasFrameCallback && lastMediaTime !== null) {
        frames = mediaTimeAdvanced ? 1 : 0;
        metrics.frameSignal = '画面时间戳推进';
      } else if (!hasFrameCallback && !video.seeking && video.currentTime > lastPosition + 0.005) {
        markProgress(); // Legacy timeline fallback cannot supply a frame rate.
      }
      if (frames > 0) {
        metrics.presented += frames; metrics.lastPresentedAt = performance.now(); markProgress();
        if (!waitingKey && source.readyState === 'open' && video.readyState >= 2) showFrame();
      }
    };
    const onFrame = (_, metadata) => {
      if (closed) return;
      metrics.frameCallbacks++; metrics.lastFrameCallbackAt = performance.now();
      metrics.presentedMediaTime = metadata?.mediaTime ?? null;
      metrics.browserPresentedFrames = metadata?.presentedFrames ?? null;
      const time = metadata?.mediaTime;
      const advanced = Number.isFinite(time) && time >= 0 && (lastMediaTime === null || time > lastMediaTime);
      if (advanced) lastMediaTime = time;
      else if (Number.isFinite(time)) metrics.repeatedFrameCallbacks++;
      observeProgress(advanced);
      frameCallback = video.requestVideoFrameCallback(onFrame);
    };
    if (hasFrameCallback) frameCallback = video.requestVideoFrameCallback(onFrame);
    const resume = () => {
      if (closed || failed || !video.buffered.length) return;
      const now = performance.now(), ranges = video.buffered;
      const start = ranges.start(ranges.length - 1), end = ranges.end(ranges.length - 1);
      observeProgress();
      const receiving = inputCount - progressedInput >= 3 && now - lastInputAt < 1500;
      const stuck = receiving && now - progressedAt > 1000;
      if (stuck && ((seekAttempts >= 2 && now - lastSeekAt > 2000) || (video.seeking && now - progressedAt > 5000))) {
        fail('视频持续停滞，重建播放器'); return;
      }
      if (!video.seeking && seekAttempts < 2 && now - lastSeekAt > 1500 &&
          (video.currentTime < start || end - video.currentTime > 0.65 || stuck)) {
        video.currentTime = Math.max(start, end - 0.15);
        lastSeekAt = now; seekAttempts++;
      }
      lastPosition = video.currentTime;
      video.playbackRate = 1;
      if (video.paused) video.play().catch(error => { if (!closed) { playError(error); notice('请轻点画面以允许播放'); } });
    };
    const fail = message => {
      if (!closed && !failed) { failed = true; setTimeout(() => { if (!closed) recover(message); }, 300); }
    };
    const pump = () => {
      if (closed || failed || !buffer || buffer.updating) return;
      // Eviction gets an updateend turn even under continuous append traffic.
      if (trimBefore > 0) {
        const cut = trimBefore; trimBefore = 0;
        try { buffer.remove(0, cut); keyTimes = keyTimes.filter(t => t >= cut); }
        catch (_) { fail('历史视频缓冲清理失败'); }
        return;
      }
      if (!queue.length) return;
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
      if (previous.key) keyTimes.push(cursor / 90000);
      append(fragment(++sequence, previous.bytes, previous.key, cursor, duration));
      cursor += duration; previous = null;
    };
    video.src = url;
    source.addEventListener('sourceopen', () => {
      if (closed) return;
      URL.revokeObjectURL(url);
      try {
        buffer = source.addSourceBuffer(mime);
        source.duration = Infinity;
        buffer.addEventListener('updateend', () => {
          if (closed) return; resume(); pump();
        });
        buffer.addEventListener('error', () => fail('视频解码失败'));
        const init = initMp4(info.avcc, info.width, info.height);
        queue.unshift(init); queued += init.length; pump();
      } catch (_) { fail('无法建立视频缓冲'); }
    }, {once: true});
    const timer = setInterval(() => {
      if (closed || failed || !buffer || !video.buffered.length) return;
      resume();
      const history = video.currentTime - video.buffered.start(0);
      // Request a fresh IDR before old data becomes impossible to evict safely.
      if (history > 10 && video.currentTime - lastKey > 8) requestKey();
      if (history > 30) { fail('历史缓冲超过上限，重建播放器'); return; }
      const safe = keyTimes.filter(t => t <= video.currentTime - 8).pop() || 0;
      if (safe > video.buffered.start(0) + 2) { trimBefore = safe; pump(); }
    }, 250);
    return {
      feed(bytes, key, micros) {
        if (closed || failed || waitingKey && !key) return;
        const actualKey = checkFrame(bytes);
        if (key && !actualKey) throw Error('Invalid keyframe');
        if (!Number.isSafeInteger(micros) || micros < 0) throw Error('Invalid frame timestamp');
        inputCount++; lastInputAt = performance.now();
        // Arrival order is decode order for the supported no-B-frame stream.
        // Repeated/unusable sender PTS must not discard valid decoded pictures.
        const delta = lastMicros === null ? 3000 : Math.round((micros - lastMicros) * 0.09);
        clearTimeout(flushTimer);
        flush(delta > 0 && delta <= 22500 ? delta : 3000);
        waitingKey = false; lastMicros = micros;
        if (key) lastKey = cursor / 90000;
        previous = {bytes: bytes.slice(), key};
        flushTimer = setTimeout(() => { if (!closed) flush(3000); }, 80);
      },
      stats() {
        const ranges = video.buffered;
        return {waitingKey, seekAttempts, queuedBytes: queued, bufferedAheadMs: ranges.length ? Math.round((ranges.end(ranges.length - 1) - video.currentTime) * 1000) : 0,
          historySeconds: ranges.length ? Math.round(video.currentTime - ranges.start(0)) : 0};
      },
      close() {
        closed = true; clearInterval(timer); clearTimeout(flushTimer); URL.revokeObjectURL(url); queue = [];
        if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
        video.removeAttribute('src'); video.load(); video.playbackRate = 1;
      }
    };
  }
  async function readStatus() {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 4000);
    try {
      const response = await fetch('/status', {cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw Error('接收机状态暂时不可用');
      const status = await response.json(); metrics.server = status; return status;
    } finally { clearTimeout(timeout); }
  }
  function scheduleReconnect(message) {
    metrics.reconnects++; metrics.lastReason = message;
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
    const endpoint = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    control = new WebSocket(endpoint + '/control');
    media = new WebSocket(endpoint + '/media'); media.binaryType = 'arraybuffer';
    const opened = () => {
      if (current === epoch && media?.readyState === WebSocket.OPEN && control?.readyState === WebSocket.OPEN) {
        clearTimeout(socketTimer); socketTimer = null;
      }
    };
    socketTimer = setTimeout(() => {
      if (current === epoch) scheduleReconnect('视频或控制连接超时');
    }, 8000);
    media.onopen = opened;
    control.onopen = () => { if (current === epoch) { opened(); lastKeyRequest = -Infinity; requestKey(); } };
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
          metrics.received++; metrics.bytes += data.length - 14;
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
    clearTimeout(socketTimer); socketTimer = null;
    clearTimeout(reconnectTimer); reconnectTimer = null; release(); ++epoch;
    for (const socket of [media, control]) if (socket) { socket.onclose = socket.onmessage = null; socket.close(); }
    media = control = null; resetPlayer(); active = false;
  }
  video.addEventListener('playing', showFrame);
  video.addEventListener('error', () => { if (player) recover('视频播放错误'); });
  video.addEventListener('pause', () => { metrics.pauseCount++; });
  function point(event, clamp) {
    return config && mapPoint(surface.getBoundingClientRect(), config.width, config.height, event.clientX, event.clientY, clamp, fill);
  }
  surface.addEventListener('pointerdown', event => {
    video.play().catch(playError);
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
    if (p) {
      pendingMove = {type: 'touch', phase: 1, ...p, generation: config.generation};
      if (moveFrame === null) moveFrame = requestAnimationFrame(() => {
        const message = pendingMove; moveFrame = pendingMove = null;
        if (pointer !== null && message) send(message);
      });
    }
  });
  function lift(event) {
    if (event.pointerId !== pointer) return;
    const p = point(event, true);
    // A quick swipe can finish before the next animation frame. Preserve its
    // last move before up; cancellation must instead discard queued moves.
    if (event.type === 'pointerup' && pendingMove) {
      const message = pendingMove;
      cancelAnimationFrame(moveFrame); moveFrame = pendingMove = null;
      if (!send(message)) { release(); return; }
    }
    if (p && config) send({type: 'touch', phase: event.type === 'pointerup' ? 2 : 3, ...p, generation: config.generation});
    release();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, lift);
  surface.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', () => release());
  window.addEventListener('resize', () => release());
  window.addEventListener('pagehide', closeSockets);
  window.addEventListener('pageshow', event => { if (event.persisted && desired) connect(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeSockets(); else if (desired) connect(); });
  setInterval(() => { if (pointer !== null && config) send({type: 'hold', generation: config.generation}); }, 200);
  setInterval(() => {
    send({type: 'ping'});
    if (media?.readyState === WebSocket.OPEN) media.send('{"type":"ping"}');
    // Static screens are normal. Request an occasional IDR, without clearing
    // the existing frame, disabling input or hammering the sender every 2 s.
    // Delta frames can keep arriving after a lost IDR. They must not suppress
    // startup/recovery requests just because lastFrame is recent.
    if (desired && config && (player?.stats().waitingKey ||
        performance.now() - lastFrame > 10000 && performance.now() - lastKeyRequest > 10000)) requestKey();
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
  $('reconnect').onclick = () => { metrics.reconnects++; metrics.lastReason = '手动重连'; desired = true; retry = 0; failureTimes = []; connect(); };
  $('disconnect').onclick = () => {
    desired = false; closeSockets(); state('已断开，点重连恢复'); notice('已断开');
  };
  $('fit').onclick = () => {
    release(); fill = !fill; document.body.classList.toggle('contain', !fill);
    $('fit').textContent = fill ? '显示：填满' : '显示：等比';
  };
  $('menu').onclick = () => { const bar = $('toolbar'); bar.hidden = !bar.hidden; };
  let rateAt = performance.now(), rateReceived = 0, ratePresented = 0, rateBytes = 0, rateCallbacks = 0;
  let rates = {receivedFps: 0, presentedFps: null, frameCallbackFps: 0, bitrateMbps: 0};
  function diagnosticSnapshot() {
    const quality = video.getVideoPlaybackQuality?.();
    return {app: 'Showcase+', version: metrics.server?.version || '等待接收机', build: metrics.server?.build || '', entry: location.origin,
      resolution: config ? `${config.width} × ${config.height}` : '等待视频', ...rates, presentationSignal: metrics.frameSignal,
      ...player?.stats(), receivedFrames: metrics.received, recoveryCount: metrics.recoveries, reconnectCount: metrics.reconnects,
      lastReason: metrics.lastReason, sourceFrameAgeMs: metrics.server?.frameAgeMs ?? null,
      controlBufferedBytes: control?.bufferedAmount ?? 0,
      inputOwner: metrics.server?.inputOwner ?? 'unknown',
      documentVisibility: document.visibilityState || (document.hidden ? 'hidden' : 'visible'),
      videoPaused: video.paused, videoSeeking: video.seeking, videoReadyState: video.readyState,
      posterVisible: !poster.hidden, displayed,
      videoCurrentTime: video.currentTime, totalVideoFrames: quality?.totalVideoFrames ?? null, droppedFrames: quality?.droppedVideoFrames ?? null,
      nonDroppedFrames: quality ? Math.max(0, quality.totalVideoFrames - quality.droppedVideoFrames) : null,
      frameCallbackCount: metrics.frameCallbacks, repeatedFrameCallbacks: metrics.repeatedFrameCallbacks,
      lastFrameCallbackAgeMs: metrics.lastFrameCallbackAt === null ? null : Math.round(performance.now() - metrics.lastFrameCallbackAt),
      lastPresentedAgeMs: metrics.lastPresentedAt === null ? null : Math.round(performance.now() - metrics.lastPresentedAt),
      presentedMediaTime: metrics.presentedMediaTime, browserPresentedFrames: metrics.browserPresentedFrames,
      pauseCount: metrics.pauseCount, lastPlayError: metrics.lastPlayError,
      videoError: video.error ? {code: video.error.code, message: video.error.message} : null,
      serverQueueBytes: metrics.server?.mediaQueueBytes ?? null, congestionRecoveries: metrics.server?.congestionRecoveries ?? null};
  }
  function renderDiagnostics() { if (!$('diagnostic-panel').hidden) $('diagnostic-data').textContent = JSON.stringify(diagnosticSnapshot(), null, 2); }
  setInterval(() => {
    const now = performance.now(), seconds = (now - rateAt) / 1000;
    if (seconds <= 0) return;
    rates = {receivedFps: +((metrics.received - rateReceived) / seconds).toFixed(1),
      presentedFps: metrics.frameSignal === '不可用' ? null : +((metrics.presented - ratePresented) / seconds).toFixed(1),
      frameCallbackFps: +((metrics.frameCallbacks - rateCallbacks) / seconds).toFixed(1),
      bitrateMbps: +((metrics.bytes - rateBytes) * 8 / seconds / 1e6).toFixed(2)};
    rateAt = now; rateReceived = metrics.received; ratePresented = metrics.presented; rateBytes = metrics.bytes; rateCallbacks = metrics.frameCallbacks;
    renderDiagnostics();
  }, 1000);
  $('diagnostics').onclick = () => { $('diagnostic-panel').hidden = !$('diagnostic-panel').hidden; renderDiagnostics(); };
  $('diagnostic-close').onclick = () => { $('diagnostic-panel').hidden = true; };
  $('diagnostic-copy').onclick = async () => {
    const text = JSON.stringify(diagnosticSnapshot(), null, 2);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea'); field.value = text; field.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(field); field.select();
        try { if (!document.execCommand('copy')) throw Error('copy unavailable'); } finally { field.remove(); }
      }
      $('diagnostic-copy').textContent = '已复制';
    } catch (_) { $('diagnostic-copy').textContent = '复制失败，可手动复制下方文字'; }
  };
  $('fullscreen').onclick = () => {
    const action = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
    action?.catch(() => state('请使用车机浏览器菜单调整窗口'));
  };
  connect();
})();
