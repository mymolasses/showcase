/* SPDX-License-Identifier: GPL-3.0-or-later. Single Worker/WebCodecs/WebGL renderer. */
(() => {
  'use strict';
  const label = 'WebCodecs · Worker · WebGL2';
  function unsupported() {
    if (!window.isSecureContext) return '需要浏览器信任的 HTTPS 地址；普通 HTTP 无法启用 WebCodecs';
    if (!window.Worker) return '浏览器不支持 Worker';
    if (!window.OffscreenCanvas || !HTMLCanvasElement.prototype.transferControlToOffscreen)
      return '浏览器不支持 OffscreenCanvas；请更新车机浏览器';
    return null;
  }
  function create(options) {
    const reason = unsupported(); if (reason) throw Error(reason);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1; options.container.replaceChildren(canvas);
    let worker = null, closed = false, closeTimer = null, lastDrawAt = null, lastInputAt = null, session = 0;
    const terminate=()=>{clearTimeout(closeTimer);worker?.terminate();worker=null;};
    let counters = {inputFrames:0,drawnFrames:0,bytes:0,droppedFrames:0,waitingKey:true,decodeQueue:0};
    try {
      const offscreen = canvas.transferControlToOffscreen();
      worker = new Worker('/video-worker.js');
      worker.onmessage = ({data}) => {
        if (data.type === 'closed') { terminate();return; }
        if (closed || data.session!==session) return;
        if (data.type === 'error') { options.onError(data.message, data.fatal); return; }
        if (data.type === 'open') options.onOpen();
        if (data.type === 'config') options.onConfig(data.config);
        if (data.type === 'reset') options.onReset();
        if (data.type === 'keyframe') options.requestKey();
        if (data.type === 'stats') {
          const now = performance.now(), prior = counters;
          counters = data.stats;
          lastDrawAt = counters.lastDrawAgeMs === null ? null : now - counters.lastDrawAgeMs;
          lastInputAt = counters.lastInputAgeMs === null ? null : now - counters.lastInputAgeMs;
          options.onProgress({received:counters.inputFrames-prior.inputFrames,
            drawn:counters.drawnFrames-prior.drawnFrames,bytes:counters.bytes-prior.bytes});
          if (counters.drawnFrames > prior.drawnFrames) options.onFrame();
        }
      };
      worker.onerror = event => { if (!closed) { event.preventDefault(); options.onError('视频 Worker 启动失败：'+event.message,true); } };
      worker.onmessageerror = () => { if (!closed) options.onError('视频 Worker 消息损坏',true); };
      worker.postMessage({type:'init',canvas:offscreen,url:options.url,session:++session},[offscreen]);
    } catch(error) { worker?.terminate(); throw error; }
    return {
      connect(next) {
        options=next;lastDrawAt=lastInputAt=null;
        counters={inputFrames:0,drawnFrames:0,bytes:0,droppedFrames:0,waitingKey:true,decodeQueue:0};
        worker.postMessage({type:'init',url:options.url,session:++session});
      },
      disconnect() { if(!closed)worker.postMessage({type:'disconnect',session:++session}); },
      stats() { return {...counters,renderer:'webcodecs-worker',lastDrawAgeMs:lastDrawAt===null?null:performance.now()-lastDrawAt,
        lastInputAgeMs:lastInputAt===null?null:performance.now()-lastInputAt}; },
      snapshotSource: () => canvas,
      close() {
        if (closed) return; closed=true;
        if(!worker)return;
        worker.postMessage({type:'close'});
        closeTimer=setTimeout(terminate,1000);
      }
    };
  }
  window.ShowcaseRenderers = {label,unsupported,create};
})();
