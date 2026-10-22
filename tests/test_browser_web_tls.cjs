/* SPDX-License-Identifier: GPL-3.0-or-later
 * HTTPS/WSS front door with a private test CA; no keychain or real alias writes.
 */
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const http=require('node:http'), https=require('node:https'), net=require('node:net'), crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {chromium}=require('playwright');
const fixture=require('./browser_web_fixture.cjs'),root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function frame(bytes,opcode=2){const b=Buffer.from(bytes),h=Buffer.alloc(b.length>65535?10:b.length>125?4:2);h[0]=0x80|opcode;
 if(h.length===10){h[1]=127;h.writeBigUInt64BE(BigInt(b.length),2);}else if(h.length===4){h[1]=126;h.writeUInt16BE(b.length,2);}else h[1]=b.length;return Buffer.concat([h,b]);}
(async()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'showcase-tls-e2e-')),domain='carplay.showcase.test';
 let helper,browser,backend;let stderr='';const backendSockets=new Set();
 try{
  const cert=fixture(work,domain),httpPort=await port(),httpsPort=await port(),fallback=await port();
  const large=crypto.randomBytes(4*1024*1024),upgrades=[];
  backend=http.createServer((req,res)=>{assert.equal(req.headers.host,'127.0.0.1:'+backend.address().port);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({active:true,configured:true,viewers:0,controllers:0}));});
  backend.on('upgrade',(req,socket)=>{
   backendSockets.add(socket);socket.on('close',()=>backendSockets.delete(socket));
   assert.equal(req.headers.origin,'http://127.0.0.1:'+backend.address().port);upgrades.push(req.url);
   const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
   socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
   socket.on('error',()=>{});
   if(req.url==='/media')socket.write(frame(large));
   else socket.on('data',data=>{
    if((data[0]&15)===8){socket.end();return;}
    assert(data[1]&128);const n=data[1]&127,mask=data.subarray(2,6),decoded=Buffer.alloc(n);
    for(let i=0;i<n;i++)decoded[i]=data[i+6]^mask[i%4];
    assert.equal(JSON.parse(decoded).type,'ping');socket.write(frame('ack',1));
   });
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const config={domain,identityPassword:cert.password,testAnchor:cert.root,testBackendPort:backend.address().port};
  fs.writeFileSync(path.join(work,'browser-web.json'),JSON.stringify(config),{mode:0o600});
  execFileSync('clang',['-fobjc-arc','-DSC_PROBE_TEST=1','-Wno-deprecated-declarations','-framework','Foundation','-framework','Security',
   path.join(root,'source/browser_probe.m'),path.join(root,'source/browser_network.c'),path.join(root,'source/browser_web_tls.m'),'-o',path.join(work,'web')]);
  const state=path.join(work,'state.json'),args=['--parent',String(process.pid),'--test-port',String(fallback),'--test-http-port',String(httpPort),'--test-https-port',String(httpsPort),'--test-state',state];
  const start=()=>{helper=spawn(path.join(work,'web'),args,{stdio:['ignore','pipe','pipe']});helper.stderr.on('data',b=>stderr+=b);};
  const until=async(fn,label)=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error(label+'\n'+stderr);await sleep(50);}};
  start();await until(()=>fs.existsSync(state),'startup');
  assert.equal(JSON.parse(fs.readFileSync(state)).httpsReady,true,stderr);
  const request=(pathname,origin)=>new Promise((resolve,reject)=>{
   const headers={host:domain+':'+httpsPort};if(origin)headers.Origin=origin;
   https.get({host:'127.0.0.1',port:httpsPort,servername:domain,ca:cert.ca,path:pathname,headers},r=>{
    let data=[];r.on('data',b=>data.push(b));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(data).toString()}));
   }).on('error',reject);
  });
  assert.equal((await request('/')).status,200);assert.equal((await request('/status')).status,200);
  assert.equal((await request('/status','https://attacker.invalid')).status,403);
  const report=JSON.parse((await request('/probe.json')).body);assert.equal(report.domain,domain);assert(!JSON.stringify(report).includes(cert.password));
  const wrongHost=await new Promise(resolve=>{https.get({host:'127.0.0.1',port:httpsPort,servername:'wrong.example',ca:cert.ca,path:'/'},()=>resolve(false)).on('error',e=>resolve(e.code==='ERR_TLS_CERT_ALTNAME_INVALID'));});
  assert(wrongHost,'HTTPS certificate hostname must actually be checked');
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:[
   '--no-proxy-server','--host-resolver-rules=MAP '+domain+' 127.0.0.1','--ignore-certificate-errors-spki-list='+cert.spki]});
  const page=await browser.newPage();
  // This transport fixture sends random bytes, not AVC. Actual automatic
  // playback over HTTPS/WSS is exercised by test_browser_e2e.cjs.
  await page.route('**/player.js',route=>route.fulfill({contentType:'application/javascript',body:'/* transport fixture */'}));
  await page.goto('https://'+domain+':'+httpsPort+'/');
  assert.equal(await page.locator('#pair').count(),0);
  assert.equal(await page.locator('#surface').count(),1);
  const result=await page.evaluate(async()=>{
   function receive(path,send){return new Promise((resolve,reject)=>{const ws=new WebSocket('wss://'+location.host+path);ws.binaryType='arraybuffer';
    ws.onerror=()=>reject(Error('WSS failed'));ws.onopen=()=>{if(send)ws.send(JSON.stringify({type:'ping'}));};ws.onmessage=e=>{ws.close();resolve(e.data);};});}
   const [ack,data]=await Promise.all([receive('/control',true),receive('/media',false)]);
   const digest=await crypto.subtle.digest('SHA-256',data);return {ack,length:data.byteLength,digest:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')};
  });
  assert.equal(result.ack,'ack');assert.equal(result.length,large.length);assert.equal(result.digest,crypto.createHash('sha256').update(large).digest('hex'));
  assert(upgrades.includes('/media')&&upgrades.includes('/control'));
  await page.goto('http://'+domain+':'+httpPort+'/');assert.equal(await page.locator('#pair').count(),0);
  assert.equal(await page.locator('#surface').count(),1);
  helper.kill('SIGTERM');await once(helper,'exit');
  // Wrong password / wrong certificate hostname: HTTP remains available, HTTPS stays off.
  config.identityPassword='wrong';fs.writeFileSync(path.join(work,'browser-web.json'),JSON.stringify(config));fs.rmSync(state);start();
  await until(()=>fs.existsSync(state),'invalid password startup');assert.equal(JSON.parse(fs.readFileSync(state)).httpsReady,false);
  assert.equal((await fetch('http://127.0.0.1:'+httpPort+'/')).status,200);helper.kill('SIGTERM');await once(helper,'exit');
  config.identityPassword=cert.password;config.domain='wrong.example';fs.writeFileSync(path.join(work,'browser-web.json'),JSON.stringify(config));fs.rmSync(state);start();
  await until(()=>fs.existsSync(state),'invalid hostname startup');assert.equal(JSON.parse(fs.readFileSync(state)).httpsReady,false);
  helper.kill('SIGTERM');await once(helper,'exit');
  config.domain=domain;delete config.testAnchor;fs.writeFileSync(path.join(work,'browser-web.json'),JSON.stringify(config));fs.rmSync(state);start();
  await until(()=>fs.existsSync(state),'untrusted certificate startup');assert.equal(JSON.parse(fs.readFileSync(state)).httpsReady,false);
  console.log('PASS: trusted test-CA HTTPS + hostname checks, HTTP/domain player root, WSS 4 MiB integrity + control, strict public Origin, loopback rewrite, certificate failure keeps HTTP');
 }catch(error){console.error(stderr);throw error;}finally{
  if(helper&&helper.exitCode===null){helper.kill('SIGTERM');await once(helper,'exit');}
  if(browser)await browser.close();
  if(backend){for(const socket of backendSockets)socket.destroy();backend.closeAllConnections();await new Promise(r=>backend.close(r));}
  fs.rmSync(work,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
