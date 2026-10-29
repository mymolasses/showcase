/* SPDX-License-Identifier: GPL-3.0-or-later.
 * Run the same authenticated control plane behind an existing Nginx server.
 * No dependencies; video and touch never reach this process.
 */
import http from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import service,{ManagedAccess} from './worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

export class FileStorage {
  constructor(directory){this.directory=directory;this.filename=path.join(directory,'store.json');this.records=new Map();}
  async open(){
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});await fs.chmod(this.directory,0o700);
    try{
      const info=await fs.lstat(this.filename);
      if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Invalid private store');
      let value;try{value=JSON.parse(await fs.readFile(this.filename,'utf8'));}catch{throw Error('Invalid private store');}
      if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Invalid private store');
      this.records=new Map(Object.entries(value));await fs.chmod(this.filename,0o600);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    return this;
  }
  async commit(records){
    const temp=path.join(this.directory,'.store-'+randomUUID()+'.tmp');let file;
    try{
      file=await fs.open(temp,'wx',0o600);await file.writeFile(JSON.stringify(Object.fromEntries(records)));
      await file.sync();await file.close();file=null;await fs.rename(temp,this.filename);this.records=records;
    }finally{if(file)await file.close();await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async get(key){return structuredClone(this.records.get(key));}
  async put(key,value){const records=new Map(this.records);records.set(key,structuredClone(value));await this.commit(records);}
  async delete(key){const records=new Map(this.records);records.delete(key);await this.commit(records);}
  async transaction(action){
    const records=new Map([...this.records].map(([key,value])=>[key,structuredClone(value)]));
    const storage={get:async key=>structuredClone(records.get(key)),
      put:async(key,value)=>records.set(key,structuredClone(value)),delete:async key=>records.delete(key)};
    const result=await action(storage);await this.commit(records);return result;
  }
}

export async function createManagedServer({directory,env,listenHost='127.0.0.1',port=0}){
  for(const key of ['ADMIN_TOKEN','ISSUER_TOKEN','TOKEN_KEY'])if(!/^[a-f0-9]{64}$/.test(env[key]??''))throw Error('Invalid service credential');
  if(env.DOMAIN!=='car.littlepond.eu.org'||env.SERVICE_HOST!=='setup.littlepond.eu.org')throw Error('Wrong service hostname');
  const storage=await new FileStorage(directory).open(),object=new ManagedAccess({storage},env);
  env={...env,ACCESS:{idFromName:name=>name,get:()=>object}};
  let tail=Promise.resolve(),queued=0;
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    const reject=code=>{if(res.destroyed||res.writableEnded)return;
      try{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"Request rejected"}');}catch{res.destroy();}};
    if(req.headers.host!==env.SERVICE_HOST||!req.url.startsWith('/')||req.url.startsWith('//'))return reject(400);
    if(queued>=32)return reject(503);
    queued++;let chunks=[],length=0;
    try{
      for await(const part of req){length+=part.length;if(length>128000){queued--;return reject(413);}chunks.push(part);}
    }catch{queued--;return reject(400);}
    const run=async()=>{
      try{
        const request=new Request('https://'+env.SERVICE_HOST+req.url,{method:req.method,headers:req.headers,
          ...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
        const response=await service.fetch(request,env);
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      }catch{reject(500);}finally{queued--;chunks=[];}
    };
    const current=tail.then(run);tail=current.catch(()=>{});await current;
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,listenHost,resolve);});
  return {server,storage,close:async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await tail;}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const instance=await createManagedServer({directory:process.env.STATE_DIR??'/state',env:process.env,
    listenHost:process.env.LISTEN_HOST??'127.0.0.1',port:Number(process.env.PORT??8787)});
  console.log('Showcase certificate control plane is listening');
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await instance.close();process.exit(0);};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
