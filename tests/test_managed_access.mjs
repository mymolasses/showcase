import assert from 'node:assert/strict';
import test from 'node:test';
import service,{ManagedAccess} from '../managed-access/worker.mjs';
const origin='https://setup.littlepond.eu.org';
function fixture(){
  const records=new Map(),dns=new Map();let serial=Promise.resolve(),writes=0;
  const storage={get:async key=>structuredClone(records.get(key)),put:async(key,value)=>records.set(key,structuredClone(value)),
    delete:async key=>records.delete(key),transaction(fn){const pending=serial.then(()=>fn(storage));serial=pending.catch(()=>{});return pending;}};
  const env={DOMAIN:'car.littlepond.eu.org',SERVICE_HOST:'setup.littlepond.eu.org',CF_ZONE_ID:'zone',
    ADMIN_TOKEN:'a'.repeat(64),ISSUER_TOKEN:'i'.repeat(64),TOKEN_KEY:'k'.repeat(64)};
  const object=new ManagedAccess({storage},env);
  env.ACCESS={idFromName:name=>name,get:()=>object};
  object.cf=async(path,method='GET',data)=>{
    if(method==='POST'){const id=String(++writes);dns.set(id,{...data,id});return {id};}
    const id=path.split('/').at(-1);
    if(method==='DELETE'){dns.delete(id);return {};}
    if(!dns.has(id))throw Error('Not found');return dns.get(id);
  };
  const call=async(path,token,body,method=body?'POST':'GET')=>{
    const response=await service.fetch(new Request(origin+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),
      ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  const identity={domain:env.DOMAIN,notAfter:new Date(Date.now()+60*86400000).toISOString(),fingerprint:'f'.repeat(64),
    identityPassword:'fixture-private-password',pkcs12Base64:Buffer.concat([Buffer.from([0x30]),Buffer.alloc(300,1)]).toString('base64')};
  return {call,env,records,dns,identity,storage};
}
test('private identity, scoped roles, hostname and payload validation',async()=>{
  const f=fixture();assert.equal((await f.call('/v1/identity')).status,401);
  assert.equal((await f.call('/admin/identity',f.env.ADMIN_TOKEN,f.identity)).status,401);
  assert.equal((await f.call('/admin/enrollments',f.env.ISSUER_TOKEN,{})).status,401);
  assert.equal((await f.call('/admin/identity',f.env.ISSUER_TOKEN,{...f.identity,domain:'other.example'})).status,400);
  assert.equal((await f.call('/admin/identity',f.env.ISSUER_TOKEN,f.identity)).status,200);
  const status=await f.call('/admin/status',f.env.ISSUER_TOKEN);
  assert(!JSON.stringify(status.data).includes('pkcs12'));assert(!JSON.stringify(status.data).includes('Password'));
  const health=await f.call('/health');assert.equal(health.headers.get('cache-control'),'no-store');
  assert(!JSON.stringify(health.data).includes(f.identity.pkcs12Base64));
  assert.equal((await service.fetch(new Request('https://other.example/health'),f.env)).status,400);
});
test('activation atomically binds one device, retries are idempotent and revocation persists',async()=>{
  const f=fixture();await f.call('/admin/identity',f.env.ISSUER_TOKEN,f.identity);
  const enrollment=await f.call('/admin/enrollments',f.env.ADMIN_TOKEN,{expiresIn:3600});
  const {activationCode}=enrollment.data,deviceNonce='1'.repeat(64);
  const [a,b]=await Promise.all([f.call('/v1/activate',null,{activationCode,deviceNonce}),
    f.call('/v1/activate',null,{activationCode,deviceNonce:'2'.repeat(64)})]);
  // Request parsing and Web Crypto may finish in either order. Exactly one
  // device must win; subsequent requests must retain that device's binding.
  assert.deepEqual([a.status,b.status].sort(),[200,403]);
  const winner=a.status===200?a:b,winnerNonce=a.status===200?deviceNonce:'2'.repeat(64);
  const loserNonce=a.status===200?'2'.repeat(64):deviceNonce;
  const again=await f.call('/v1/activate',null,{activationCode,deviceNonce:winnerNonce});
  assert.equal(again.status,200);assert.equal(again.data.clientToken,winner.data.clientToken);
  assert.equal((await f.call('/v1/activate',null,{activationCode,deviceNonce:loserNonce})).status,403);
  assert.equal((await f.call('/v1/identity',winner.data.clientToken)).data.pkcs12Base64,f.identity.pkcs12Base64);
  assert(!JSON.stringify([...f.records]).includes(winner.data.clientToken),'only token hashes are stored');
  assert(!JSON.stringify([...f.records]).includes(activationCode),'activation code remains private');
  await f.call('/admin/clients/revoke',f.env.ADMIN_TOKEN,{clientId:winner.data.clientId});
  assert.equal((await f.call('/v1/identity',winner.data.clientToken)).status,401);
  assert.equal((await f.call('/v1/activate',null,{activationCode,deviceNonce:winnerNonce})).status,403);
});
test('DNS hook can modify only its own exact challenge and preserves externally changed records',async()=>{
  const f=fixture(),request={domain:f.env.DOMAIN,validation:'v'.repeat(43)};
  assert.equal((await f.call('/admin/challenge',f.env.ISSUER_TOKEN,{...request,domain:'littlepond.eu.org'})).status,400);
  assert.equal((await f.call('/admin/challenge',f.env.ADMIN_TOKEN,request)).status,401);
  await f.call('/admin/challenge',f.env.ISSUER_TOKEN,request);
  await f.call('/admin/challenge',f.env.ISSUER_TOKEN,request);assert.equal(f.dns.size,1);
  const record=[...f.dns.values()][0];assert.equal(record.name,'_acme-challenge.car.littlepond.eu.org');
  record.content='externally changed';
  assert.equal((await f.call('/admin/challenge/cleanup',f.env.ISSUER_TOKEN,request)).status,409);assert.equal(f.dns.size,1);
  record.content=request.validation;
  await f.call('/admin/challenge/cleanup',f.env.ISSUER_TOKEN,request);assert.equal(f.dns.size,0);
});
test('expired codes and certificates fail closed',async()=>{
  const f=fixture();assert.equal((await f.call('/admin/enrollments',f.env.ADMIN_TOKEN,{})).status,503);
  assert.equal((await f.call('/admin/identity',f.env.ISSUER_TOKEN,{...f.identity,notAfter:'2020-01-01T00:00:00Z'})).status,400);
  await f.call('/admin/identity',f.env.ISSUER_TOKEN,f.identity);
  const {data:{activationCode}}=await f.call('/admin/enrollments',f.env.ADMIN_TOKEN,{});
  const entry=[...f.records.entries()].find(([key])=>key.startsWith('enrollment:'));entry[1].expiresAt=0;
  assert.equal((await f.call('/v1/activate',null,{activationCode,deviceNonce:'1'.repeat(64)})).status,403);
});

test('an enrolled phone receives the next identity without another activation',async()=>{
  const f=fixture();await f.call('/admin/identity',f.env.ISSUER_TOKEN,f.identity);
  const {data:{activationCode}}=await f.call('/admin/enrollments',f.env.ADMIN_TOKEN,{});
  const activated=await f.call('/v1/activate',null,{activationCode,deviceNonce:'1'.repeat(64)});
  const token=activated.data.clientToken;
  const replacement={...f.identity,fingerprint:'e'.repeat(64),identityPassword:'replacement-private-password',
    pkcs12Base64:Buffer.concat([Buffer.from([0x30]),Buffer.alloc(300,2)]).toString('base64')};
  assert.equal((await f.call('/admin/identity',f.env.ISSUER_TOKEN,replacement)).status,200);
  const refreshed=await f.call('/v1/identity',token);
  assert.equal(refreshed.status,200);assert.equal(refreshed.data.fingerprint,replacement.fingerprint);
  assert.equal(refreshed.data.pkcs12Base64,replacement.pkcs12Base64);assert(!('clientToken' in refreshed.data));
  assert.equal((await f.call('/v1/identity',f.env.ISSUER_TOKEN)).status,401);
});
