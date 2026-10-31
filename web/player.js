/* SPDX-License-Identifier: GPL-3.0-or-later. No external scripts/services. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), surface=$('surface'), display=$('display');
  const {mapPoint,displaySize,customDisplaySize,autoDisplaySize,normalizeLandscapeRatio}=ShowcaseProtocol, backends=ShowcaseRenderers;
  let desired=true, active=false, displayed=false, fill=false, config=null, renderer=null, control=null;
  let retainedFrame=false;
  let outputMode='auto',outputInitialized=false,selectingOutput=false,outputTimer=null,lastOutputSent=-Infinity,viewport={};
  let customSize=null,landscapeRatio=1.45,editingOutput=false;
  const automaticOutput=()=>outputMode==='auto' || outputMode==='auto-landscape';
  let epoch=0, retry=0, reconnectTimer=null, socketTimer=null, startupTimer=null, statusBusy=false, pointer=null;
  let pendingMove=null, moveFrame=null, lastKeyRequest=-Infinity, failures=[], server=null;
  const metrics={received:0,bytes:0,drawn:0,reconnects:0,recoveries:0,lastReason:'首次连接',lastDrawAt:null,lastFailure:null};
  const state=message=>{if($('state').textContent!==message)$('state').textContent=message;};
  const notice=message=>{if($('notice').textContent!==message)$('notice').textContent=message;$('notice').hidden=!message;};
  function measureViewport() {
    const rect=surface.getBoundingClientRect(), visual=window.visualViewport;
    const width=Math.min(window.innerWidth || rect.width,visual?.width || Infinity);
    const height=Math.min(window.innerHeight || rect.height,visual?.height || Infinity);
    if(visual?.scale && Math.abs(visual.scale-1)>.02)return; // Pinch zoom is not a new display.
    if(surface.style){surface.style.width=width+'px';surface.style.height=height+'px';}
    const devicePixelRatio=window.devicePixelRatio || 1,density=Math.min(2,Math.max(1,devicePixelRatio));
    viewport={cssWidth:Math.round(width),cssHeight:Math.round(height),density,width:Math.round(width*density),height:Math.round(height*density),
      devicePixelRatio,physicalWidth:Math.round(width*devicePixelRatio),physicalHeight:Math.round(height*devicePixelRatio),
      screenWidth:window.screen?.width ?? null,screenHeight:window.screen?.height ?? null};
  }
  function outputTarget() {
    if(automaticOutput())return autoDisplaySize(viewport.width,viewport.height,outputMode==='auto-landscape'?landscapeRatio:0);
    if(outputMode==='custom')return customSize;
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
    const tolerance=automaticOutput() ? .01 : 0;
    return target && saved?.mode===outputMode && (outputMode!=='auto-landscape' || Math.abs((saved.landscapeRatio || 1.45)-landscapeRatio)<.0001) && Math.abs(saved.width-target.width)<=(tolerance?Math.max(2,target.width*tolerance):0) && Math.abs(saved.height-target.height)<=(tolerance?Math.max(2,target.height*tolerance):0);
  }
  function queueOutput() {
    if(editingOutput || outputTimer!==null || !server?.displayControl || outputMatches())return;
    outputTimer=setTimeout(()=>{
      outputTimer=null;
      if(editingOutput || !desired || document.hidden || !active || !outputTarget() || outputMatches() || performance.now()-lastOutputSent<8000)return;
      if(send({type:'display',mode:outputMode,...(automaticOutput()?{width:viewport.width,height:viewport.height}:outputMode==='custom'?customSize:{}),
        ...(outputMode==='auto-landscape'?{landscapeRatio}:{})})) {
        lastOutputSent=performance.now();$('display-hint').textContent='正在应用输出比例，CarPlay 将重新连接，请保持手机 App 在前台…';
      }
    },2000);
  }
  function updateOutput(status) {
    const selector=$('output-resolution');selector.disabled=!status?.displayControl;
    if(!status?.displayControl){$('display-hint').textContent='接收机尚未提供输出比例控制';return;}
    const saved=status.displayRequest || {mode:'auto'};
    if(!outputInitialized || !selectingOutput){
      outputMode=saved.mode || 'auto';outputInitialized=true;
      if(outputMode==='custom')customSize=customDisplaySize(saved.width,saved.height);
      landscapeRatio=normalizeLandscapeRatio(saved.landscapeRatio) || 1.45;
    }
    if(selectingOutput && outputMatches())selectingOutput=false;
    selector.value=outputMode;
    $('custom-output').hidden=outputMode!=='custom';$('landscape-output').hidden=outputMode!=='auto-landscape';
    if(!editingOutput){
      if(customSize){$('output-width').value=customSize.width;$('output-height').value=customSize.height;}
      $('landscape-ratio').value=landscapeRatio.toFixed(2);
    }
    const target=outputTarget(), prefix=outputMode==='auto-landscape'?'自动左右分列':outputMode==='auto'?'车机浏览器':outputMode==='phone'?'手机屏幕':'自选输出';
    const actual=status.width && status.height ? `${status.width} × ${status.height}`:'等待视频';
    const layoutHint=outputMode==='auto-landscape'?`宽高比 ${landscapeRatio.toFixed(2)}；1.30 是内部布局切换参考阈值，实际按 CarPlay 内部区域判断。`:
      outputMode==='custom' && target && target.width/target.height<1.45?'当前比例较高，CarPlay 可能改为上下排列。':'';
    $('display-hint').textContent=status.displayError || `${prefix}：${target?`${target.width} × ${target.height}`:'等待尺寸'}；当前源 ${actual}。浏览器 ${viewport.cssWidth} × ${viewport.cssHeight} CSS / ${viewport.physicalWidth} × ${viewport.physicalHeight} 像素。${layoutHint}完整显示，不裁切。切换需重连 CarPlay。`;
    if(automaticOutput() || selectingOutput)queueOutput();
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
  function resetRenderer() {
    release();retainedFrame ||= displayed;renderer?.disconnect();displayed=false;
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
      desired=false;closeSockets();renderer?.close();renderer=null;display.replaceChildren();retainedFrame=false;notice(reason+'；请检查 HTTPS、浏览器能力或复制诊断后重连');state(reason);return;
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
      const options={container:display,url:endpoint+'/media',requestKey,
        onOpen(){if(current!==epoch)return;mediaReady=true;opened();},
        onConfig(next){
          if(current!==epoch)return;release();config=next;active=true;displayed=false;clearTimeout(startupTimer);
          startupTimer=setTimeout(()=>{if(current===epoch && !displayed)recover('等待第一帧超时');},15000);
        },
        onReset(){if(current!==epoch)return;release();retainedFrame ||= displayed;config=null;active=false;displayed=false;
          clearTimeout(startupTimer);startupTimer=null;notice('等待新的 CarPlay 会话…');},
        onProgress(delta){if(current!==epoch)return;metrics.received+=Math.max(0,delta.received);metrics.bytes+=Math.max(0,delta.bytes);metrics.drawn+=Math.max(0,delta.drawn);},
        onFrame(){
          if(current!==epoch || !config)return;
          const first=!displayed;displayed=true;retainedFrame=false;retry=0;metrics.lastDrawAt=performance.now();
          if(first || !$('notice').hidden){notice('');clearTimeout(startupTimer);startupTimer=null;}
          state(`CarPlay · ${config.width} × ${config.height} · ${backends.label}`);
        },
        onError(reason,fatal){if(current===epoch)setTimeout(()=>{if(current===epoch)recover(reason,fatal);},0);}
      };
      if(renderer)renderer.connect(options);else renderer=backends.create(options);
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
  function resized(){release();measureViewport();clearTimeout(outputTimer);outputTimer=null;if(automaticOutput())queueOutput();}
  window.addEventListener('blur',()=>release());window.addEventListener('resize',resized);
  window.visualViewport?.addEventListener('resize',resized);
  document.addEventListener('fullscreenchange',resized);
  window.addEventListener('pagehide',()=>{closeSockets();renderer?.close();renderer=null;});window.addEventListener('pageshow',event=>{if(event.persisted && desired)connect();});
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
  function selectOutput(){release();selectingOutput=true;clearTimeout(outputTimer);outputTimer=null;lastOutputSent=-Infinity;$('display-error').textContent='';}
  $('output-resolution').onchange=()=>{
    selectOutput();outputMode=$('output-resolution').value;editingOutput=outputMode==='custom';
    if(editingOutput){customSize=customSize || customDisplaySize(config?.width || 1600,config?.height || 1000);if(customSize){$('output-width').value=customSize.width;$('output-height').value=customSize.height;}}
    if(server)updateOutput(server);queueOutput();
  };
  for(const id of ['output-width','output-height','landscape-ratio'])$(id).oninput=()=>{editingOutput=true;selectingOutput=true;clearTimeout(outputTimer);outputTimer=null;};
  $('custom-apply').onclick=()=>{
    const size=customDisplaySize(Number($('output-width').value),Number($('output-height').value));
    if(!size){$('display-error').textContent='宽高须为 240–4096 的偶数，总像素不超过 8294400，宽高比为 0.4–4。';return;}
    customSize=size;editingOutput=false;selectOutput();queueOutput();if(server)updateOutput(server);
  };
  $('landscape-apply').onclick=()=>{
    const value=normalizeLandscapeRatio(Number($('landscape-ratio').value));
    if(value===null){$('display-error').textContent='请输入大于 0 的比例，应用时保留两位小数，例如 1.30。';return;}
    if(!autoDisplaySize(viewport.width,viewport.height,value)){$('display-error').textContent='当前窗口无法生成有效尺寸，请调整比例；输出高度至少为 240 像素。';return;}
    landscapeRatio=value;editingOutput=false;selectOutput();queueOutput();if(server)updateOutput(server);
  };
  $('menu').onclick=()=>{$('toolbar').hidden=!$('toolbar').hidden;};
  let rateAt=performance.now(),rateReceived=0,rateBytes=0,rateDrawn=0,rates={receivedFps:0,presentedFps:null,bitrateMbps:0};
  function diagnosticSnapshot() {
    return {app:'Showcase+',version:server?.version || '等待接收机',build:server?.build || '',entry:location.origin,
      renderer:'webcodecs-worker',rendererLabel:backends.label,lastFailure:metrics.lastFailure,
      resolution:config?`${config.width} × ${config.height}`:'等待视频',outputMode,viewport,outputTarget:outputTarget(),landscapeRatio:outputMode==='auto-landscape'?landscapeRatio:null,displayFit:fill?'cover':'contain',...rates,...renderer?.stats(),
      receivedFrames:metrics.received,recoveryCount:metrics.recoveries,reconnectCount:metrics.reconnects,lastReason:metrics.lastReason,
      documentVisibility:document.visibilityState || (document.hidden?'hidden':'visible'),retainedFrame,displayed,
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
