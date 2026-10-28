/* SPDX-License-Identifier: GPL-3.0-or-later. No external scripts/services. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), surface=$('surface'), poster=$('poster'), display=$('display');
  const {mapPoint,displaySize}=ShowcaseProtocol, backends=ShowcaseRenderers;
  let desired=true, active=false, displayed=false, fill=false, config=null, renderer=null, control=null;
  let outputMode='auto',outputInitialized=false,selectingOutput=false,outputTimer=null,lastOutputSent=-Infinity,viewport={};
  let epoch=0, retry=0, reconnectTimer=null, socketTimer=null, startupTimer=null, statusBusy=false, pointer=null;
  let pendingMove=null, moveFrame=null, lastKeyRequest=-Infinity, failures=[], server=null;
  const metrics={received:0,bytes:0,drawn:0,reconnects:0,recoveries:0,lastReason:'首次连接',lastDrawAt:null,lastFailure:null};
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
    if(outputMode==='phone') {
      // Island/phone scaling remains local. Rematch phone geometry only on
      // an explicit output selection, not on every safe-area layout change.
      if(!selectingOutput && server?.displayRequest?.mode==='phone' && server.displayRequest.width)
        return {width:server.displayRequest.width,height:server.displayRequest.height};
      return server?.phoneDisplay?.width ? server.phoneDisplay : null;
    }
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
    if(selectingOutput && outputMatches())selectingOutput=false;
    selector.value=outputMode;
    const target=outputTarget(), prefix=outputMode==='auto'?'车机浏览器':outputMode==='phone'?'手机屏幕':'固定输出';
    const actual=status.width && status.height ? `${status.width} × ${status.height}`:'等待视频';
    $('display-hint').textContent=status.displayError || `${prefix}：${target?`${target.width} × ${target.height}`:'等待尺寸'}；当前源 ${actual}。完整显示，不裁切。切换输出需重连 CarPlay。`;
    if(outputMode==='auto' || selectingOutput)queueOutput();
  }
  function send(object) {
    if(control?.readyState!==WebSocket.OPEN)return false;
    if(control.bufferedAmount>4096) { release(false);scheduleReconnect('控制通道积压');return false; }
    try { control.send(JSON.stringify(object));return true; }
    catch(_) { release(false);scheduleReconnect('控制通道发送失败');return false; }
  }
  function requestKey() {
    if(performance.now()-lastKeyRequest>=1000 && send({type:'keyframe'}))lastKeyRequest=performance.now();
  }
  function release(notify=true) {
    if(moveFrame!==null)cancelAnimationFrame(moveFrame);moveFrame=pendingMove=null;
    const old=pointer;pointer=null;
    if(old!==null) { if(surface.hasPointerCapture(old))surface.releasePointerCapture(old);if(notify)send({type:'release'}); }
  }
  function snapshot() {
    const source=renderer?.snapshotSource();
    if(!source?.width || !source?.height || !displayed)return;
    try { poster.width=source.width;poster.height=source.height;poster.getContext('2d').drawImage(source,0,0);poster.hidden=false; } catch(_) {}
  }
  function resetRenderer() {
    release();snapshot();renderer?.close();renderer=null;display.replaceChildren();displayed=false;
    clearTimeout(startupTimer);startupTimer=null;metrics.lastDrawAt=null;
  }
  function closeSockets() {
    clearTimeout(socketTimer);clearTimeout(reconnectTimer);clearTimeout(outputTimer);
    socketTimer=reconnectTimer=outputTimer=null;release();++epoch;
    if(control){control.onclose=control.onmessage=control.onopen=null;control.close();}
    control=null;resetRenderer();config=null;active=false;
  }
  function scheduleReconnect(reason) {
    metrics.reconnects++;metrics.lastReason=reason;closeSockets();if(!desired || document.hidden)return;
    const seconds=Math.min(10,2**Math.min(retry++,4));state(`${reason} · ${seconds} 秒后重试`);
    notice('正在恢复连接，请保持 Showcase 在前台');reconnectTimer=setTimeout(connect,seconds*1000);
  }
  function recover(reason,fatal=false) {
    if(!desired)return;metrics.recoveries++;metrics.lastReason=reason;
    metrics.lastFailure={reason,renderer:renderer?.stats() ?? null,receiver:server};
    const now=performance.now();failures=failures.filter(t=>now-t<30000);failures.push(now);
    if(fatal || failures.length>=4) {
      desired=false;closeSockets();notice(reason+'；请检查 HTTPS、浏览器能力或复制诊断后重连');state(reason);return;
    }
    scheduleReconnect(reason);
  }
  async function readStatus() {
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),4000);
    try { const response=await fetch('/status',{cache:'no-store',signal:abort.signal});
      if(!response.ok)throw Error('接收机暂时不可达');const status=await response.json();server=status;return status;
    } finally { clearTimeout(timer); }
  }
  async function connect() {
    closeSockets();if(!desired || document.hidden)return;const current=++epoch;
    const missing=backends.unsupported();if(missing){recover(missing,true);return;}
    state('正在连接 · '+backends.label);notice('等待 CarPlay 画面…');
    try { const status=await readStatus();if(current!==epoch)return;
      if(status.viewers || status.controllers){scheduleReconnect('其他页面仍占用连接，请关闭');return;}
      active=status.active && status.configured;
    } catch(error) { if(current===epoch)scheduleReconnect(error.message);return; }
    const endpoint=(location.protocol==='https:'?'wss://':'ws://')+location.host;
    let mediaReady=false;
    const opened=()=>{if(current===epoch && mediaReady && control?.readyState===WebSocket.OPEN){clearTimeout(socketTimer);socketTimer=null;}};
    control=new WebSocket(endpoint+'/control');
    control.onopen=()=>{if(current!==epoch)return;opened();lastKeyRequest=-Infinity;requestKey();updateOutput(server);};
    control.onclose=event=>{if(current===epoch)scheduleReconnect(`控制连接中断 (${event.code})`);};
    control.onerror=()=>{};
    try {
      renderer=backends.create({container:display,url:endpoint+'/media',requestKey,
        onOpen(){if(current!==epoch)return;mediaReady=true;opened();},
        onConfig(next){
          if(current!==epoch)return;release();config=next;active=true;displayed=false;clearTimeout(startupTimer);
          startupTimer=setTimeout(()=>{if(current===epoch && !displayed)recover('等待第一帧超时');},15000);
        },
        onReset(){if(current!==epoch)return;release();snapshot();config=null;active=false;displayed=false;
          clearTimeout(startupTimer);startupTimer=null;notice('等待新的 CarPlay 会话…');},
        onProgress(delta){if(current!==epoch)return;metrics.received+=Math.max(0,delta.received);metrics.bytes+=Math.max(0,delta.bytes);metrics.drawn+=Math.max(0,delta.drawn);},
        onFrame(){
          if(current!==epoch || !config)return;
          displayed=true;poster.hidden=true;retry=0;metrics.lastDrawAt=performance.now();notice('');
          clearTimeout(startupTimer);startupTimer=null;state(`CarPlay · ${config.width} × ${config.height} · ${backends.label}`);
        },
        onError(reason,fatal){if(current===epoch)setTimeout(()=>{if(current===epoch)recover(reason,fatal);},0);}
      });
    } catch(error) { recover(error.message,true);return; }
    socketTimer=setTimeout(()=>{if(current===epoch)scheduleReconnect('视频或控制连接超时');},10000);
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
  setInterval(()=>{send({type:'ping'});if(config && renderer?.stats().waitingKey)requestKey();},2000);
  setInterval(async()=>{
    if(!desired || document.hidden || statusBusy || control?.readyState!==WebSocket.OPEN)return;
    statusBusy=true;const current=epoch;
    try { const status=await readStatus();if(current!==epoch)return;active=status.active && status.configured;
      if(!active){release();notice('保持 Showcase 在前台，并连接发送 iPhone');}
      updateOutput(status);
      const stats=renderer?.stats();
      if(stats?.inputFrames>=3 && stats.lastInputAgeMs<1500 && stats.lastDrawAgeMs>3000)recover('持续收帧但画面未推进');
    } catch(error) { if(current===epoch){active=false;release();state(error.message);} }
    finally { statusBusy=false; }
  },1500);
  $('reconnect').onclick=()=>{metrics.reconnects++;metrics.lastReason='手动重连';desired=true;retry=0;failures=[];connect();};
  $('disconnect').onclick=()=>{desired=false;closeSockets();state('已断开，点重连恢复');notice('已断开');};
  $('fit').onclick=()=>{release();fill=!fill;document.body.classList.toggle('contain',!fill);$('fit').textContent=fill?'显示：铺满（裁切）':'显示：完整';};
  $('output-resolution').onchange=()=>{release();outputMode=$('output-resolution').value;selectingOutput=true;clearTimeout(outputTimer);outputTimer=null;lastOutputSent=-Infinity;queueOutput();};
  $('menu').onclick=()=>{$('toolbar').hidden=!$('toolbar').hidden;};
  let rateAt=performance.now(),rateReceived=0,rateBytes=0,rateDrawn=0,rates={receivedFps:0,presentedFps:null,bitrateMbps:0};
  function diagnosticSnapshot() {
    return {app:'Showcase+',version:server?.version || '等待接收机',build:server?.build || '',entry:location.origin,
      renderer:'webcodecs-worker',rendererLabel:backends.label,lastFailure:metrics.lastFailure,
      resolution:config?`${config.width} × ${config.height}`:'等待视频',outputMode,viewport,outputTarget:outputTarget(),displayFit:fill?'cover':'contain',...rates,...renderer?.stats(),
      receivedFrames:metrics.received,recoveryCount:metrics.recoveries,reconnectCount:metrics.reconnects,lastReason:metrics.lastReason,
      documentVisibility:document.visibilityState || (document.hidden?'hidden':'visible'),posterVisible:!poster.hidden,displayed,
      controlBufferedBytes:control?.bufferedAmount ?? 0,inputOwner:server?.inputOwner ?? 'none',sourceFrameAgeMs:server?.frameAgeMs ?? null,
      capabilities:{secureContext:!!window.isSecureContext,worker:!!window.Worker,offscreenCanvas:!!window.OffscreenCanvas},
      receiver:server};
  }
  function renderDiagnostics(){if(!$('diagnostic-panel').hidden)$('diagnostic-data').textContent=JSON.stringify(diagnosticSnapshot(),null,2);}
  setInterval(()=>{
    const now=performance.now(),seconds=(now-rateAt)/1000;if(seconds<=0)return;
    rates={receivedFps:+((metrics.received-rateReceived)/seconds).toFixed(1),
      presentedFps:+((metrics.drawn-rateDrawn)/seconds).toFixed(1),bitrateMbps:+((metrics.bytes-rateBytes)*8/seconds/1e6).toFixed(2)};
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
