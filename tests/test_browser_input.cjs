/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Production input handlers under a deterministic DOM/WS transport. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(connectReady = 1) {
  class Events {
    constructor() { this.handlers = {}; this.hidden = false; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    emit(name, value = {}) { for (const fn of this.handlers[name] || []) fn({type:name, ...value}); }
  }
  const elements = new Map(), frames = new Map(), timers = new Map(), intervals = new Map(), sockets = [];
  let ident = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new Events(), {textContent:'',
      getBoundingClientRect:()=>({left:0,top:0,width:1000,height:500})}));
    return elements.get(id);
  };
  const surface = element('surface'), captured = new Set();
  surface.setPointerCapture = id => captured.add(id);
  surface.hasPointerCapture = id => captured.has(id);
  surface.releasePointerCapture = id => { captured.delete(id); surface.emit('lostpointercapture',{pointerId:id}); };
  const video = Object.assign(new Events(), {play:()=>Promise.resolve(), readyState:0, removeAttribute(){},load(){}});
  class Socket {
    static OPEN = 1;
    constructor(url='') { this.url=url;this.readyState=url ? connectReady : 1;this.bufferedAmount=0;this.messages=[];sockets.push(this); }
    send(text) { this.messages.push(JSON.parse(text)); }
    close() { this.readyState=3; }
  }
  const window = new Events(), document = Object.assign(new Events(), {
    getElementById:element, querySelector:()=>video, body:{classList:{toggle(){}}}, hidden:false});
  const initial = new Socket();
  const context = {window,document,WebSocket:Socket,location:{protocol:'http:',host:'fixture.test:8080'},
    performance:{now:()=>1000}, AbortController, fetch:async()=>({ok:true,json:async()=>({active:true,configured:true,viewers:0,controllers:0})}),
    setTimeout:(fn,delay)=>{timers.set(++ident,{fn,delay});return ident;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{intervals.set(++ident,{fn,delay});return ident;},clearInterval:id=>intervals.delete(id),
    requestAnimationFrame:fn=>{frames.set(++ident,fn);return ident;},cancelAnimationFrame:id=>frames.delete(id), initial};
  const text=fs.readFileSync(require.resolve('../web/player.js'),'utf8').replace(/\r\n/g,'\n')
    .replace('  connect();\n})();', `  config={width:640,height:360,generation:7}; control=initial; active=true; displayed=true;\n})();`);
  vm.runInNewContext(text, context);
  const pointer=(type,x=500,y=250,id=1)=>surface.emit(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y,preventDefault(){}});
  return {initial,surface,window,document,element,pointer,captured,sockets,
    frame(){ const callbacks=[...frames.values()];frames.clear();for(const fn of callbacks)fn(); },
    interval(delay){for(const t of [...intervals.values()])if(t.delay===delay)t.fn();},
    timeout(delay){for(const [id,t] of [...timers])if(t.delay===delay){timers.delete(id);t.fn();}},
    pendingFrames:()=>frames.size};
}
(async()=>{
  const drag=fixture();drag.pointer('pointerdown');
  for(let n=0;n<100;n++)drag.pointer('pointermove',500+n,250);
  assert.equal(drag.initial.messages.filter(m=>m.phase===1).length,0,'moves should wait for the next display frame');
  assert.equal(drag.pendingFrames(),1);drag.frame();
  assert.equal(drag.initial.messages.filter(m=>m.phase===1).length,1,'a move burst should coalesce');
  drag.pointer('pointermove',900,400);drag.pointer('pointerup',950,450);drag.frame();
  assert.equal(drag.pendingFrames(),0);
  const up=drag.initial.messages.find(m=>m.phase===2);assert.equal(up.x,608);assert.equal(up.y,324);
  assert.equal(drag.captured.size,0,'pointer capture must be released after up');
  assert(!drag.initial.messages.slice(drag.initial.messages.indexOf(up)+1).some(m=>m.phase===1),'no late move after up');
  const quick=fixture();quick.pointer('pointerdown',100,100);quick.pointer('pointermove',200,100);quick.pointer('pointerup',300,100);quick.frame();
  assert.deepEqual(quick.initial.messages.filter(m=>m.type==='touch').map(m=>m.phase),[0,1,2],
    'a swipe shorter than a display frame still needs a move before up');
  const cancel=fixture();cancel.pointer('pointerdown');cancel.pointer('pointermove');cancel.pointer('pointercancel');cancel.frame();
  assert.equal(cancel.captured.size,0);assert(cancel.initial.messages.some(m=>m.phase===3));
  const hold=fixture();hold.pointer('pointerdown');hold.interval(200);
  assert(hold.initial.messages.some(m=>m.type==='hold'));hold.window.emit('blur');
  const count=hold.initial.messages.length;hold.interval(200);assert.equal(hold.initial.messages.length,count);
  assert.equal(hold.captured.size,0,'blur must relinquish browser capture');
  const lost=fixture();lost.pointer('pointerdown');lost.surface.emit('lostpointercapture',{pointerId:1});
  assert(lost.initial.messages.some(m=>m.phase===3));
  const resize=fixture();resize.pointer('pointerdown');resize.window.emit('resize');
  assert.equal(resize.captured.size,0,'resizing must cancel before coordinates change');
  assert(resize.initial.messages.some(m=>m.type==='release'));
  const busy=fixture();busy.pointer('pointerdown');busy.initial.bufferedAmount=8192;
  busy.pointer('pointermove');busy.frame();
  assert.equal(busy.initial.readyState,3,'congested control transport should reconnect');
  assert.equal(busy.captured.size,0);assert.equal(busy.pendingFrames(),0);
  assert(busy.initial.messages.length<=2,'congestion must not append a backlog of moves');
  const broken=fixture();broken.initial.send=()=>{throw Error('closed transport');};broken.pointer('pointerdown');
  assert.equal(broken.initial.readyState,3);assert.equal(broken.captured.size,0);
  const cached=fixture();cached.window.emit('pagehide');cached.window.emit('pageshow',{persisted:true});
  await new Promise(setImmediate);
  assert.equal(cached.sockets.length,3,'bfcache restoration should reconnect both sockets');
  const connecting=fixture(0);connecting.window.emit('pagehide');connecting.window.emit('pageshow',{persisted:true});
  await new Promise(setImmediate);assert.equal(connecting.sockets.length,3);connecting.timeout(8000);
  assert(connecting.sockets.every(s=>s.readyState===3),'a hung WebSocket upgrade must time out');
  console.log('PASS: coalesced drag with final up, capture/cancel/blur/resize, long-press hold, bounded control congestion, bfcache reconnect, WS upgrade timeout');
})().catch(error=>{console.error(error);process.exitCode=1;});
