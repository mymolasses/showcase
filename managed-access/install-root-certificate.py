#!/usr/bin/env python3
"""Validate and install the original site's renewed certificate, then reload Nginx.

Both existing ACME clients may call this handler. Private keys never leave the
server. All writes target the user's original certificate directory, with a
private backup and rollback if Nginx rejects the replacement.
"""
from pathlib import Path
from datetime import datetime,timezone
import argparse
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import uuid

DOMAIN='littlepond.eu.org'
DEST=Path('/etc/v2ray-agent/tls')
LOCK=Path('/run/lock/showcase-root-certificate.lock')
SOURCES={'certbot':(Path('/etc/letsencrypt/live')/DOMAIN/'fullchain.pem',Path('/etc/letsencrypt/live')/DOMAIN/'privkey.pem'),
         'acme':(Path('/var/lib/showcase-root-acme/fullchain.pem'),Path('/var/lib/showcase-root-acme/privkey.pem'))}

def run(arguments):
    p=subprocess.run(arguments,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30)
    if p.returncode:raise RuntimeError('Certificate validation or service command failed: '+arguments[0])
    return p.stdout.strip()

def metadata(path):
    fields={line.split('=',1)[0]:line.split('=',1)[1] for line in run(['openssl','x509','-in',str(path),'-noout','-startdate','-enddate']).splitlines() if '=' in line}
    return {key:datetime.strptime(value,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc) for key,value in fields.items()}

def activate_nginx():
    run(['/usr/sbin/nginx','-t'])
    active=subprocess.run(['systemctl','is-active','--quiet','nginx'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    run(['systemctl','reload' if active else 'start','nginx'])
    return 'reloaded' if active else 'started'

def replace(path,data,previous):
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as file:
            os.fchmod(file.fileno(),stat.S_IMODE(previous.st_mode));os.fchown(file.fileno(),previous.st_uid,previous.st_gid)
            file.write(data);file.flush();os.fsync(file.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

def install(source,dry_run=False):
    cert,key=SOURCES[source]
    run(['openssl','verify','-verify_hostname',DOMAIN,'-untrusted',str(cert),str(cert)])
    run(['openssl','x509','-in',str(cert),'-noout','-checkend','86400'])
    cert_public=run(['openssl','x509','-in',str(cert),'-pubkey','-noout'])
    key_public=run(['openssl','pkey','-in',str(key),'-pubout'])
    if cert_public!=key_public:raise RuntimeError('Certificate and private key do not match')
    incoming=metadata(cert)
    active_cert=DEST/(DOMAIN+'.crt');active_key=DEST/(DOMAIN+'.key')
    with LOCK.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if active_cert.exists() and metadata(active_cert)['notBefore']>incoming['notBefore']:
            if not dry_run:activate_nginx()
            print('A newer certificate is already installed; preserved it');return
        if dry_run:
            print('PASS: hostname, public trust, lifetime and key pairing; no certificate files changed');return
        originals={p:(p.read_bytes(),p.stat()) for p in [active_cert,active_key]}
        backup=Path('/var/backups/showcase-root-certificates')/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8])
        backup.mkdir(parents=True,mode=0o700)
        for p,(content,info) in originals.items():
            target=backup/p.name;target.write_bytes(content);target.chmod(0o600)
        try:
            replace(active_key,key.read_bytes(),originals[active_key][1])
            replace(active_cert,cert.read_bytes(),originals[active_cert][1])
            action=activate_nginx()
        except Exception:
            for p,(content,info) in originals.items():replace(p,content,info)
            activate_nginx();raise
        fingerprint=run(['openssl','x509','-in',str(active_cert),'-noout','-fingerprint','-sha256']).split('=',1)[1].replace(':','').lower()
        record={'source':source,'domain':DOMAIN,'notAfter':incoming['notAfter'].isoformat(),'fingerprint':fingerprint,
                'destination':str(DEST),'backup':str(backup),'nginxAction':action}
        (backup/'deployment.json').write_text(json.dumps(record,indent=2))
        print(json.dumps(record))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',choices=SOURCES)
    parser.add_argument('--dry-run',action='store_true');args=parser.parse_args();install(args.source,args.dry_run)
