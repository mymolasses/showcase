/* Real AVC -> production Worker/WebCodecs/WebGL2, plus HTTPS/WSS and input. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const http=require('node:http'),https=require('node:https'),crypto=require('node:crypto'),os=require('node:os');
const {once}=require('node:events'),{execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wire(data){
  const b=Buffer.from(data),h=Buffer.alloc(b.length<126?2:b.length<65536?4:10);h[0]=0x82;
  if(h.length===2)h[1]=b.length;else if(h.length===4){h[1]=126;h.writeUInt16BE(b.length,2);}else{h[1]=127;h.writeBigUInt64BE(BigInt(b.length),2);}
  return Buffer.concat([h,b]);
}
(async()=>{
  const tls=process.env.SHOWCASE_TEST_TLS==='1',work=fs.mkdtempSync(path.join(os.tmpdir(),'showcase-worker-'));
  let browser,timer,sequence=0,generation=7,flowing=true,description,frames,mediaConnections=0;
  const sockets=new Set(),media=new Set(),controls=new Set(),touches=[],pageErrors=[];
  let tlsOptions,spki;
  if(tls){
    const openssl=process.env.OPENSSL || (process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
    const run=args=>execFileSync(openssl,args,{cwd:work,stdio:['ignore','pipe','pipe']});
    run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout','key.pem','-out','cert.pem']);
    tlsOptions={key:fs.readFileSync(path.join(work,'key.pem')),cert:fs.readFileSync(path.join(work,'cert.pem'))};
    spki=crypto.createHash('sha256').update(new crypto.X509Certificate(tlsOptions.cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  }
  const config=()=>{const h=Buffer.alloc(9);h[0]=1;h.writeUInt32BE(generation,1);h.writeUInt16BE(640,5);h.writeUInt16BE(360,7);return Buffer.concat([h,Buffer.from(description)]);};
  const handler=(req,res)=>{
    if(req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({active:true,configured:true,width:640,height:360,generation,viewers:media.size,controllers:controls.size,receivedFrames:sequence,frameAgeMs:flowing?10:5000,version:'test',build:'worker'}));return;}
    const file=path.join(root,'web',req.url==='/'?'index.html':req.url.slice(1));
    if(req.url.includes('..')||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; media-src 'none'");
    res.end(fs.readFileSync(file));
  };
  const server=tls?https.createServer(tlsOptions,handler):http.createServer(handler);
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.on('upgrade',(req,s)=>{
    if(!['/media','/control'].includes(req.url)){s.destroy();return;}
    s.on('error',()=>{});
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const group=req.url==='/media'?media:controls;group.add(s);s.on('close',()=>group.delete(s));
    if(group===media){mediaConnections++;s.write(wire(config()));}
    let input=Buffer.alloc(0);
    s.on('data',bytes=>{
      input=Buffer.concat([input,bytes]);
      while(input.length>=2){let n=input[1]&127,h=2;if(n===126){if(input.length<4)return;n=input.readUInt16BE(2);h=4;}if(n===127||n>32768){s.destroy();return;}if(input.length<h+4+n)return;
        const mask=input.subarray(h,h+4),b=Buffer.alloc(n),op=input[0]&15;for(let i=0;i<n;i++)b[i]=input[h+4+i]^mask[i%4];input=input.subarray(h+4+n);
        if(op===8){s.end();return;}if(op!==1)continue;const m=JSON.parse(b);
        if(m.type==='keyframe')sequence=Math.ceil(sequence/30)*30;
        if(['touch','hold','release'].includes(m.type))touches.push(m);
      }
    });
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
    const args=['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-proxy-server','--host-resolver-rules=MAP insecure.showcase.test 127.0.0.1'];
    if(spki)args.push('--ignore-certificate-errors-spki-list='+spki);
    browser=await chromium.launch({executablePath:process.env.CHROME||undefined,headless:true,args});
    const page=await browser.newPage({viewport:{width:1000,height:800}});let workers=0,mediaWorker;page.on('worker',worker=>{workers++;mediaWorker=worker;});
    const redPixel=()=>mediaWorker.evaluate(()=>{const p=new Uint8Array(4);gl.readPixels(10,canvas.height-11,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p];});
    const base=`${tls?'https':'http'}://127.0.0.1:${port}`;await page.goto(base+'/status');
    for(const profile of ['baseline','main','high']){
      const encoded=await page.evaluate(async profile=>{
        const codec={baseline:'avc1.42001e',main:'avc1.4d001e',high:'avc1.64001e'}[profile];
        const frames=[];let description;
        const encoder=new VideoEncoder({output(chunk,meta){const b=new Uint8Array(chunk.byteLength);chunk.copyTo(b);frames.push({key:chunk.type==='key',bytes:[...b]});if(meta.decoderConfig?.description)description=[...new Uint8Array(meta.decoderConfig.description)];},error:e=>{throw e;}});
        encoder.configure({codec,width:640,height:360,framerate:30,bitrate:1500000,latencyMode:'realtime',avc:{format:'avc'}});
        const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');
        for(let n=0;n<60;n++){ctx.fillStyle='#183960';ctx.fillRect(0,0,640,360);ctx.fillStyle='#ee3020';ctx.fillRect(0,0,50,50);ctx.fillStyle='#20e080';ctx.fillRect(200+n*4,120,70,70);
          const f=new VideoFrame(c,{timestamp:Math.round(n*1e6/30)});encoder.encode(f,{keyFrame:n%30===0});f.close();}
        await encoder.flush();encoder.close();return{description,frames};
      },profile);
      description=encoded.description;frames=encoded.frames;sequence=0;generation++;flowing=true;
      assert.equal(description[1],{baseline:66,main:77,high:100}[profile]);
      timer=setInterval(()=>{
        if(!flowing)return;const n=sequence++,f=frames[n%frames.length],h=Buffer.alloc(14);h[0]=2;h.writeUInt32BE(generation,1);h[5]=+f.key;h.writeBigUInt64BE(BigInt(Math.round(n*1e6/30)),6);
        for(const s of media)s.write(wire(Buffer.concat([h,Buffer.from(f.bytes)])));
      },33);
      if(profile==='baseline')page.on('pageerror',e=>pageErrors.push(e.message));
      const priorWorkers=workers;await page.goto(base);
      const ready=()=>page.waitForFunction(()=>window.showcaseDiagnostics?.().displayed&&showcaseDiagnostics().drawnFrames>5,null,{timeout:15000});
      await ready();
      assert.equal(await page.locator('video,img,#renderer').count(),0);
      assert.equal(await page.evaluate(()=>showcaseDiagnostics().renderer),'webcodecs-worker');
      const color=await redPixel();
      assert(color[0]>color[2]+100 && color[3]===255,'WebGL must render real red top-left AVC pixels: '+color);
      const before=mediaConnections;for(const s of media)s.write(wire(config()));await sleep(300);assert.equal(mediaConnections,before,'identical config must not reconnect');
      flowing=false;await sleep(700);const snapshot=await page.evaluate(()=>showcaseDiagnostics().drawnFrames);await sleep(1700);
      assert.equal(await page.evaluate(()=>showcaseDiagnostics().drawnFrames),snapshot,'a timer must not report static frames');assert.equal(mediaConnections,before);
      flowing=true;sequence=Math.ceil(sequence/30)*30;
      await page.waitForFunction(n=>showcaseDiagnostics().drawnFrames>n,snapshot);
      await page.mouse.click(500,400);await sleep(100);assert(touches.some(m=>m.phase===0&&m.x===320&&m.y===180),'touch uses source coordinates');
      await page.mouse.move(500,400);await page.mouse.down();await sleep(900);assert(touches.some(m=>m.type==='hold'));await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();
      await page.click('#menu');await page.click('#reconnect');await ready();
      const reconnected=mediaConnections;
      for(const s of media)s.destroy();
      const end=Date.now()+15000;while(mediaConnections===reconnected){if(Date.now()>end)throw Error('media connection did not recover');await sleep(50);}
      await ready();
      assert.equal(workers,priorWorkers+1,'recovery reuses the same Worker and GPU context');
      await page.click('#disconnect');await sleep(150);
      assert.equal(await page.evaluate(()=>showcaseDiagnostics().retainedFrame),true,'disconnect retains final image');
      const retained=await redPixel();
      assert(retained[0]>retained[2]+100 && retained[3]===255,'the original GPU canvas retains real pixels after disconnect');
      clearInterval(timer);timer=null;
      console.log('PASS: '+(tls?'HTTPS/WSS':'loopback HTTP/WS')+' '+profile+' real H.264, Worker/WebGL pixels, static screen, touch/hold, reconnect and retained image');
      await page.goto(base+'/status');await sleep(200);
    }
    if(!tls){
      const count=mediaConnections;await page.goto(`http://insecure.showcase.test:${port}/`);
      await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('HTTPS'));
      assert.equal(await page.evaluate(()=>isSecureContext),false);assert.equal(mediaConnections,count,'insecure page must not start media');
      console.log('PASS: real insecure HTTP origin fails clearly without fallback');
    }
    assert.deepEqual(pageErrors,[]);
  }finally{
    clearInterval(timer);if(browser)await browser.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));
    for(const name of fs.readdirSync(work))fs.unlinkSync(path.join(work,name));fs.rmdirSync(work);
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
