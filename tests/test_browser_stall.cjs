/* Production player under deterministic media/timer fixtures. No real time,
 * iPhone or decoder is used here; Chrome playback is covered separately. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const key=Uint8Array.from(Buffer.from('0000000265b8','hex'));
const delta=Uint8Array.from(Buffer.from('0000000241c0','hex'));
const info={avcc:Uint8Array.from(Buffer.from('0142001effe100046742001e01000268ce','hex')),width:640,height:360};
function fixture() {
  let now=0, start=0, end=0, seeks=0, removes=0, sources=0, ident=0;
  const tasks=new Map(), intervals=new Map(), messages=[];
  class Events { constructor(){this.handlers={};} addEventListener(n,f){this.handlers[n]=f;} emit(n){this.handlers[n]?.();} }
  const video=Object.assign(new Events(),{position:0,paused:false,seeking:false,play:()=>Promise.resolve(),removeAttribute(){},load(){},
    buffered:{get length(){return end>start?1:0;},start:()=>start,end:()=>end}});
  Object.defineProperty(video,'currentTime',{get(){return this.position;},set(t){this.position=t;seeks++;}});
  class Source extends Events {
    static isTypeSupported(){return true;}
    constructor(){super();sources++;start=end=0;}
    addSourceBuffer(){
      return Object.assign(new Events(),{updating:false,
        appendBuffer(bytes){
          const b=Buffer.from(bytes), t=b.indexOf('tfdt'), r=b.indexOf('trun');
          if(t>=0)end=Math.max(end,Number(b.readBigUInt64BE(t+8))/90000+b.readUInt32BE(r+16)/90000);
          this.emit('updateend');
        },remove(a,b){start=b;removes++;this.emit('updateend');}});
    }
  }
  const elements=new Map(), element=id=>{if(!elements.has(id))elements.set(id,Object.assign(new Events(),{hidden:true}));return elements.get(id);};
  const context={window:Object.assign(new Events(),{MediaSource:Source}),document:Object.assign(new Events(),{getElementById:element,querySelector:()=>video}),
    WebSocket:{OPEN:1},URL:{createObjectURL(source){tasks.set(++ident,{at:now,fn:()=>source.emit('sourceopen')});return 'blob:test';},revokeObjectURL(){}},performance:{now:()=>now},
    sendTestMessage:s=>messages.push(JSON.parse(s)),
    setTimeout:(fn,delay)=>{tasks.set(++ident,{at:now+delay,fn});return ident;},clearTimeout:id=>tasks.delete(id),
    setInterval:(fn,delay)=>{intervals.set(++ident,{fn,delay});return ident;},clearInterval:id=>intervals.delete(id)};
  const text=fs.readFileSync(require.resolve('../web/player.js'),'utf8').replace(/\r\n/g,'\n')
    .replace('  connect();\n})();',`  globalThis.begin=()=>{config=globalThis.info;media={readyState:1,close(){}};control={readyState:1,close(){},send:sendTestMessage};player=makePlayer(config);};
      globalThis.current=()=>player;globalThis.getMetrics=()=>metrics;\n})();`);
  vm.runInNewContext(text,context);context.info=info;context.begin();
  const advance=t=>{now=t;let safety=0;for(;;){const ready=[...tasks].find(([,v])=>v.at<=now);if(!ready)break;assert(++safety<100);tasks.delete(ready[0]);ready[1].fn();}};
  advance(0);
  return {video,messages,advance,feed:(n,isKey=false)=>context.current()?.feed(isKey?key:delta,isKey,Math.round(n*1e6/30)),
    tick:()=>{for(const t of [...intervals.values()])if(t.delay===250)t.fn();},metrics:()=>context.getMetrics(),
    forceRange:(a,b)=>{start=a;end=b;},stats:()=>({seeks,removes,sources,history:video.position-start})};
}
// A short new buffer must recover, while an idle/static screen must stay put.
const short=fixture();short.forceRange(0,.4);short.video.position=.1;short.advance(100);short.tick();
short.advance(1100);short.feed(0,true);short.advance(1120);short.feed(1);short.advance(1140);short.feed(2);short.tick();
assert.equal(short.stats().seeks,1);assert(Math.abs(short.video.position-.25)<.001);
short.advance(5000);short.tick();assert.equal(short.stats().seeks,1);assert.equal(short.metrics().recoveries,0);
// A permanently stalled decoder must escalate and stop within a bounded budget.
const stuck=fixture();
for(let n=0;n<1800;n++){stuck.advance(n*1000/30);stuck.feed(n,n%30===0);if(n%8===0)stuck.tick();}
assert(stuck.metrics().recoveries>=3);assert(stuck.stats().sources>=3);assert(stuck.stats().seeks<15);
// Thirty simulated minutes with keyframes only when the production player asks.
const long=fixture();let handled=0,maxHistory=0;
for(let n=0;n<54000;n++){
  long.advance(n*1000/30);
  const want=long.messages.length>handled;handled=long.messages.length;
  long.feed(n,n===0||want);
  long.video.position=Math.max(0,n/30-.15);
  if(n%8===0)long.tick();maxHistory=Math.max(maxHistory,long.stats().history);
}
assert(long.messages.some(m=>m.type==='keyframe'));assert(long.stats().removes>100);
assert(maxHistory<25);assert.equal(long.metrics().recoveries,0);
// An unresponsive sender cannot make retained history grow without bound.
const noKey=fixture();
for(let n=0;n<1500;n++){noKey.advance(n*1000/30);noKey.feed(n,n===0);noKey.video.position=Math.max(0,n/30-.15);if(n%8===0)noKey.tick();}
assert(noKey.metrics().recoveries>0);
console.log('PASS: bounded stall escalation, static-screen preservation, 30-minute sparse-IDR eviction, ignored-keyframe history cap');
