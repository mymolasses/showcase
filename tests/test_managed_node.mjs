import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createManagedServer,FileStorage} from '../managed-access/node-server.mjs';
const env=()=>({DOMAIN:'car.littlepond.eu.org',SERVICE_HOST:'setup.littlepond.eu.org',ADMIN_TOKEN:'a'.repeat(64),ISSUER_TOKEN:'b'.repeat(64),TOKEN_KEY:'c'.repeat(64)});
test('VPS control plane persists activation and renewed identities across restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'showcase-node-'));let app;
  try{
    const secrets=env();app=await createManagedServer({directory,env:secrets});
    const call=(route,token,body,host=secrets.SERVICE_HOST)=>new Promise((resolve,reject)=>{
      const request=http.request({host:'127.0.0.1',port:app.server.address().port,path:route,method:body?'POST':'GET',headers:{host,
        ...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})}},response=>{
          const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks))}));
        });request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
    });
    assert.equal((await call('/health',null,null,'other.example')).status,400);
    assert.equal((await call('/v1/identity')).status,401);
    const identity={domain:secrets.DOMAIN,notAfter:new Date(Date.now()+60*86400000).toISOString(),fingerprint:'d'.repeat(64),
      identityPassword:'test-private-password',pkcs12Base64:Buffer.concat([Buffer.from([0x30]),Buffer.alloc(300,1)]).toString('base64')};
    assert.equal((await call('/admin/identity',secrets.ISSUER_TOKEN,identity)).status,200);
    const {data:{activationCode}}=await call('/admin/enrollments',secrets.ADMIN_TOKEN,{expiresIn:900});
    const bound=await call('/v1/activate',null,{activationCode,deviceNonce:'e'.repeat(64)});assert.equal(bound.status,200);
    const token=bound.data.clientToken;await app.close();app=await createManagedServer({directory,env:secrets});
    assert.equal((await call('/v1/identity',token)).data.fingerprint,identity.fingerprint);
    assert.equal((await call('/admin/identity',secrets.ISSUER_TOKEN,{...identity,fingerprint:'f'.repeat(64)})).status,200);
    assert.equal((await call('/v1/identity',token)).data.fingerprint,'f'.repeat(64));
    const stored=await fs.readFile(path.join(directory,'store.json'),'utf8');
    assert(!stored.includes(token));assert(!stored.includes(activationCode));
    if(process.platform!=='win32')assert.equal((await fs.stat(path.join(directory,'store.json'))).mode&0o777,0o600);
    const unknown=await call('/admin/identity',secrets.ADMIN_TOKEN,identity);assert.equal(unknown.status,401);
  }finally{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('a failed file transaction leaves no partial device binding after restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'showcase-storage-'));
  try{
    const store=await new FileStorage(directory).open();await store.put('original',{value:1});
    await assert.rejects(store.transaction(async tx=>{await tx.put('enrollment:test',{nonce:'partial'});throw Error('cancel');}));
    const reloaded=await new FileStorage(directory).open();assert.deepEqual(await reloaded.get('original'),{value:1});
    assert.equal(await reloaded.get('enrollment:test'),undefined);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
