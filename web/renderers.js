/* SPDX-License-Identifier: GPL-3.0-or-later. Local-only display backends. */
(() => {
  'use strict';
  const {parameterSets,nals,annexB} = ShowcaseProtocol;
  const labels = {jpeg:'JPEG Canvas',mjpeg:'MJPEG Image',webcodecs:'WebCodecs Canvas',software:'Software Canvas',webrtc:'WebRTC Canvas'};
  function unsupported(mode) {
    if (mode === 'webcodecs' && !window.VideoDecoder) return window.isSecureContext ? '浏览器未提供 WebCodecs' : 'WebCodecs 需要可信 HTTPS';
    if (mode === 'software' && (!window.Worker || !window.WebAssembly)) return '浏览器缺少 Worker / WebAssembly';
    if (mode === 'webrtc' && !window.RTCPeerConnection) return '浏览器未提供 WebRTC';
    return null;
  }
  function create(mode, options) {
    const {container,config,onFrame,onError,requestKey,sendSignal} = options;
    if (unsupported(mode)) throw Error(unsupported(mode));
    let closed = false, element, pending = null, animation = null, processing = false, waitingKey = true;
    let worker, decoder, pc, video, timer, inputCount = 0, outputCount = 0, dropped = 0, inFlight = 0;
    let lastTimestamp = -1, lastSequence = -1, lastOutputAt = null, lastInputAt = 0, callbackCount = 0, lastCallbackTime = null;
    let latestQuality = 0, offered = false, remoteCandidates = [], localCandidates = [], answerSent = false;
    const output = (source, width, height, stamp) => {
      if (closed) return;
      if (Number.isFinite(stamp) && stamp <= lastTimestamp) { dropped++; return; }
      if (Number.isFinite(stamp)) lastTimestamp = stamp;
      if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
      element.getContext('2d').drawImage(source,0,0,width,height);
      outputCount++; lastOutputAt = performance.now(); onFrame();
    };
    const canvas = () => { element = document.createElement('canvas'); container.replaceChildren(element); };
    const queuePicture = frame => {
      if (closed) { frame.close(); return; }
      if (pending) { pending.close(); dropped++; } pending = frame;
      if (animation === null) animation = requestAnimationFrame(() => {
        animation = null; const next = pending; pending = null;
        if (!next) return;
        try { output(next,next.displayWidth,next.displayHeight,next.timestamp); }
        catch(error) { onError(error.message); }
        finally { next.close(); }
      });
    };
    const jpeg = async () => {
      if (processing || closed || !pending) return;
      processing = true; const next = pending; pending = null;
      try {
        const blob = new Blob([next.bytes],{type:'image/jpeg'});
        let image, cleanup;
        if (window.createImageBitmap) { image = await createImageBitmap(blob); cleanup = () => image.close(); }
        else {
          const url = URL.createObjectURL(blob); image = new Image();
          try { await new Promise((resolve,reject) => { image.onload=resolve;image.onerror=()=>reject(Error('JPEG 图片解码失败'));image.src=url; }); }
          finally { URL.revokeObjectURL(url); }
          cleanup = () => {};
        }
        try { output(image,image.width,image.height,next.sequence); } finally { cleanup(); }
      } catch(error) { if (!closed) onError(error.message); }
      finally { processing = false; if (!closed && pending) jpeg(); }
    };
    const softwareQueue = [];
    const pumpSoftware = () => {
      if (closed || !worker?.ready || inFlight || !softwareQueue.length) return;
      const data = softwareQueue.shift(); inFlight = 1; worker.postMessage({type:'frame',data},[data.buffer]);
    };
    if (mode === 'mjpeg') {
      element = document.createElement('img'); element.alt = 'CarPlay'; container.replaceChildren(element);
      element.onerror = () => { if (!closed) onError('MJPEG 图片连接中断'); };
      element.src = '/mjpeg';
      timer = setInterval(() => { if (!closed && element.naturalWidth > 0) onFrame(); },200);
    } else {
      canvas();
      if (mode === 'webcodecs') {
        decoder = new VideoDecoder({output:queuePicture,error:error => { if (!closed) onError('WebCodecs: '+error.message); }});
        try { decoder.configure({codec:'avc1.'+[...config.avcc.slice(1,4)].map(n=>n.toString(16).padStart(2,'0')).join(''),
          codedWidth:config.width,codedHeight:config.height,description:config.avcc,optimizeForLatency:true}); }
        catch(error) { decoder.close(); throw error; }
      } else if (mode === 'software') {
        if (config.avcc[1] !== 66) throw Error('Broadway 软件解码仅支持 Baseline 视频；当前源不兼容，请选择 JPEG');
        worker = new Worker('/vendor/broadway/worker.js');
        worker.onmessage = event => {
          if (closed) return; const message = event.data;
          if (message.type === 'ready') { worker.ready = true; requestKey(); pumpSoftware(); }
          if (message.type === 'consumed') { inFlight = 0; pumpSoftware(); }
          if (message.type === 'error') onError('Software: '+message.message);
          if (message.type === 'picture') {
            // Legacy AVC decoders may expose macroblock padding (1088 for
            // a 1080-line source). Preserve the advertised touch geometry.
            if (element.width !== config.width || element.height !== config.height) { element.width=config.width;element.height=config.height; }
            element.getContext('2d').putImageData(new ImageData(message.pixels,message.width,message.height),0,0);
            outputCount++; lastOutputAt=performance.now(); onFrame();
          }
        };
        worker.onerror = event => { if (!closed) onError('软件解码器加载失败：'+event.message); };
        worker.postMessage({type:'init'});
      } else if (mode === 'webrtc') {
        pc = new RTCPeerConnection({iceServers:[]});
        video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true;
        video.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px'; container.append(video);
        pc.onicecandidate = event => {
          if (!event.candidate || closed) return;
          const message={type:'rtc-candidate',candidate:event.candidate.candidate,mid:event.candidate.sdpMid || 'video',generation:config.generation};
          if(answerSent)sendSignal(message);else if(localCandidates.length<16)localCandidates.push(message);
        };
        pc.onconnectionstatechange = () => { if (!closed && pc.connectionState === 'failed') onError('WebRTC UDP / DTLS 连接失败'); };
        pc.ontrack = event => { if(closed)return;video.srcObject = new MediaStream([event.track]);video.play().catch(error=>{if(!closed)onError('WebRTC 播放被拒绝：'+error.message);}); };
        const paintVideo = (_,metadata) => {
          if (closed) return; if(metadata)callbackCount++;
          const quality = video.getVideoPlaybackQuality?.();
          const count = quality ? quality.totalVideoFrames-quality.droppedVideoFrames : null;
          const time = metadata?.mediaTime;
          const advanced = count !== null && count > latestQuality || Number.isFinite(time) && (lastCallbackTime===null || time>lastCallbackTime);
          if (count !== null) latestQuality = count;
          if (Number.isFinite(time)) lastCallbackTime = Math.max(lastCallbackTime ?? -1,time);
          if (advanced && video.readyState >= 2) {
            // A repeated callback is not evidence of a new picture. Never use
            // video.currentTime, which may advance while output is suppressed.
            try { output(video,video.videoWidth,video.videoHeight,undefined); }
            catch(error) { onError('WebRTC 绘制失败：'+error.message); }
          }
        };
        const frameCallback = (now,metadata) => {
          paintVideo(now,metadata);
          if(!closed)video.requestVideoFrameCallback(frameCallback);
        };
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frameCallback);
        // Offscreen video callbacks may stop despite continued decoding. Poll
        // the independent non-dropped frame counter too; a timer tick alone
        // never counts as a new picture and cannot mask suppressed decoding.
        timer = setInterval(paintVideo,33);
      }
    }
    return {
      feed(packet) {
        if (closed) return; inputCount++; lastInputAt = performance.now();
        if (mode === 'jpeg') {
          if (packet.sequence <= lastSequence) return; lastSequence=packet.sequence;
          if (pending) dropped++; pending=packet; jpeg(); return;
        }
        if (mode === 'mjpeg' || mode === 'webrtc') return;
        if (waitingKey && !packet.key) { requestKey(); return; }
        if (mode === 'webcodecs') {
          if (decoder.decodeQueueSize >= 6) { waitingKey=true;dropped++;requestKey();return; }
          try { decoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp:packet.micros,data:packet.bytes}));waitingKey=false; }
          catch(error) { onError(error.message); }
        } else {
          if (softwareQueue.length >= 4) { softwareQueue.length=0;waitingKey=true;dropped++;requestKey(); }
          if (waitingKey && !packet.key) return;
          const units=nals(packet.bytes); if (packet.key) units.unshift(...parameterSets(config.avcc));
          softwareQueue.push(annexB(units)); waitingKey=false; pumpSoftware();
        }
      },
      async signal(message) {
        if (closed || !pc) return;
        try {
          if (message.type === 'rtc-description') {
            await pc.setRemoteDescription({type:message.descriptionType,sdp:message.sdp});
            if (closed) return;
            offered=true; for (const candidate of remoteCandidates) await pc.addIceCandidate(candidate); remoteCandidates=[];
            const answer=await pc.createAnswer(); if(closed)return; await pc.setLocalDescription(answer);if(closed)return;
            sendSignal({type:'rtc-answer',sdp:pc.localDescription.sdp,generation:config.generation});
            answerSent=true;for(const candidate of localCandidates)sendSignal(candidate);localCandidates=[];
          } else if (message.type === 'rtc-candidate') {
            const candidate={candidate:message.candidate,sdpMid:message.mid};
            if (offered) await pc.addIceCandidate(candidate); else remoteCandidates.push(candidate);
          } else if (message.type === 'rtc-error') onError(message.message);
        } catch(error) { if(!closed)onError('WebRTC 协商失败：'+error.message); }
      },
      stats() {
        const quality=video?.getVideoPlaybackQuality?.();
        return {renderer:mode,inputFrames:inputCount,drawnFrames:mode==='mjpeg'?null:outputCount,droppedFrames:dropped,
          waitingKey:mode==='jpeg'||mode==='mjpeg'||mode==='webrtc'?false:waitingKey,
          decodeQueue:decoder?.decodeQueueSize ?? softwareQueue.length+inFlight,
          lastDrawAgeMs:lastOutputAt===null?null:Math.round(performance.now()-lastOutputAt),lastDrawTimestamp:lastTimestamp,
          lastInputAgeMs:lastInputAt?Math.round(performance.now()-lastInputAt):null,
          frameCallbackCount:callbackCount,presentedMediaTime:lastCallbackTime,
          totalVideoFrames:quality?.totalVideoFrames ?? null,videoDroppedFrames:quality?.droppedVideoFrames ?? null,
          videoPaused:video?.paused ?? null,rtcState:pc?.connectionState ?? null};
      },
      snapshotSource:()=>element,
      close() {
        closed=true;clearInterval(timer); if(animation!==null)cancelAnimationFrame(animation);
        if (pending?.close) pending.close();pending=null;softwareQueue.length=0;
        if(decoder && decoder.state!=='closed')decoder.close();worker?.terminate();
        if(pc) { pc.ontrack=pc.onicecandidate=pc.onconnectionstatechange=null;pc.close(); }
        if(video) { video.pause();video.srcObject=null; }
        if(mode==='mjpeg') { element.onerror=null;element.removeAttribute('src'); }
      }
    };
  }
  window.ShowcaseRenderers = {labels,unsupported,create};
})();
