/* Test production rendering with controlled decoder/compositor output. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const protocol=require('../web/protocol.js');
function fixture(quality=true) {
  let now=0,video,decoder,draws=0,lastCallback,ident=0,decodedImages=[],closedImages=0;
  const frames=new Map(),elements=[],intervals=[];
  class Peer { constructor(){this.connectionState='new';} close(){} }
  class Decoder {constructor(options){this.options=options;this.decodeQueueSize=0;this.state='configured';decoder=this;}configure(){}decode(){}close(){this.state='closed';}}
  const document={createElement(tag){
    const element={tag,width:640,height:360,getContext:()=>({drawImage(){draws++;},putImageData(){draws++;}})};
    if(tag==='video') {
      Object.assign(element,{muted:true,paused:false,readyState:4,videoWidth:640,videoHeight:360,style:{},play:()=>Promise.resolve(),pause(){},
        requestVideoFrameCallback(fn){lastCallback=fn;}});
      if(quality)element.getVideoPlaybackQuality=()=>({totalVideoFrames:element.total||0,droppedVideoFrames:element.dropped||0});video=element;
    }
    elements.push(element);return element;
  }};
  const window={VideoDecoder:Decoder,RTCPeerConnection:Peer,createImageBitmap:true,isSecureContext:true,Worker:true,WebAssembly};
  const context={window,document,ShowcaseProtocol:protocol,VideoDecoder:Decoder,RTCPeerConnection:Peer,Blob,ImageData:class{},
    performance:{now:()=>now},setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){},
    requestAnimationFrame(fn){frames.set(++ident,fn);return ident;},cancelAnimationFrame(id){frames.delete(id);},
    createImageBitmap:()=>new Promise(resolve=>decodedImages.push(resolve))};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/renderers.js'),'utf8'),context);
  let output=0;const errors=[];
  const create=mode=>window.ShowcaseRenderers.create(mode,{container:{replaceChildren(){},append(){}},
    config:{width:640,height:360,generation:1,avcc:Uint8Array.from(Buffer.from('0142001effe100046742001e01000268ce','hex'))},
    onFrame(){output++;},onError(message){errors.push(message);},requestKey(){},sendSignal(){}});
  return {create,errors,advance(t){now=t;},get video(){return video;},get decoder(){return decoder;},
    callback(mediaTime,number){lastCallback?.(now,{mediaTime,presentedFrames:number});},
    poll(){for(const fn of intervals)fn();},
    frame(timestamp){const frame={timestamp,displayWidth:640,displayHeight:360,close(){closedImages++;}};decoder.options.output(frame);return frame;},
    flush(){const callbacks=[...frames.values()];frames.clear();for(const fn of callbacks)fn();},
    image(){const resolve=decodedImages.shift();resolve({width:640,height:360,close(){closedImages++;}});},
    stats:()=>({output,draws,closedImages,pending:frames.size,images:decodedImages.length})};
}
(async()=>{
  // The Tesla regression: increasing callbacks/frame numbers, fixed frame
  // timestamp, advancing clock, but all new quality frames are dropped.
  const frozen=fixture(),rtc=frozen.create('webrtc');frozen.video.total=124;frozen.video.dropped=113;
  for(let n=0;n<900;n++){frozen.advance(n*20);frozen.video.total++;frozen.video.dropped++;frozen.video.currentTime=n/50;frozen.callback(0,358+n);}
  assert.equal(rtc.stats().drawnFrames,1);assert.equal(rtc.stats().frameCallbackCount,900);
  assert(rtc.stats().lastDrawAgeMs>17000,'callbacks must not reset the last actual draw');
  frozen.video.total++;frozen.callback(0,1300);assert.equal(rtc.stats().drawnFrames,2,'independent non-dropped progress remains usable');rtc.close();
  const offscreen=fixture(),polled=offscreen.create('webrtc');
  offscreen.video.total=1;offscreen.callback(0,1);
  for(let n=0;n<100;n++)offscreen.poll();
  assert.equal(polled.stats().drawnFrames,1,'poll ticks alone must not claim new pictures');
  offscreen.video.total=2;offscreen.poll();
  assert.equal(polled.stats().drawnFrames,2,'decoding may continue without offscreen frame callbacks');
  offscreen.video.total++;offscreen.video.dropped=1;offscreen.poll();
  assert.equal(polled.stats().drawnFrames,2,'polling must not count dropped pictures');
  offscreen.callback(.1,2);
  assert.equal(polled.stats().drawnFrames,3,'advancing frame media time remains usable if quality counters lag');
  polled.close();offscreen.video.total++;offscreen.poll();assert.equal(polled.stats().drawnFrames,3);
  const timestamps=fixture(false),legacy=timestamps.create('webrtc');
  timestamps.callback(0,1);timestamps.callback(0,2);timestamps.callback(0,3);timestamps.callback(.1,4);timestamps.callback(0,5);
  assert.equal(legacy.stats().drawnFrames,2);legacy.close();
  const codec=fixture(),player=codec.create('webcodecs');
  for(let n=0;n<100;n++)codec.frame(n);
  assert.equal(codec.stats().pending,1);assert.equal(codec.stats().closedImages,99);codec.flush();
  assert.equal(player.stats().drawnFrames,1);assert.equal(codec.stats().closedImages,100);
  codec.frame(99);codec.flush();assert.equal(player.stats().drawnFrames,1,'duplicate timestamps cannot claim progress');
  codec.frame(101);player.close();codec.flush();assert.equal(codec.stats().pending,0);assert.equal(codec.stats().output,1);
  // Image decoding owns only one in-flight image plus the latest waiting one.
  const jpeg=fixture(),images=jpeg.create('jpeg');
  for(let n=1;n<=100;n++)images.feed({sequence:n,bytes:Uint8Array.from([255,216,255,217])});
  assert.equal(jpeg.stats().images,1);jpeg.image();await new Promise(setImmediate);
  assert.equal(jpeg.stats().images,1);jpeg.image();await new Promise(setImmediate);
  assert.equal(images.stats().drawnFrames,2);assert.equal(images.stats().droppedFrames,98);
  images.feed({sequence:101,bytes:Uint8Array.from([255,216,255,217])});images.close();jpeg.image();await new Promise(setImmediate);
  assert.equal(jpeg.stats().output,2,'late JPEG decode must not draw after teardown');
  console.log('PASS: repeated RTC callbacks and dropped frames, timestamp fallback, latest-frame bounds, deterministic resource cleanup, bounded JPEG decoding');
})().catch(error=>{console.error(error);process.exitCode=1;});
