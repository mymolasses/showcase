/* SPDX-License-Identifier: GPL-3.0-or-later.
 * Control plane only. Video and touch never pass through this service.
 * DNS credentials stay in Worker secrets; phones receive a scoped certificate
 * refresh token after a one-time, device-bound activation.
 */
const encoder = new TextEncoder();
const json = (value, status=200) => new Response(JSON.stringify(value), {status, headers:{
  'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff'}});
const hex = bytes => [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest = value => crypto.subtle.digest('SHA-256',encoder.encode(value)).then(hex);
function random() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function equal(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||b.length<32)return false;
  const x=await digest(a),y=await digest(b);let difference=0;
  for(let n=0;n<x.length;n++)difference|=x.charCodeAt(n)^y.charCodeAt(n);
  return difference===0;
}
const bearer = request => request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]{32,256})$/)?.[1];
async function body(request, limit=4096) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('JSON required');
  const reader=request.body?.getReader();if(!reader)throw Error('Missing body');
  const chunks=[];let count=0;
  while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;
    if(count>limit){await reader.cancel();throw Error('Body too large');}chunks.push(value);}
  const bytes=new Uint8Array(count);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const result=JSON.parse(new TextDecoder().decode(bytes));
  if(!result||Array.isArray(result)||typeof result!=='object')throw Error('Object required');
  return result;
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.protocol!=='https:'||url.hostname!==env.SERVICE_HOST)return json({error:'Wrong service origin'},400);
    const id=env.ACCESS.idFromName('managed-carplay');
    return env.ACCESS.get(id).fetch(request);
  }
};
export class ManagedAccess {
  constructor(state,env){this.state=state;this.env=env;}
  async cf(path,method='GET',data) {
    const response=await fetch('https://api.cloudflare.com/client/v4/zones/'+this.env.CF_ZONE_ID+path,{
      method,headers:{authorization:'Bearer '+this.env.CF_DNS_API_TOKEN,'content-type':'application/json'},
      ...(data===undefined?{}:{body:JSON.stringify(data)})});
    const result=await response.json();
    if(!response.ok||!result.success)throw Error('DNS provider request failed');
    return result.result;
  }
  async fetch(request) {
    try{return await this.handle(request);}catch(error){
      // Never return provider responses, submitted bodies, credentials or keys.
      return json({error:error.message==='Body too large'?'Body too large':'Invalid request or upstream unavailable'},400);
    }
  }
  async handle(request) {
    const path=new URL(request.url).pathname,method=request.method,token=bearer(request);
    const admin=()=>equal(token,this.env.ADMIN_TOKEN),issuer=()=>equal(token,this.env.ISSUER_TOKEN);
    const saved=()=>this.state.storage.get('identity');
    if(method==='GET'&&path==='/health')return json({service:'Showcase managed access',domain:this.env.DOMAIN});
    if(path.startsWith('/admin/')) {
      const issuePath=['/admin/status','/admin/challenge','/admin/challenge/cleanup','/admin/identity'].includes(path);
      if(!(issuePath?await issuer():await admin()))return json({error:'Unauthorized'},401);
      if(path==='/admin/status'&&method==='GET') {
        const identity=await saved();return json({domain:this.env.DOMAIN,notAfter:identity?.notAfter??null,
          fingerprint:identity?.fingerprint??null});
      }
      if(path==='/admin/identity'&&method==='POST') {
        const value=await body(request,120000),expires=Date.parse(value.notAfter);
        if(value.domain!==this.env.DOMAIN||!Number.isFinite(expires)||expires<Date.now()+86400000||expires>Date.now()+120*86400000||
          typeof value.identityPassword!=='string'||value.identityPassword.length<16||value.identityPassword.length>128||
          !/^[a-f0-9]{64}$/.test(value.fingerprint)||typeof value.pkcs12Base64!=='string'||value.pkcs12Base64.length>90000||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pkcs12Base64))throw Error('Invalid identity');
        const raw=atob(value.pkcs12Base64);if(raw.length<256||raw.length>65536||raw.charCodeAt(0)!==0x30)throw Error('Invalid identity');
        const identity={domain:value.domain,notAfter:new Date(expires).toISOString(),fingerprint:value.fingerprint,
          identityPassword:value.identityPassword,pkcs12Base64:value.pkcs12Base64};
        await this.state.storage.put('identity',identity);return json({ok:true,notAfter:identity.notAfter});
      }
      if((path==='/admin/challenge'||path==='/admin/challenge/cleanup')&&method==='POST') {
        const value=await body(request);
        if(value.domain!==this.env.DOMAIN||!/^[A-Za-z0-9_-]{43}$/.test(value.validation))throw Error('Wrong challenge');
        const name='_acme-challenge.'+this.env.DOMAIN,key='challenge:'+await digest(value.validation);
        const owned=await this.state.storage.get(key);
        if(path.endsWith('/cleanup')) {
          if(owned){
            const record=await this.cf('/dns_records/'+owned);
            if(record.type!=='TXT'||record.name!==name||record.content!==value.validation||record.comment!=='Showcase managed certificate')
              return json({error:'Challenge record changed externally; preserved'},409);
            await this.cf('/dns_records/'+owned,'DELETE');await this.state.storage.delete(key);
          }
          return json({ok:true});
        }
        if(!owned){const record=await this.cf('/dns_records','POST',{type:'TXT',name,content:value.validation,ttl:60,
          comment:'Showcase managed certificate'});await this.state.storage.put(key,record.id);}
        return json({ok:true});
      }
      if(path==='/admin/enrollments'&&method==='POST') {
        const identity=await saved();if(!identity||Date.parse(identity.notAfter)<Date.now()+86400000)return json({error:'Certificate not ready'},503);
        const value=await body(request),seconds=value.expiresIn??86400;
        if(!Number.isInteger(seconds)||seconds<900||seconds>604800)throw Error('Invalid expiry');
        const activationCode=random(),expiresAt=Date.now()+seconds*1000;
        await this.state.storage.put('enrollment:'+await digest(activationCode),{expiresAt,createdAt:Date.now()});
        return json({activationCode,expiresAt:new Date(expiresAt).toISOString(),domain:this.env.DOMAIN});
      }
      if(path==='/admin/clients/revoke'&&method==='POST') {
        const value=await body(request);if(!/^[a-f0-9]{64}$/.test(value.clientId))throw Error('Invalid client');
        await this.state.storage.put('client:'+value.clientId,{revoked:true});return json({ok:true});
      }
      return json({error:'Not found'},404);
    }
    if(method==='POST'&&path==='/v1/activate') {
      if(typeof this.env.TOKEN_KEY!=='string'||this.env.TOKEN_KEY.length<32)return json({error:'Service not configured'},503);
      const value=await body(request);
      if(!/^[a-f0-9]{64}$/.test(value.activationCode)||!/^[a-f0-9]{64}$/.test(value.deviceNonce))throw Error('Invalid activation');
      const identity=await saved();if(!identity||Date.parse(identity.notAfter)<Date.now())return json({error:'Certificate not ready'},503);
      const id=await digest(value.activationCode),nonce=await digest(value.deviceNonce);
      const key=await crypto.subtle.importKey('raw',encoder.encode(this.env.TOKEN_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const clientToken=hex(await crypto.subtle.sign('HMAC',key,encoder.encode(id+':'+nonce))),clientId=await digest(clientToken);
      const accepted=await this.state.storage.transaction(async storage=>{
        const record=await storage.get('enrollment:'+id);
        if(!record||record.expiresAt<Date.now()||record.nonce&&record.nonce!==nonce)return false;
        const client=await storage.get('client:'+clientId);if(client?.revoked)return false;
        await storage.put('enrollment:'+id,{...record,nonce});
        await storage.put('client:'+clientId,{createdAt:record.createdAt,nonce});return true;
      });
      if(!accepted)return json({error:'Activation expired or already bound'},403);
      return json({...identity,clientToken,clientId});
    }
    if(method==='GET'&&path==='/v1/identity') {
      const client=token?await this.state.storage.get('client:'+await digest(token)):null;
      if(!client||client.revoked)return json({error:'Unauthorized'},401);
      const identity=await saved();if(!identity||Date.parse(identity.notAfter)<Date.now())return json({error:'Certificate unavailable'},503);
      return json(identity);
    }
    return json({error:'Not found'},404);
  }
}
