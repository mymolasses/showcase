/* SPDX-License-Identifier: GPL-3.0-or-later.
 * Original implementation: receive compressed AVC, decode and draw entirely
 * in this Worker. No video element, image transcoding, or playback clock.
 */
'use strict';
importScripts('/protocol.js');
const {parsePacket} = ShowcaseProtocol;
let canvas, gl, program, texture, vertexBuffer, uvBuffer, socket, decoder, stream, decoderConfig;
let stopped = false, initialized = false, waitingKey = true, decoderEpoch = 0;
let session = 0;
const emit = message => self.postMessage({...message,session});
let keyAt = -Infinity, lastReport = -Infinity, lastDrawAt = null, lastInputAt = null, lastTimestamp = -1;
let inputFrames = 0, drawnFrames = 0, droppedFrames = 0, bytes = 0, recoveries = 0;
let statsTimer, pingTimer, connectionTimer;
// Wi-Fi/TLS can deliver a healthy burst faster than asynchronous codec work.
// Bound both outstanding work and its age instead of resetting every fifth
// packet before the decoder has had a chance to produce its first picture.
let pendingSince = null;
const MAX_DECODE_QUEUE = 24, MAX_QUEUE_AGE_MS = 250;
function report(force = false) {
  const now = performance.now();
  if (!force && now-lastReport<100) return;
  lastReport=now;
  emit({type:'stats',stats:{inputFrames,drawnFrames,bytes,droppedFrames,recoveries,waitingKey,
    decodeQueue:decoder?.decodeQueueSize || 0,lastDrawTimestamp:lastTimestamp,
    lastDrawAgeMs:lastDrawAt===null?null:now-lastDrawAt,lastInputAgeMs:lastInputAt===null?null:now-lastInputAt}});
}
function requestKey() {
  if (performance.now()-keyAt<1000) return;
  keyAt=performance.now(); emit({type:'keyframe'});
}
function closeDecoder() {
  ++decoderEpoch;
  if (decoder && decoder.state!=='closed') decoder.close();
  decoder=null; waitingKey=true;
  pendingSince=null;
}
function disconnect() {
  clearInterval(statsTimer);clearInterval(pingTimer);clearTimeout(connectionTimer);
  if (socket) { socket.onopen=socket.onclose=socket.onerror=socket.onmessage=null; socket.close(); socket=null; }
  closeDecoder();stream=null;decoderConfig=null;
}
function stop() {
  if (stopped) return; stopped=true;disconnect();
  if (gl) {
    gl.deleteTexture(texture);gl.deleteBuffer(vertexBuffer);gl.deleteBuffer(uvBuffer);gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  emit({type:'closed'});self.close?.();
}
function fail(message,fatal=false) {
  if (stopped) return;
  emit({type:'error',message,fatal});disconnect();
}
function shader(type,source) {
  const item=gl.createShader(type);gl.shaderSource(item,source);gl.compileShader(item);
  if (!gl.getShaderParameter(item,gl.COMPILE_STATUS)) { const error=gl.getShaderInfoLog(item);gl.deleteShader(item);throw Error('WebGL 着色器编译失败：'+error); }
  return item;
}
function initGL() {
  // Preserve the last picture for static maps and reconnect snapshots.
  gl=canvas.getContext('webgl2',{desynchronized:true,antialias:false,depth:false,stencil:false,
    alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:true});
  if (!gl) throw Error('浏览器无法创建 WebGL2 图形上下文');
  const vertex=shader(gl.VERTEX_SHADER,`#version 300 es
    in vec2 position; in vec2 uv; out vec2 texcoord;
    void main(){gl_Position=vec4(position,0.0,1.0);texcoord=uv;}`);
  const fragment=shader(gl.FRAGMENT_SHADER,`#version 300 es
    precision mediump float; in vec2 texcoord; uniform sampler2D picture; out vec4 color;
    void main(){color=texture(picture,texcoord);}`);
  program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error('WebGL 程序链接失败');
  gl.useProgram(program);
  function buffer(name,values) {
    const item=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,item);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);
    const attribute=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);return item;
  }
  vertexBuffer=buffer('position',[-1,-1,1,-1,-1,1,1,1]);
  uvBuffer=buffer('uv',[0,1,1,1,0,0,1,0]);
  texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.uniform1i(gl.getUniformLocation(program,'picture'),0);
  for (const option of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,option,gl.LINEAR);
  for (const option of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,option,gl.CLAMP_TO_EDGE);
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();fail('WebGL 上下文丢失，请重连');});
}
function draw(frame,ticket) {
  try {
    if (stopped || ticket!==decoderEpoch) return;
    if (frame.timestamp<=lastTimestamp) { droppedFrames++;return; }
    if (canvas.width!==frame.displayWidth || canvas.height!==frame.displayHeight) {
      canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;gl.viewport(0,0,canvas.width,canvas.height);
    }
    if (gl.isContextLost()) throw Error('WebGL 图形上下文已丢失');
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    // Do not call getError/readPixels here: synchronous GPU readback can
    // serialize every frame. Context loss is handled by its own event.
    lastTimestamp=frame.timestamp;lastDrawAt=performance.now();drawnFrames++;report(drawnFrames===1);
  } catch(error) { fail(error.message); }
  finally { frame.close(); }
}
function newDecoder() {
  closeDecoder();const ticket=decoderEpoch;
  decoder=new VideoDecoder({output:frame=>draw(frame,ticket),error:error=>{
    if(ticket===decoderEpoch)fail('WebCodecs 解码失败：'+error.message);
  }});
  decoder.ondequeue=()=>{if(ticket===decoderEpoch && decoder.decodeQueueSize===0)pendingSince=null;};
  decoder.configure(decoderConfig);waitingKey=true;requestKey();
}
async function configure(next) {
  if (stream && stream.generation===next.generation && stream.width===next.width && stream.height===next.height &&
      stream.avcc.length===next.avcc.length && stream.avcc.every((n,i)=>n===next.avcc[i])) return;
  closeDecoder();stream=next;lastTimestamp=-1;lastDrawAt=null;
  // The native bridge uses AVCC framing. Feed it directly instead of
  // allocating a second Annex-B copy for every frame.
  decoderConfig={codec:'avc1.'+[...next.avcc.slice(1,4)].map(n=>n.toString(16).padStart(2,'0')).join(''),
    codedWidth:next.width,codedHeight:next.height,description:next.avcc,optimizeForLatency:true};
  const current=stream;
  const support=await VideoDecoder.isConfigSupported(decoderConfig);
  if (stopped || current!==stream) return;
  if (!support.supported) { fail('浏览器不支持当前 H.264 配置：'+decoderConfig.codec,true);return; }
  newDecoder();emit({type:'config',config:{width:next.width,height:next.height,generation:next.generation}});report(true);
}
function feed(packet) {
  if (!decoder || packet.generation!==stream?.generation) return;
  inputFrames++;bytes+=packet.bytes.byteLength;lastInputAt=performance.now();
  const queued=decoder.decodeQueueSize;
  if(queued===0)pendingSince=null;
  // Accepted codec work may retain reference/reorder surfaces. It is not
  // pending decode work; resetting based on those surfaces can starve the
  // decoder before it ever outputs its next picture.
  if (queued>=MAX_DECODE_QUEUE || (queued>=4 && pendingSince!==null && performance.now()-pendingSince>MAX_QUEUE_AGE_MS)) {
    // Dropping a delta breaks the reference chain. Reset and wait for IDR.
    droppedFrames+=queued;recoveries++;newDecoder();
  }
  if (waitingKey && !packet.key) { droppedFrames++;requestKey();report();return; }
  if(pendingSince===null)pendingSince=performance.now();
  decoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp:packet.micros,data:packet.bytes}));
  waitingKey=false;report();
}
async function init(message) {
  if (stopped) return;
  disconnect();session=message.session || 0;
  if (!self.isSecureContext) { fail('视频解码需要可信 HTTPS',true);return; }
  if (!self.VideoDecoder) { fail('浏览器 Worker 未提供 WebCodecs VideoDecoder',true);return; }
  const url=new URL(message.url);
  const local=['localhost','127.0.0.1','[::1]'].includes(self.location.hostname);
  if (url.host!==self.location.host || url.pathname!=='/media' || (url.protocol!=='wss:' && !(local && url.protocol==='ws:')))
    throw Error('视频必须使用同源 WSS 连接');
  if (!initialized) { canvas=message.canvas;initGL();initialized=true; }
  else if(gl.isContextLost())throw Error('WebGL 上下文已丢失，请刷新页面');
  inputFrames=drawnFrames=droppedFrames=bytes=recoveries=0;
  lastDrawAt=lastInputAt=null;lastTimestamp=-1;keyAt=lastReport=-Infinity;
  const ticket=session;
  socket=new WebSocket(url.href);socket.binaryType='arraybuffer';
  connectionTimer=setTimeout(()=>fail('视频连接超时'),8000);
  socket.onopen=()=>{if(ticket!==session)return;clearTimeout(connectionTimer);emit({type:'open'});};
  socket.onmessage=({data})=>{
    if (stopped || ticket!==session || !(data instanceof ArrayBuffer)) return;
    try {
      const packet=parsePacket(data);
      if(packet.type==='config')configure(packet.config).catch(error=>{if(ticket===session)fail(error.message);});
      else if(packet.type==='reset') { closeDecoder();stream=null;lastDrawAt=null;lastTimestamp=-1;emit({type:'reset'});report(true); }
      else feed(packet);
    } catch(error) { fail(error.message); }
  };
  socket.onclose=event=>{if(ticket===session)fail('视频连接中断 ('+event.code+')');};
  socket.onerror=()=>{if(ticket===session)fail('WSS 视频连接失败，请检查 HTTPS 证书及网络');};
  statsTimer=setInterval(()=>{if(waitingKey&&stream)requestKey();report(true);},500);
  pingTimer=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send('{"type":"ping"}');},2000);
}
self.onmessage=({data})=>{
  if (data.type==='init') init(data).catch(error=>fail(error.message,true));
  else if(data.type==='disconnect') { disconnect();session=data.session; }
  else if(data.type==='close')stop();
};
