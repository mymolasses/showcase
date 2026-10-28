/* Exercise the production Worker under deterministic codec and GPU delivery. */
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const protocol=require('../web/protocol.js');
function fixture({secure=true,codec=true,graphics=true}={}){
  let time=0,closedFrames=0,draws=0,contexts=0;const messages=[],decoders=[],sockets=[],intervals=[];
  const gl=new Proxy({NO_ERROR:0,COMPILE_STATUS:1,LINK_STATUS:2,getShaderParameter:()=>true,getProgramParameter:()=>true,
    createShader:()=>({}),createProgram:()=>({}),createBuffer:()=>({}),createTexture:()=>({}),getAttribLocation:()=>0,
    getUniformLocation:()=>({}),getError:()=>0,isContextLost:()=>false,drawArrays(){draws++;}},
    {get:(o,k)=>k in o?o[k]:/^[A-Z_]+$/.test(k)?1:()=>{}});
  class Decoder{
    static async isConfigSupported(){return{supported:true};}
    constructor(options){this.options=options;this.state='unconfigured';this.decodeQueueSize=0;this.inputs=[];decoders.push(this);}
    configure(config){this.config=config;this.state='configured';}
    decode(chunk){this.inputs.push(chunk);this.decodeQueueSize++;}
    close(){this.state='closed';}
  }
  class Socket{
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=1;sockets.push(this);}
    close(){this.readyState=3;}
    send(){}
  }
  const self={isSecureContext:secure,VideoDecoder:codec?Decoder:undefined,location:{host:'localhost:8080',hostname:'localhost'},postMessage:m=>messages.push(m)};
  const context={self,ShowcaseProtocol:protocol,importScripts(){},VideoDecoder:Decoder,WebSocket:Socket,URL,Uint8Array,ArrayBuffer,
    performance:{now:()=>time},EncodedVideoChunk:class{constructor(x){Object.assign(this,x);}},
    setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return 1;},clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/video-worker.js'),'utf8'),context);
  const canvas={width:1,height:1,addEventListener(){},getContext:()=>{contexts++;return graphics?gl:null;}};
  const config=(gen=7)=>{const b=Buffer.alloc(9);b[0]=1;b.writeUInt32BE(gen,1);b.writeUInt16BE(640,5);b.writeUInt16BE(360,7);return Buffer.concat([b,Buffer.from('0142001effe100046742001e01000268ce','hex')]);};
  const frame=(key,ts,gen=7)=>{const h=Buffer.alloc(14);h[0]=2;h.writeUInt32BE(gen,1);h[5]=+key;h.writeBigUInt64BE(BigInt(ts),6);return Buffer.concat([h,Buffer.from(key?'0000000265b8':'0000000241b8','hex')]);};
  const message=b=>sockets.at(-1).onmessage({data:b.buffer.slice(b.byteOffset,b.byteOffset+b.length)});
  return{messages,decoders,sockets,config,frame,message,
    async init(){self.onmessage({data:{type:'init',canvas,url:'ws://localhost:8080/media'}});await new Promise(setImmediate);sockets.at(-1)?.onopen();},
    async reconnect(){self.onmessage({data:{type:'disconnect',session:1}});self.onmessage({data:{type:'init',url:'ws://localhost:8080/media',session:2}});await new Promise(setImmediate);sockets.at(-1)?.onopen();},
    async configure(gen=7){message(config(gen));await new Promise(setImmediate);},
    output(decoder,timestamp){decoder.options.output({timestamp,displayWidth:640,displayHeight:360,close(){closedFrames++;}});},
    poll(){time+=1000;for(const fn of intervals)fn();},
    close(){self.onmessage({data:{type:'close'}});},stats:()=>({draws,closedFrames,contexts})};
}
(async()=>{
  const f=fixture();await f.init();await f.configure();const first=f.decoders.at(-1);
  f.message(f.frame(false,1));assert.equal(first.inputs.length,0,'wait for IDR before decoding');
  f.message(f.frame(true,2));f.message(f.frame(false,3));f.message(f.frame(false,4));f.message(f.frame(false,5));
  f.poll();f.message(f.frame(false,6));const fresh=f.decoders.at(-1);
  assert.notEqual(first,fresh);assert.equal(first.state,'closed');assert.equal(fresh.inputs.length,0,'overflow must discard the broken delta chain');
  f.message(f.frame(true,7));assert.equal(fresh.inputs.length,1);
  f.output(first,2);assert.equal(f.stats().draws,0,'late output from a closed decoder must be ignored');
  f.output(fresh,7);assert.equal(f.stats().draws,1);f.output(fresh,7);assert.equal(f.stats().draws,1,'duplicate frames do not claim progress');
  f.poll();assert.equal(f.stats().draws,1,'heartbeat/stat ticks do not create frames');
  const count=f.decoders.length;await f.configure();assert.equal(f.decoders.length,count,'identical config preserves the decoder');
  await f.configure(8);f.output(fresh,99);assert.equal(f.stats().draws,1,'stream changes invalidate old callbacks');
  const last=f.decoders.at(-1);f.close();f.output(last,100);assert.equal(f.stats().draws,1);assert.equal(f.stats().closedFrames,5);
  for(const option of [{secure:false},{codec:false},{graphics:false}]){
    const bad=fixture(option);await bad.init();assert(bad.messages.some(m=>m.type==='error'&&m.fatal),'missing capability must produce a fatal diagnostic');
    assert.equal(bad.sockets.length,0,'capability failure must not open a media connection');
  }
  const accepted=fixture();await accepted.init();await accepted.configure();const codec=accepted.decoders.at(-1);
  for(let n=0;n<100;n++){
    codec.decodeQueueSize=0;accepted.message(accepted.frame(n===0,n+1));accepted.poll();
  }
  assert.equal(accepted.decoders.length,1,'accepted codec/reference surfaces are not a pending decode queue');
  assert.equal(codec.inputs.length,100,'do not starve a codec which accepts work before delayed output');accepted.close();
  const reused=fixture();await reused.init();await reused.configure();const old=reused.decoders.at(-1),oldSocket=reused.sockets.at(-1);
  reused.message(reused.frame(true,1));reused.output(old,1);
  await reused.reconnect();assert.equal(oldSocket.readyState,3);assert.equal(old.state,'closed');assert.equal(reused.stats().contexts,1,'transport reconnect must retain its Worker GPU context');
  await reused.configure();reused.output(old,2);assert.equal(reused.stats().draws,1,'late frames from a previous connection must be closed');
  reused.message(reused.frame(true,1));reused.output(reused.decoders.at(-1),1);
  assert.equal(reused.messages.at(-1).session,2);assert.equal(reused.messages.at(-1).stats.drawnFrames,1,'new connection resets counters and timestamps');reused.close();
  console.log('PASS: IDR recovery after decoder overflow, stale callbacks, duplicate frames, cleanup and capability failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
