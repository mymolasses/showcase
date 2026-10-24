/* Real Chrome: production output selector, viewport measurement, reconnection and touch. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {once}=require('node:events'),{chromium}=require('playwright');
const {displaySize}=require('../web/protocol.js');
const root=path.resolve(__dirname,'..');
const wire=data=>{
  const h=Buffer.alloc(data.length<126?2:data.length<65536?4:10);h[0]=0x82;
  if(h.length===2)h[1]=data.length;else if(h.length===4){h[1]=126;h.writeUInt16BE(data.length,2);}else{h[1]=127;h.writeBigUInt64BE(BigInt(data.length),2);}
  return Buffer.concat([h,data]);
};
(async()=>{
  let browser,page,timer,sequence=0,generation=1,width=1920,height=1080,profile={mode:'auto'},active=true;
  const media=new Set(),controls=new Set(),sockets=new Set(),requests=[],touches=[],errors=[],images=new Map();
  const config=()=>{const b=Buffer.alloc(9);b[0]=1;b.writeUInt32BE(generation,1);b.writeUInt16BE(width,5);b.writeUInt16BE(height,7);return Buffer.concat([b,Buffer.from('0142001effe100046742001e01000268ce','hex')]);};
  async function image(w,h) {
    const key=`${w}x${h}`;if(images.has(key))return images.get(key);
    const data=await page.evaluate(async({w,h})=>{
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');
      c.fillStyle='#18395b';c.fillRect(0,0,w,h);c.fillStyle='#f04030';c.fillRect(0,0,50,50);c.fillStyle='#20e080';c.fillRect(w-50,h-50,50,50);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.8));return [...new Uint8Array(await blob.arrayBuffer())];
    },{w,h});const raw=Buffer.from(data);images.set(key,raw);return raw;
  }
  let applying=false;
  async function apply(message) {
    requests.push(message);
    const size=message.mode==='auto'?displaySize(message.width,message.height):message.mode==='phone'?{width:1920,height:900}:displaySize(...message.mode.split('x').map(Number));
    assert(size);applying=true;await image(size.width,size.height);
    profile={...size,mode:message.mode};width=size.width;height=size.height;generation++;active=false;
    for(const socket of [...media,...controls])socket.destroy();
    setTimeout(()=>{active=true;applying=false;for(const socket of media)socket.write(wire(config()));},250);
  }
  const server=http.createServer((req,res)=>{
    if(req.url==='/status') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({active,configured:active,width,height,generation,viewers:media.size,controllers:controls.size,frameAgeMs:5,receivedFrames:sequence,displayControl:true,displayRequest:profile,phoneDisplay:{width:1920,height:900},sourceAVCProfile:66}));return;}
    if(req.url==='/blank'){res.end('<!doctype html><title>Fixture</title>');return;}
    const file=path.join(root,'web',req.url==='/'?'index.html':req.url.slice(1));
    if(req.url.includes('..')||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');res.end(fs.readFileSync(file));
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.on('upgrade',(req,socket)=>{
    socket.on('error',()=>{});let input=Buffer.alloc(0);
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data',bytes=>{
      input=Buffer.concat([input,bytes]);
      while(input.length>=2){let size=input[1]&127,h=2;if(size===126){if(input.length<4)return;size=input.readUInt16BE(2);h=4;}if(size===127||size>32768){socket.destroy();return;}if(input.length<h+4+size)return;
        const mask=input.subarray(h,h+4),data=Buffer.alloc(size),opcode=input[0]&15;for(let i=0;i<size;i++)data[i]=input[h+4+i]^mask[i%4];input=input.subarray(h+4+size);
        if(opcode===8){socket.end();return;}if(opcode!==1)continue;
        const m=JSON.parse(data);if(m.type==='display'&&!applying)apply(m).catch(error=>errors.push(error.message));if(m.type==='touch')touches.push(m);
      }
    });
    const group=req.url==='/control'?controls:media;group.add(socket);socket.on('close',()=>group.delete(socket));
    if(group===media&&active)socket.write(wire(config()));
  });
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({executablePath:process.env.CHROME||undefined,headless:true});page=await browser.newPage({viewport:{width:1280,height:800}});
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/blank');await image(1920,1080);
    timer=setInterval(()=>{if(!active)return;const bytes=images.get(`${width}x${height}`);if(!bytes)return;const h=Buffer.alloc(21);h[0]=4;h.writeUInt32BE(generation,1);h.writeBigUInt64BE(BigInt(++sequence),5);h.writeBigUInt64BE(BigInt(sequence*100000),13);for(const s of media)s.write(wire(Buffer.concat([h,bytes])));},100);
    await page.goto(base);
    const ready=async(mode,w,h)=>page.waitForFunction(({mode,w,h})=>{
      const d=window.showcaseDiagnostics?.();return d?.outputMode===mode&&d.displayed&&d.receiver.width===w&&d.receiver.height===h&&d.resolution===`${w} × ${h}`;
    },{mode,w,h},{timeout:20000});
    await ready('auto',1280,800);assert.equal(requests.length,1);assert.equal(await page.locator('#display canvas').evaluate(c=>getComputedStyle(c).objectFit),'contain');
    await page.setViewportSize({width:1281,height:800});await page.waitForTimeout(3500);assert.equal(requests.length,1,'tiny viewport jitter must not restart');
    await page.setViewportSize({width:1366,height:768});await ready('auto',1366,768);assert.equal(requests.length,2);
    await page.click('#menu');await page.selectOption('#output-resolution','phone');await ready('phone',1920,900);
    const phoneCount=requests.length;await page.setViewportSize({width:1200,height:800});await page.waitForTimeout(3500);assert.equal(requests.length,phoneCount,'phone target must ignore browser resizing');
    await page.selectOption('#output-resolution','1600x1000');await ready('1600x1000',1600,1000);
    const rect=await page.locator('#surface').boundingBox();await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
    await page.waitForTimeout(150);assert(touches.some(t=>t.phase===0&&t.x===800&&t.y===500&&t.generation===generation));
    await page.screenshot({path:path.join(root,'build','browser-display-options.png')});
    // A selection changed in the phone app becomes authoritative on the page.
    profile={mode:'phone',width:1600,height:1000};const before=requests.length;
    await page.waitForFunction(()=>document.getElementById('output-resolution').value==='phone');
    // Its new source geometry arrives through the phone's restart in production.
    width=1920;height=900;generation++;await image(width,height);for(const s of media)s.write(wire(config()));profile={mode:'phone',width,height};
    await ready('phone',1920,900);await page.waitForTimeout(2500);assert.equal(requests.length,before,'browser must not overwrite a phone-app choice');
    await page.selectOption('#output-resolution','auto');await ready('auto',1200,800);
    assert.deepEqual(errors,[]);console.log('PASS: real Chrome auto viewport, jitter suppression, reconnect, phone/manual/auto targets, remote preference and resized touch');
  } finally {clearInterval(timer);if(browser)await browser.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
