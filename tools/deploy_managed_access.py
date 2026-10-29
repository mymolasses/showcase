#!/usr/bin/env python3
"""Deploy only the dedicated Showcase access service and its two hostnames.

Run with separately scoped DNS and short-lived deployment credentials. Secret
values travel over verified HTTPS or stdin/files and are never printed.
"""
from pathlib import Path
import argparse
import json
import os
import re
import secrets
import subprocess
import tempfile
from urllib.parse import urlencode

ROOT=Path(__file__).resolve().parents[1]
ACCOUNT='20cc5285076354b449d5ad6c21fd6cda'
ZONE='2eb27d3a335f8527bb443fc6ebe6546a'
DOMAIN='car.littlepond.eu.org'
SERVICE='setup.littlepond.eu.org'
SCRIPT='showcase-access'

def request(token,path,method='GET',value=None,forms=None):
    if not path.startswith(('/accounts/'+ACCOUNT+'/', '/zones/'+ZONE+'/')):
        raise ValueError('Unexpected Cloudflare resource')
    configuration='\n'.join(['url = '+json.dumps('https://api.cloudflare.com/client/v4'+path),
        'header = '+json.dumps('Authorization: Bearer '+token), 'request = '+json.dumps(method)])
    command=['curl.exe' if os.name=='nt' else 'curl','--silent','--show-error','--fail-with-body','--max-time','90','--config','-']
    with tempfile.TemporaryDirectory(prefix='showcase-cf-') as directory:
        if value is not None:
            body=Path(directory)/'request.json';body.write_text(json.dumps(value),encoding='utf-8');body.chmod(0o600)
            configuration+='\nheader = "Content-Type: application/json"'
            command+=['--data-binary','@'+str(body)]
        for name,filename,mime in forms or []:
            command+=['--form',name+'=@'+str(filename)+';type='+mime]
        result=subprocess.run(command,input=configuration,text=True,encoding='utf-8',capture_output=True)
    if result.returncode:
        # Do not echo request/response bodies: metadata can contain secrets.
        raise RuntimeError('Cloudflare API request failed for '+method+' '+path.split('?')[0])
    decoded=json.loads(result.stdout)
    if decoded.get('success') is not True:
        raise RuntimeError('Cloudflare rejected '+method+' '+path.split('?')[0])
    return decoded.get('result')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy-token-file',type=Path,required=True)
    parser.add_argument('--dns-token-file',type=Path,required=True)
    parser.add_argument('--private-directory',type=Path,required=True)
    parser.add_argument('--update-existing',action='store_true')
    args=parser.parse_args()
    deploy=args.deploy_token_file.read_text().strip();dns=args.dns_token_file.read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{30,256}',deploy) or not re.fullmatch(r'[A-Za-z0-9_-]{30,256}',dns):
        raise SystemExit('Invalid scoped Cloudflare credentials')
    target=args.private_directory.resolve()
    if not target.is_relative_to((ROOT/'.private').resolve()):
        raise SystemExit('Store service credentials only in this checkout private directory')
    target.mkdir(parents=True,exist_ok=True);target.chmod(0o700)
    private=target/'service.json'
    if private.exists():
        state=json.loads(private.read_text())
    else:
        state={key:secrets.token_hex(32) for key in ('ADMIN_TOKEN','ISSUER_TOKEN','TOKEN_KEY')}
        private.write_text(json.dumps(state));private.chmod(0o600)
    scripts=request(deploy,'/accounts/'+ACCOUNT+'/workers/scripts')
    exists=any(item.get('id')==SCRIPT for item in scripts)
    if exists and not args.update_existing:
        raise SystemExit('Service name exists; inspect before explicitly updating it')
    # Do not touch unrelated DNS names, existing applications or wildcard rules.
    records=request(dns,'/zones/'+ZONE+'/dns_records?'+urlencode({'name':DOMAIN}))
    if records and not (len(records)==1 and records[0]['type']=='A' and records[0]['content']=='99.99.99.99' and records[0]['proxied'] is False):
        raise SystemExit('Car hostname is already configured differently; no DNS changes made')
    service_records=request(dns,'/zones/'+ZONE+'/dns_records?'+urlencode({'name':SERVICE}))
    if service_records and not exists:
        raise SystemExit('Setup hostname is occupied; no service deployed')
    metadata={'main_module':'worker.mjs','compatibility_date':'2026-10-01','bindings':[
        {'type':'plain_text','name':'DOMAIN','text':DOMAIN},
        {'type':'plain_text','name':'SERVICE_HOST','text':SERVICE},
        {'type':'plain_text','name':'CF_ZONE_ID','text':ZONE},
        {'type':'secret_text','name':'CF_DNS_API_TOKEN','text':dns},
        {'type':'durable_object_namespace','name':'ACCESS','class_name':'ManagedAccess'},
        *({'type':'secret_text','name':key,'text':value} for key,value in state.items())],
        'observability':{'enabled':False}}
    if not exists:metadata['migrations']={'new_tag':'v1','new_sqlite_classes':['ManagedAccess']}
    with tempfile.TemporaryDirectory(prefix='showcase-deploy-') as directory:
        manifest=Path(directory)/'metadata.json';manifest.write_text(json.dumps(metadata));manifest.chmod(0o600)
        request(deploy,'/accounts/'+ACCOUNT+'/workers/scripts/'+SCRIPT,'PUT',forms=[
            ('metadata',manifest,'application/json'),('worker.mjs',ROOT/'managed-access/worker.mjs','application/javascript+module')])
    request(deploy,'/accounts/'+ACCOUNT+'/workers/domains','PUT',{'hostname':SERVICE,'service':SCRIPT,'enabled':True,'zone_id':ZONE})
    if not records:
        request(dns,'/zones/'+ZONE+'/dns_records','POST',{'type':'A','name':DOMAIN,'content':'99.99.99.99',
            'proxied':False,'ttl':60,'comment':'Showcase local hotspot entry'})
    print('Deployed dedicated service: https://'+SERVICE)
    print('DNS-only local CarPlay entry: https://'+DOMAIN)
    print('Credentials saved privately; no token or certificate was printed')

if __name__=='__main__':main()
