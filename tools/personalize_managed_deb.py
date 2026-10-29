#!/usr/bin/env python3
"""Create a private personal installer without recompiling signed binaries.

Never publish this output to a public Release or public Actions artifact: it
contains a one-use activation code, not a DNS token or certificate private key.
"""
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import sys
from urllib.request import Request
try:
    import build_browser_rootless as package
    from managed_certificate import read_json, ORIGIN, DOMAIN
except ModuleNotFoundError:
    from tools import build_browser_rootless as package
    from tools.managed_certificate import read_json, ORIGIN, DOMAIN

def personalize(base, output, enrollment):
    if base.resolve()==output.resolve():
        raise ValueError('Keep the verified base package unchanged')
    if enrollment.get('domain')!=DOMAIN or not re.fullmatch('[0-9a-f]{64}',enrollment.get('activationCode','')):
        raise ValueError('Unexpected activation response')
    expiry=datetime.fromisoformat(enrollment['expiresAt'].replace('Z','+00:00'))
    if expiry<=datetime.now(timezone.utc):
        raise ValueError('Expired activation')
    members=package.ar_members(base.read_bytes())
    payload=package.tar_members(members['data.tar.gz']);control=package.tar_members(members['control.tar.gz'])
    record=payload.get('var/jb/usr/share/showcase/browser-build.json')
    provenance=json.loads(record[1]) if record else None
    # Old signed builds ignore the activation profile. Require native updater
    # provenance instead of silently creating an installer that cannot renew.
    if not provenance or 'source/browser_managed_access.m' not in provenance.get('compiled_source_sha256',{}):
        raise ValueError('Base package has no compiled automatic certificate updater')
    profile={**enrollment,'serviceURL':ORIGIN,'activationId':hashlib.sha256(enrollment['activationCode'].encode()).hexdigest()}
    package.replace(payload,package.APP+'ShowcaseAccess.json',json.dumps(profile).encode(),0o600)
    md5=''.join(hashlib.md5(data).hexdigest()+'  '+name+'\n' for name,(member,data) in sorted(payload.items()) if member.isfile())
    package.replace(control,'md5sums',md5.encode(),0o644)
    output.parent.mkdir(parents=True,exist_ok=True)
    package.write_deb(output,control,payload)
    output.chmod(0o600)
    rebuilt=package.ar_members(output.read_bytes())
    package.validate_directory_order(rebuilt['data.tar.gz'])
    installed=package.tar_members(rebuilt['data.tar.gz'])
    original=package.tar_members(members['data.tar.gz'])
    for name,(member,data) in original.items():
        if installed[name][1]!=data or installed[name][0].mode!=member.mode:
            raise ValueError('Original runtime changed: '+name)
    if installed[package.APP+'ShowcaseAccess.json'][0].mode!=0o600:
        raise ValueError('Activation profile permissions are not private')
    rebuilt_control=package.tar_members(rebuilt['control.tar.gz'])
    for line in rebuilt_control['md5sums'][1].decode().splitlines():
        digest,name=line.split('  ',1)
        if hashlib.md5(installed[name][1]).hexdigest()!=digest:
            raise ValueError('Personal package integrity mismatch')
    checksum=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix+'.sha256').write_text(checksum+'  '+output.name+'\n')
    return checksum

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-deb',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--admin-token-file',type=Path,required=True)
    args=parser.parse_args()
    token=args.admin_token_file.read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}',token):raise SystemExit('Invalid managed admin credential')
    enrollment=read_json(Request(ORIGIN+'/admin/enrollments',data=json.dumps({'expiresIn':604800}).encode(),
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}))
    digest=personalize(args.base_deb,args.output,enrollment)
    print('Private personal installer:',args.output)
    print('Activation expires:',enrollment['expiresAt'])
    print('SHA256:',digest)

if __name__=='__main__':main()
