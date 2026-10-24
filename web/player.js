/* SPDX-License-Identifier: GPL-3.0-or-later. No external scripts/services. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), surface=$('surface'), poster=$('poster'), display=$('display');
  const {mapPoint,parsePacket,displaySize}=ShowcaseProtocol, backends=ShowcaseRenderers;
  let mode='jpeg'; try { const saved=localStorage.getItem('showcase.renderer.v1');if(backends.labels[saved])mode=saved; } catch(_) {}
  let desired=true, active=false, displayed=false, fill=false, config=null, renderer=null, media=null, control=null;
  let outputMode='auto',outputInitialized=false,selectingOutput=false,outputTimer=null,lastOutputSent=-Infinity,viewport={};
  let epoch=0, retry=0, reconnectTimer=null, socketTimer=null, startupTimer=null, statusBusy=false, pointer=null;
  let pendingMove=null, moveFrame=null, signals=[], lastKeyRequest=-Infinity, failures=[], server=null, lastDrawSource=0;
  const metrics={received:0,bytes:0,drawn:0,reconnects:0,recoveries:0,lastReason:'首次连接',fallbackReason:null,lastDrawAt:null,lastFailure:null};
  const state=message=>{$('state').textContent=message;};
  const notice=message=>{$('notice').textContent=message;$('notice').hidden=!message;};
  function measureViewport() {
    const rect=surface.getBoundingClientRect(), visual=window.visualViewport;
    const width=Math.min(window.innerWidth || rect.width,visual?.width || Infinity);
    const height=Math.min(window.innerHeight || rect.height,visual?.height || Infinity);
    if(visual?.scale && Math.abs(visual.scale-1)>.02)return; // Pinch zoom is not a new display.
    if(surface.style){surface.style.width=width+'px';surface.style.height=height+'px';}
    const density=Math.min(2,Math.max(1,window.devicePixelRatio || 1));
    viewport={cssWidth:Math.round(width),cssHeight:Math.round(height),width:Math.round(width*density),height:Math.round(height*density)};
  }
  function outputTarget() {
    if(outputMode==='auto')return displaySize(viewport.width,viewport.height);
    if(outputMode==='phone')return server?.phoneDisplay?.width ? server.phoneDisplay : null;
    const [width,height]=outputMode.split('x').map(Number);return displaySize(width,height);
  }
  function outputMatches() {
    const target=outputTarget(), saved=server?.displayRequest;
    const tolerance=outputMode==='auto' ? .01 : 0;
    return target && saved?.mode===outputMode && Math.abs(saved.width-target.width)<=Math.max(2,target.width*tolerance) && Math.abs(saved.height-target.height)<=Math.max(2,target.height*tolerance);
  }
  function queueOutput() {
    if(outputTimer!==null || !server?.displayControl || outputMatches())return;
    outputTimer=setTimeout(()=>{
      outputTimer=null;
      if(!desired || document.hidden || !active || !outputTarget() || outputMatches() || performance.now()-lastOutputSent<8000)return;
      if(send({type:'display',mode:outputMode,...(outputMode==='auto'?{width:viewport.width,height:viewport.height}:{})})) {
        lastOutputSent=performance.now();$('display-hint').textContent='正在应用输出比例，CarPlay 将重新连接，请保持手机 App 在前台…';
      }
    },2000);
  }
  function updateOutput(status) {
    const selector=$('output-resolution');selector.disabled=!status?.displayControl;
    if(!status?.displayControl){$('display-hint').textContent='接收机尚未提供输出比例控制';return;}
    const saved=status.displayRequest || {mode:'auto'};
    if(!outputInitialized || !selectingOutput){outputMode=saved.mode || 'auto';outputInitialized=true;}
    if(saved.mode===outputMode)selectingOutput=false;
    selector.value=outputMode;
    const target=outputTarget(), prefix=outputMode==='auto'?'车机浏览器':outputMode==='phone'?'手机屏幕':'固定输出';
    const actual=status.width && status.height ? `${status.width} × ${status.height}`:'等待视频';
    $('display-hint').textContent=status.displayError || `${prefix}：${target?`${target.width} × ${target.height}`:'等待尺寸'}；当前源 ${actual}。完整显示，不裁切。切换输出需重连 CarPlay。`;
    queueOutput();
  }
  function updateOptions(status) {
    for(const option of $('renderer').options) {
      let reason=backends.unsupported(option.value);
      if(option.value==='software' && status?.sourceAVCProfile && status.sourceAVCProfile!==66)
        reason='当前 H.264 Profile '+status.sourceAVCProfile+' 不支持 Baseline 软件解码';
      option.disabled=!!reason;option.textContent=backends.labels[option.value]+(reason?'（'+reason+'）':'');
    }
  }
  function imageFailure(status) {
    if((mode!=='jpeg' && mode!=='mjpeg') || displayed || !status?.jpegLastError)return;
    const message=status.jpegRecoveryExhausted ? '手机图片解码失败：'+status.jpegLastError+'；请复制诊断' :
      status.jpegDecoderBackend==='ffmpeg' ? '系统解码不可用，正在用 CPU 解码等待关键帧…' :
      '手机图片解码器正在恢复：'+status.jpegLastError;
    notice(message);
  }
  function send(object) {
    if(control?.readyState!==WebSocket.OPEN) {
      if(object.type.startsWith('rtc-') && signals.length<16)signals.push(object);
      return false;
    }
    if(control.bufferedAmount>(object.type.startsWith('rtc-')?65536:4096)) {
      release(false);scheduleReconnect('控制通道积压');return false;
    }
    try { control.send(JSON.stringify(object));return true; }
    catch(_) { release(false);scheduleReconnect('控制通道发送失败');return false; }
  }
  function requestKey() {
    if(performance.now()-lastKeyRequest>=2000 && send({type:'keyframe'}))lastKeyRequest=performance.now();
  }
  function release(notify=true) {
    if(moveFrame!==null)cancelAnimationFrame(moveFrame);moveFrame=pendingMove=null;
    const old=pointer;pointer=null;
    if(old!==null) { if(surface.hasPointerCapture(old))surface.releasePointerCapture(old);if(notify)send({type:'release'}); }
  }
  function snapshot() {
    const source=renderer?.snapshotSource();
    const width=source?.naturalWidth || source?.videoWidth || source?.width;
    const height=source?.naturalHeight || source?.videoHeight || source?.height;
    if(!width || !height)return;
    try { poster.width=width;poster.height=height;poster.getContext('2d').drawImage(source,0,0);poster.hidden=false; } catch(_) {}
  }
  function resetRenderer() {
    release();snapshot();renderer?.close();renderer=null;display.replaceChildren();displayed=false;
    clearTimeout(startupTimer);startupTimer=null;metrics.lastDrawAt=null;
  }
  function closeSockets() {
    clearTimeout(socketTimer);clearTimeout(reconnectTimer);socketTimer=reconnectTimer=null;
    release();++epoch;signals=[];
    for(const socket of [media,control])if(socket){socket.onclose=socket.onmessage=socket.onopen=null;socket.close();}
    media=control=null;resetRenderer();config=null;active=false;
  }
  function scheduleReconnect(reason) {
    metrics.reconnects++;metrics.lastReason=reason;closeSockets();if(!desired || document.hidden)return;
    const seconds=Math.min(10,2**Math.min(retry++,4));state(`${reason} · ${seconds} 秒后重试`);
    notice('正在恢复连接，请保持 Showcase 在前台');reconnectTimer=setTimeout(connect,seconds*1000);
  }
  function recover(reason) {
    if(!desired)return;metrics.recoveries++;metrics.lastReason=reason;
    metrics.lastFailure={reason,renderer:renderer?.stats() ?? null,receiver:server};
    const now=performance.now();failures=failures.filter(t=>now-t<30000);failures.push(now);
    if(mode!=='jpeg') {
      metrics.fallbackReason=`${backends.labels[mode]}：${reason}`;mode='jpeg';$('renderer').value=mode;
      scheduleReconnect('已切换 JPEG：'+reason);return;
    }
    if(failures.length>=4) { desired=false;closeSockets();notice('图片输出连续失败，请驻车后检查接收机诊断并点重连');state(reason);return; }
    scheduleReconnect(reason);
  }
  function makeRenderer(next) {
    config=next;resetRenderer();const current=epoch;
    try {
      renderer=backends.create(mode,{container:display,config,
        requestKey,sendSignal:send,
        onFrame() {
          if(current!==epoch || !renderer)return;
          if(mode!=='mjpeg')metrics.drawn++;
          metrics.lastDrawAt=performance.now();lastDrawSource=server?.receivedFrames || 0;
          displayed=true;poster.hidden=true;retry=0;notice('');clearTimeout(startupTimer);startupTimer=null;
          state(`CarPlay · ${config.width} × ${config.height} · ${backends.labels[mode]}`);
        },
        onError(reason) { if(current===epoch)setTimeout(()=>{if(current===epoch)recover(reason);},0); }
      });
      startupTimer=setTimeout(()=>{if(current===epoch && !displayed)recover('等待第一帧超时');},15000);
      requestKey();
    } catch(error) { setTimeout(()=>{if(current===epoch)recover(error.message);},0); }
  }
  async function readStatus() {
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),4000);
    try { const response=await fetch('/status',{cache:'no-store',signal:abort.signal});
      if(!response.ok)throw Error('接收机暂时不可达');const status=await response.json();server=status;return status;
    } finally { clearTimeout(timer); }
  }
  async function connect() {
    closeSockets();if(!desired || document.hidden)return;const current=++epoch;
    state('正在连接 · '+backends.labels[mode]);notice('等待 CarPlay 画面…');
    let status;
    try { status=await readStatus();if(current!==epoch)return;updateOptions(status);
      if(mode==='software' && status.sourceAVCProfile && status.sourceAVCProfile!==66) {
        recover('Broadway 软件解码仅支持 Baseline，当前 Profile '+status.sourceAVCProfile+' 不兼容');return;
      }
      if(status.viewers || status.controllers){scheduleReconnect('其他页面仍占用连接，请关闭');return;}
      active=status.active && status.configured;
    } catch(error) { if(current===epoch)scheduleReconnect(error.message);return; }
    const endpoint=(location.protocol==='https:'?'wss://':'ws://')+location.host;
    control=new WebSocket(endpoint+'/control');
    const opened=()=>{if(current===epoch && control?.readyState===WebSocket.OPEN && (!media || media.readyState===WebSocket.OPEN)){clearTimeout(socketTimer);socketTimer=null;}};
    control.onopen=()=>{if(current!==epoch)return;opened();lastKeyRequest=-Infinity;
      const queued=signals;signals=[];for(const message of queued)send(message);requestKey();updateOutput(server);};
    if(mode==='mjpeg') {
      if(active)makeRenderer({generation:status.generation,width:status.width,height:status.height});
    } else {
      media=new WebSocket(endpoint+(mode==='jpeg'?'/jpeg':mode==='webrtc'?'/rtc':'/media'));media.binaryType='arraybuffer';media.onopen=opened;
      media.onmessage=event=>{
        if(current!==epoch)return;
        try {
          if(typeof event.data==='string') { const message=JSON.parse(event.data);if(message.generation===config?.generation)renderer?.signal(message);return; }
          if(!(event.data instanceof ArrayBuffer))return;const packet=parsePacket(event.data);
          if(packet.type==='reset'){resetRenderer();config=null;active=false;notice('等待新的 CarPlay 会话…');return;}
          if(packet.type==='config') {
            const next=packet.config;
            if(config && config.generation===next.generation && config.width===next.width && config.height===next.height &&
                config.avcc?.length===next.avcc.length && config.avcc.every((v,i)=>v===next.avcc[i]))return;
            active=true;makeRenderer(next);return;
          }
          if(packet.generation===config?.generation && renderer) { metrics.received++;metrics.bytes+=packet.bytes.length;renderer.feed(packet); }
        } catch(error) { recover(error.message); }
      };
    }
    const disconnected=event=>{if(current===epoch)scheduleReconnect(`连接中断 (${event.code})`);};
    for(const socket of [media,control])if(socket){socket.onclose=disconnected;socket.onerror=()=>{};}
    socketTimer=setTimeout(()=>{if(current===epoch)scheduleReconnect('视频或控制连接超时');},8000);
  }
  function point(event,clamp) { return config && mapPoint(surface.getBoundingClientRect(),config.width,config.height,event.clientX,event.clientY,clamp,fill); }
  surface.addEventListener('pointerdown',event=>{
    if(!active || !displayed || pointer!==null || event.pointerType==='mouse' && event.button!==0)return;
    const p=point(event,false);if(!p)return;event.preventDefault();
    if(send({type:'touch',phase:0,...p,generation:config.generation})){pointer=event.pointerId;surface.setPointerCapture(pointer);}
  });
  surface.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer)return;event.preventDefault();const p=point(event,true);if(!p)return;
    pendingMove={type:'touch',phase:1,...p,generation:config.generation};
    if(moveFrame===null)moveFrame=requestAnimationFrame(()=>{const message=pendingMove;moveFrame=pendingMove=null;if(pointer!==null && message)send(message);});
  });
  function lift(event) {
    if(event.pointerId!==pointer)return;const p=point(event,true);
    if(event.type==='pointerup' && pendingMove) { const message=pendingMove;cancelAnimationFrame(moveFrame);moveFrame=pendingMove=null;if(!send(message)){release();return;} }
    if(p && config)send({type:'touch',phase:event.type==='pointerup'?2:3,...p,generation:config.generation});release();
  }
  for(const name of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(name,lift);
  surface.addEventListener('contextmenu',event=>event.preventDefault());
  function resized(){release();measureViewport();clearTimeout(outputTimer);outputTimer=null;if(outputMode==='auto')queueOutput();}
  window.addEventListener('blur',()=>release());window.addEventListener('resize',resized);
  window.visualViewport?.addEventListener('resize',resized);
  document.addEventListener('fullscreenchange',resized);
  window.addEventListener('pagehide',closeSockets);window.addEventListener('pageshow',event=>{if(event.persisted && desired)connect();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)closeSockets();else if(desired)connect();});
  setInterval(()=>{if(pointer!==null && config)send({type:'hold',generation:config.generation});},200);
  setInterval(()=>{
    send({type:'ping'});if(media?.readyState===WebSocket.OPEN)media.send('{"type":"ping"}');
    if(config && renderer?.stats().waitingKey)requestKey();
  },2000);
  setInterval(async()=>{
    if(!desired || document.hidden || statusBusy || control?.readyState!==WebSocket.OPEN)return;
    statusBusy=true;const current=epoch;
    try { const status=await readStatus();if(current!==epoch)return;updateOptions(status);active=status.active && status.configured;
      if(!active){release();resetRenderer();config=null;notice('保持 Showcase 在前台，并连接发送 iPhone');}
      else if(mode==='mjpeg' && (!config || config.generation!==status.generation))makeRenderer({generation:status.generation,width:status.width,height:status.height});
      imageFailure(status);updateOutput(status);
      const stats=renderer?.stats();
      const receiving=stats?.inputFrames>=3 && stats.lastInputAgeMs<1500 || mode==='webrtc' && status.rtcConnected && status.receivedFrames-lastDrawSource>=3 && status.frameAgeMs>=0 && status.frameAgeMs<1500;
      if(receiving && stats?.lastDrawAgeMs>3000 && mode!=='mjpeg')recover('持续收帧但画面未推进');
    } catch(error) { if(current===epoch){active=false;release();state(error.message);} }
    finally { statusBusy=false; }
  },1500);
  $('renderer').value=mode;
  updateOptions(null);
  if(backends.unsupported(mode)){metrics.fallbackReason=backends.unsupported(mode);mode='jpeg';$('renderer').value=mode;}
  $('renderer').onchange=()=>{release();mode=$('renderer').value;try{localStorage.setItem('showcase.renderer.v1',mode);}catch(_){}
    metrics.fallbackReason=null;desired=true;failures=[];retry=0;metrics.lastReason='切换显示方式';connect();};
  $('reconnect').onclick=()=>{metrics.reconnects++;metrics.lastReason='手动重连';desired=true;retry=0;failures=[];connect();};
  $('disconnect').onclick=()=>{desired=false;closeSockets();state('已断开，点重连恢复');notice('已断开');};
  $('fit').onclick=()=>{release();fill=!fill;document.body.classList.toggle('contain',!fill);$('fit').textContent=fill?'显示：铺满（裁切）':'显示：完整';};
  $('output-resolution').onchange=()=>{release();outputMode=$('output-resolution').value;selectingOutput=true;clearTimeout(outputTimer);outputTimer=null;lastOutputSent=-Infinity;queueOutput();};
  $('menu').onclick=()=>{$('toolbar').hidden=!$('toolbar').hidden;};
  let rateAt=performance.now(),rateReceived=0,rateBytes=0,rateDrawn=0,rates={receivedFps:0,presentedFps:null,bitrateMbps:0};
  function diagnosticSnapshot() {
    return {app:'Showcase+',version:server?.version || '等待接收机',build:server?.build || '',entry:location.origin,
      renderer:mode,rendererLabel:backends.labels[mode],fallbackReason:metrics.fallbackReason,lastFailure:metrics.lastFailure,
      resolution:config?`${config.width} × ${config.height}`:'等待视频',outputMode,viewport,outputTarget:outputTarget(),displayFit:fill?'cover':'contain',...rates,...renderer?.stats(),
      receivedFrames:metrics.received,recoveryCount:metrics.recoveries,reconnectCount:metrics.reconnects,lastReason:metrics.lastReason,
      documentVisibility:document.visibilityState || (document.hidden?'hidden':'visible'),posterVisible:!poster.hidden,displayed,
      controlBufferedBytes:control?.bufferedAmount ?? 0,inputOwner:server?.inputOwner ?? 'none',sourceFrameAgeMs:server?.frameAgeMs ?? null,
      capabilities:{secureContext:!!window.isSecureContext,webcodecs:!!window.VideoDecoder,webassembly:!!window.WebAssembly,worker:!!window.Worker,webrtc:!!window.RTCPeerConnection},
      receiver:server};
  }
  function renderDiagnostics(){if(!$('diagnostic-panel').hidden)$('diagnostic-data').textContent=JSON.stringify(diagnosticSnapshot(),null,2);}
  setInterval(()=>{
    const now=performance.now(),seconds=(now-rateAt)/1000;if(seconds<=0)return;
    rates={receivedFps:mode==='mjpeg'||mode==='webrtc'?null:+((metrics.received-rateReceived)/seconds).toFixed(1),
      presentedFps:mode==='mjpeg'?null:+((metrics.drawn-rateDrawn)/seconds).toFixed(1),bitrateMbps:mode==='mjpeg'||mode==='webrtc'?null:+((metrics.bytes-rateBytes)*8/seconds/1e6).toFixed(2)};
    rateAt=now;rateReceived=metrics.received;rateDrawn=metrics.drawn;rateBytes=metrics.bytes;renderDiagnostics();
  },1000);
  $('diagnostics').onclick=()=>{$('diagnostic-panel').hidden=!$('diagnostic-panel').hidden;renderDiagnostics();};
  $('diagnostic-close').onclick=()=>{$('diagnostic-panel').hidden=true;};
  $('diagnostic-copy').onclick=async()=>{
    const text=JSON.stringify(diagnosticSnapshot(),null,2);
    try { if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
      else {const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;left:-9999px';document.body.appendChild(field);field.select();try{if(!document.execCommand('copy'))throw Error('copy unavailable');}finally{field.remove();}}
      $('diagnostic-copy').textContent='已复制';
    }catch(_){$('diagnostic-copy').textContent='复制失败，可手动复制下方文字';}
  };
  $('fullscreen').onclick=()=>{const action=document.fullscreenElement?document.exitFullscreen?.():document.documentElement.requestFullscreen?.();action?.catch(()=>state('请使用车机浏览器菜单调整窗口'));};
  window.showcaseDiagnostics=diagnosticSnapshot;
  measureViewport();
  connect();
})();
