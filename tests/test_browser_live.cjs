/* Real Chrome, production assets, synthetic AVC/JPEG and real pointer events. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {once}=require('node:events'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const wire=(data,opcode=2)=>{
  const bytes=Buffer.from(data);let header;
  if(bytes.length<126)header=Buffer.from([128|opcode,bytes.length]);
  else if(bytes.length<65536){header=Buffer.alloc(4);header[0]=128|opcode;header[1]=126;header.writeUInt16BE(bytes.length,2);}
  else{header=Buffer.alloc(10);header[0]=128|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(bytes.length),2);}
  return Buffer.concat([header,bytes]);
};
(async()=>{
  let browser,timer,description,frames,jpegs,sequence=0,flowing=true;
  const media=new Set(),controls=new Set(),images=new Set(),sockets=new Set(),touches=[],errors=[];
  let connections=0;
  const until=async(predicate,label)=>{
    const deadline=Date.now()+5000;
    while(!predicate()) {
      if(Date.now()>=deadline)throw Error(label+': '+JSON.stringify(touches.slice(-12)));
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  };
  const config=()=>{const head=Buffer.alloc(9);head[0]=1;head.writeUInt32BE(7,1);head.writeUInt16BE(640,5);head.writeUInt16BE(360,7);return Buffer.concat([head,Buffer.from(description)]);};
  const server=http.createServer((req,res)=>{
    if(req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({active:true,configured:true,generation:7,width:640,height:360,viewers:media.size+images.size,controllers:controls.size,version:'test',build:'fixture',frameAgeMs:33,receivedFrames:sequence,mediaQueueBytes:0}));return;}
    if(req.url==='/mjpeg') {res.writeHead(200,{'Content-Type':'multipart/x-mixed-replace; boundary=showcase','Cache-Control':'no-store'});images.add(res);res.on('close',()=>images.delete(res));return;}
    const filename=req.url==='/'?'index.html':req.url.slice(1);
    if(filename.includes('..') || !fs.existsSync(path.join(root,'web',filename))){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',filename.endsWith('.wasm')?'application/wasm':filename.endsWith('.js')?'application/javascript':'text/html');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:");
    res.end(fs.readFileSync(path.join(root,'web',filename)));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket)=>{
    socket.on('error',()=>{});
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let input=Buffer.alloc(0);
    socket.on('data',bytes=>{
      input=Buffer.concat([input,bytes]);
      while(input.length>=2) {
        let size=input[1]&127,header=2;if(size===126){if(input.length<4)return;size=input.readUInt16BE(2);header=4;}
        if(size===127 || size>32768){socket.destroy();return;}
        if(input.length<header+4+size)return;
        const opcode=input[0]&15,mask=input.subarray(header,header+4),data=Buffer.alloc(size);
        for(let i=0;i<size;i++)data[i]=input[header+4+i]^mask[i%4];
        input=input.subarray(header+4+size);if(opcode===8){socket.end();return;}
        if(opcode===1){const message=JSON.parse(data);if(message.type==='keyframe')sequence=Math.ceil(sequence/30)*30;if(['touch','release','hold'].includes(message.type))touches.push(message);}
      }
    });
    if(req.url==='/control'){controls.add(socket);socket.on('close',()=>controls.delete(socket));}
    else {
      const client={socket,path:req.url};media.add(client);connections++;socket.on('close',()=>media.delete(client));socket.write(wire(config()));
      if(req.url==='/rtc')setTimeout(()=>{if(!socket.destroyed)socket.write(wire(JSON.stringify({type:'rtc-error',message:'fixture UDP unavailable',generation:7}),1));},100);
    }
  });
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    browser=await chromium.launch({executablePath:process.env.CHROME || undefined,headless:true});
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    await page.goto(`http://127.0.0.1:${server.address().port}/status`);
    const encoded=await page.evaluate(async()=>{
      const frames=[],jpegs=[];let description;
      const encoder=new VideoEncoder({output(chunk,meta){const bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);frames.push({key:chunk.type==='key',bytes:[...bytes]});if(meta.decoderConfig?.description)description=[...new Uint8Array(meta.decoderConfig.description)];},error(error){throw error;}});
      encoder.configure({codec:'avc1.42001e',width:640,height:360,framerate:30,bitrate:1200000,latencyMode:'realtime',avc:{format:'avc'}});
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
      for(let n=0;n<60;n++) {
        ctx.fillStyle=n%2?'#163870':'#365c80';ctx.fillRect(0,0,640,360);ctx.fillStyle='#20dc90';ctx.fillRect(n*8,100,100,100);
        const frame=new VideoFrame(canvas,{timestamp:Math.round(n*1e6/30)});encoder.encode(frame,{keyFrame:n%30===0});frame.close();
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.65));jpegs.push([...new Uint8Array(await blob.arrayBuffer())]);
      }
      await encoder.flush();encoder.close();return {description,frames,jpegs};
    });
    ({description,frames,jpegs}=encoded);assert.equal(description[1],66,'software test requires Baseline AVC');
    timer=setInterval(()=>{
      if(!flowing)return;const n=sequence++,frame=frames[n%frames.length],image=Buffer.from(jpegs[n%jpegs.length]);
      for(const client of media) {
        if(client.path==='/media'){const head=Buffer.alloc(14);head[0]=2;head.writeUInt32BE(7,1);head[5]=+frame.key;head.writeBigUInt64BE(BigInt(Math.round(n*1e6/30)),6);client.socket.write(wire(Buffer.concat([head,Buffer.from(frame.bytes)])));}
        if(client.path==='/jpeg'){const head=Buffer.alloc(21);head[0]=4;head.writeUInt32BE(7,1);head.writeBigUInt64BE(BigInt(n+1),5);head.writeBigUInt64BE(BigInt(Math.round(n*1e6/30)),13);client.socket.write(wire(Buffer.concat([head,image])));}
      }
      for(const res of images)res.write(Buffer.concat([Buffer.from(`--showcase\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`),image,Buffer.from('\r\n')]));
    },33);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const ready=async mode=>{
      try {await page.waitForFunction(mode=>{const d=window.showcaseDiagnostics?.();return d?.renderer===mode && d.displayed && (mode==='mjpeg'||d.drawnFrames>=3);},mode,{timeout:20000});}
      catch(error){throw Error(mode+': '+await page.evaluate(()=>JSON.stringify(window.showcaseDiagnostics?.()))+'\n'+error);}
    };
    await ready('jpeg');assert.equal(await page.locator('input').count(),0);assert.equal(await page.locator('video').count(),0);
    await page.click('#menu');await page.click('#diagnostics');
    const initialFrames=await page.evaluate(()=>showcaseDiagnostics().drawnFrames);
    await page.waitForFunction(count=>showcaseDiagnostics().drawnFrames>count+2,initialFrames,{timeout:5000});
    await page.click('#diagnostic-close');
    for(const mode of ['webcodecs','software','mjpeg','jpeg']) {
      await page.selectOption('#renderer',mode);await ready(mode);
      const before=await page.evaluate(()=>showcaseDiagnostics().drawnFrames);
      if(mode!=='mjpeg')await page.waitForFunction(count=>showcaseDiagnostics().drawnFrames>count,before,{timeout:5000});
      else assert.equal(await page.locator('#display img').evaluate(img=>img.naturalWidth),640);
      const color=await page.evaluate(()=>{const source=document.querySelector('#display canvas,#display img');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(source,10,300,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
      assert(color[2]>color[0] && color[2]>70 && color[3]===255,'decoded pixels must match the blue fixture in '+mode+': '+color);
      assert.equal(await page.locator('#poster').isVisible(),false);
    }
    const rect=await page.locator('#surface').boundingBox();
    const dragStart=touches.length;
    await page.mouse.move(rect.width/2,rect.height/2);await page.mouse.down();await page.mouse.move(rect.width*.8,rect.height*.8,{steps:6});await page.mouse.up();
    await until(()=>touches.slice(dragStart).some(m=>m.phase===2),'drag up must reach server');
    const drag=touches.slice(dragStart);assert(drag.some(m=>m.phase===0 && m.x===320 && m.y===180));assert(drag.some(m=>m.phase===1));assert(drag.some(m=>m.phase===2));
    const holdStart=touches.length;
    await page.mouse.down();await page.waitForTimeout(1000);await until(()=>touches.slice(holdStart).some(m=>m.type==='hold'),'long-press hold must reach server');
    const blurStart=touches.length;
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();await until(()=>touches.slice(blurStart).some(m=>m.type==='release'),'blur release must reach server');
    flowing=false;const stable=connections;await page.waitForTimeout(4000);assert.equal(connections,stable,'static screen must not churn connections');flowing=true;
    await page.click('#reconnect');await ready('jpeg');assert.equal(await page.locator('#poster').isVisible(),false);
    await page.click('#fit');assert.equal(await page.locator('#display canvas').evaluate(c=>getComputedStyle(c).objectFit),'contain');
    await page.selectOption('#renderer','webrtc');await page.waitForFunction(()=>showcaseDiagnostics().fallbackReason?.includes('fixture UDP unavailable') && showcaseDiagnostics().renderer==='jpeg');await ready('jpeg');
    assert.deepEqual(errors,[]);
    console.log('PASS: real Chrome JPEG, MJPEG, WebCodecs, Broadway/WASM, selectable modes, touch/hold/cancel, static screen, reconnect, RTC failure fallback');
  } finally {clearInterval(timer);if(browser)await browser.close();for(const socket of sockets)socket.destroy();for(const res of images)res.destroy();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
