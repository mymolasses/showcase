#!/usr/bin/env python3
"""Deploy the dedicated control plane on the existing AssppWeb VPS.

Requires the approved zone DNS credential and a one-use private SSH connection
file. Existing application containers and root-domain certificate files are not
rewritten. Timer enablement happens separately after live renewal verification.
"""
from pathlib import Path
import argparse
import json
import re
import secrets
import shlex
import sys
import time
import uuid
from urllib.parse import urlencode
from deploy_managed_access import request, ZONE, DOMAIN, SERVICE

ROOT=Path(__file__).resolve().parents[1]
ADDRESS='64.64.254.90'
CODE='/opt/showcase-access'
STATE='/var/lib/showcase-access'
PRIVATE='/etc/showcase-access'
CONF='/etc/nginx/conf.d/showcase-access.conf'
CONTAINER='showcase-access'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-credential-file',type=Path,required=True)
    parser.add_argument('--dns-token-file',type=Path,required=True)
    parser.add_argument('--known-hosts',type=Path,default=ROOT/'.private/original-server-known-hosts')
    parser.add_argument('--ssh-python-directory',type=Path,default=Path.home()/'Documents/ChatGPT/asspp/.login-tools/ssh-python')
    parser.add_argument('--update-existing',action='store_true')
    args=parser.parse_args()
    token=args.dns_token_file.read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{30,256}',token):raise ValueError('Invalid scoped DNS credential')
    connection=json.loads(args.ssh_credential_file.read_text());args.ssh_credential_file.unlink()
    if connection.get('host')!=ADDRESS or connection.get('port')!=29133 or connection.get('username')!='root':
        raise ValueError('Unexpected existing server')
    sys.path.insert(0,str(args.ssh_python_directory));import paramiko
    client=paramiko.SSHClient();client.load_host_keys(str(args.known_hosts));client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(ADDRESS,port=connection['port'],username=connection['username'],password=connection['password'],
        look_for_keys=False,allow_agent=False,timeout=20,auth_timeout=20)
    sftp=client.open_sftp()
    def remote(command,timeout=60):
        stdin,stdout,stderr=client.exec_command(command,timeout=timeout)
        output=stdout.read().decode();error=stderr.read().decode();status=stdout.channel.recv_exit_status()
        if status:raise RuntimeError('Remote deployment step failed: '+command.splitlines()[0]+'\n'+error[-1500:])
        return output.strip()
    def exists(name):
        try:sftp.stat(name);return True
        except FileNotFoundError:return False
    def read(name):
        with sftp.open(name,'rb') as file:return file.read()
    def write(name,data,mode=0o644):
        temp=name+'.new-'+uuid.uuid4().hex
        with sftp.open(temp,'wx') as file:
            sftp.chmod(temp,mode);file.write(data if isinstance(data,bytes) else data.encode());file.flush()
        sftp.posix_rename(temp,name)
    def nginx_apply(value):
        previous=read(CONF) if exists(CONF) else None
        write(CONF,value)
        try:remote('nginx -t && systemctl reload nginx')
        except Exception:
            if previous is None:sftp.remove(CONF)
            else:write(CONF,previous)
            remote('nginx -t && systemctl reload nginx')
            raise
    try:
        remote('nginx -t')
        marker=PRIVATE+'/owner.json'
        occupied=any(exists(p) for p in [CODE,STATE,PRIVATE,CONF])
        if occupied:
            if not args.update_existing or not exists(marker) or json.loads(read(marker)).get('service')!='Showcase managed access':
                raise ValueError('Service namespace occupied; inspect before updating')
        before=remote("docker inspect --format '{{.Id}}' asspp-web-asspp-1")
        image=remote("docker inspect --format '{{.Image}}' asspp-web-asspp-1")
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('Unexpected installed runtime image')
        if not occupied and remote("ss -H -ltn 'sport = :18781'"):
            raise ValueError('Control-plane loopback port is occupied')
        car=request(token,'/zones/'+ZONE+'/dns_records?'+urlencode({'name':DOMAIN}))
        if not (len(car)==1 and car[0]['type']=='A' and car[0]['content']=='99.99.99.99' and not car[0]['proxied']):
            raise ValueError('Car entry no longer matches the approved local address')
        setup=request(token,'/zones/'+ZONE+'/dns_records?'+urlencode({'name':SERVICE}))
        if setup and not (len(setup)==1 and setup[0]['type']=='A' and setup[0]['content']==ADDRESS and not setup[0]['proxied']):
            raise ValueError('Setup hostname is already configured differently')
        local=ROOT/'.private/managed-service';local.mkdir(parents=True,exist_ok=True)
        credentials=local/'service.json'
        if credentials.exists():keys=json.loads(credentials.read_text())
        else:
            keys={name:secrets.token_hex(32) for name in ['ADMIN_TOKEN','ISSUER_TOKEN','TOKEN_KEY']}
            credentials.write_text(json.dumps(keys));credentials.chmod(0o600)
        if any(not re.fullmatch('[a-f0-9]{64}',keys.get(name,'')) for name in ['ADMIN_TOKEN','ISSUER_TOKEN','TOKEN_KEY']):
            raise ValueError('Invalid private service state')
        remote('install -d -m 0755 '+CODE+' /var/lib/showcase-acme/.well-known/acme-challenge; install -d -m 0700 '+PRIVATE+' '+STATE+'; chown 10001:10001 '+STATE)
        write(marker,json.dumps({'service':'Showcase managed access','domain':DOMAIN,'setup':SERVICE}),0o600)
        for source,target in [('managed-access/worker.mjs','worker.mjs'),('managed-access/node-server.mjs','node-server.mjs'),('tools/managed_certificate.py','managed_certificate.py')]:
            write(CODE+'/'+target,(ROOT/source).read_bytes())
        environment={'DOMAIN':DOMAIN,'SERVICE_HOST':SERVICE,'CF_ZONE_ID':ZONE,'CF_DNS_API_TOKEN':token,
            'STATE_DIR':'/state','LISTEN_HOST':'0.0.0.0','PORT':'8787',**keys}
        write(PRIVATE+'/service.env','\n'.join(k+'='+v for k,v in environment.items())+'\n',0o600)
        write(PRIVATE+'/issuer.env','SHOWCASE_ISSUER_TOKEN='+keys['ISSUER_TOKEN']+'\n',0o600)
        existing=remote("docker container ls -a --filter name=^/showcase-access$ --format '{{.Names}}'")
        if existing:
            label=remote("docker inspect --format '{{index .Config.Labels \"com.showcase.managed-access\"}}' "+CONTAINER)
            if label!='true':raise ValueError('Container name belongs to a different service')
            remote('docker rm -f '+CONTAINER)
        command=['docker','run','--detach','--name',CONTAINER,'--restart','unless-stopped','--user','10001:10001',
            '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','0.5','--pids-limit','64',
            '--label','com.showcase.managed-access=true','--env-file',PRIVATE+'/service.env','-p','127.0.0.1:18781:8787',
            '-v',CODE+':/srv:ro','-v',STATE+':/state:rw','--entrypoint','/usr/local/bin/node',image,'/srv/node-server.mjs']
        remote(' '.join(shlex.quote(value) for value in command))
        for attempt in range(20):
            try:
                health=json.loads(remote("curl --fail --silent --max-time 3 -H 'Host: "+SERVICE+"' http://127.0.0.1:18781/health"))
                if health.get('domain')==DOMAIN:break
            except RuntimeError:
                if attempt==19:raise
                time.sleep(0.5)
        cert='/etc/letsencrypt/live/'+SERVICE+'/fullchain.pem'
        final=(ROOT/'managed-access/vps-nginx.conf').read_text()
        if not exists(cert):
            http_only=final[:final.index('\nserver {',final.index('server {')+1)]+'\n'
            nginx_apply(http_only)
        if not setup:
            request(token,'/zones/'+ZONE+'/dns_records','POST',{'type':'A','name':SERVICE,'content':ADDRESS,
                'proxied':False,'ttl':60,'comment':'Showcase certificate updates on existing VPS'})
        if not exists(cert):
            remote('certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot -w /var/lib/showcase-acme --cert-name '+SERVICE+' -d '+SERVICE,timeout=180)
        nginx_apply(final)
        remote('install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy')
        write('/etc/letsencrypt/renewal-hooks/deploy/showcase-access-nginx',(ROOT/'managed-access/vps-nginx-renew-hook.sh').read_bytes(),0o755)
        write('/etc/systemd/system/showcase-certificate-renew.service',(ROOT/'managed-access/vps-renew.service').read_bytes())
        write('/etc/systemd/system/showcase-certificate-renew.timer',(ROOT/'managed-access/vps-renew.timer').read_bytes())
        remote('systemctl daemon-reload')
        if remote("docker inspect --format '{{.Id}}' asspp-web-asspp-1")!=before:
            raise RuntimeError('Existing AssppWeb container changed during deployment; inspect concurrent activity')
        health=json.loads(remote('curl --fail --silent --max-time 15 https://'+SERVICE+'/health'))
        if health.get('domain')!=DOMAIN:raise RuntimeError('Public HTTPS health check did not match')
        print('Dedicated VPS control plane ready at https://'+SERVICE)
        print('Existing AssppWeb container preserved; certificate contents and credentials not printed')
        print('Renewal timer installed but not enabled: seed and exercise real renewal before enabling it')
    finally:sftp.close();client.close()
if __name__=='__main__':main()
