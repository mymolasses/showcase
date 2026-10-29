#!/usr/bin/env python3
"""Seed and smoke-test the dedicated private identity service without secret logs."""
from pathlib import Path
import argparse
import base64
import hashlib
import json
import secrets
from urllib.request import Request
from managed_certificate import read_json, ORIGIN, DOMAIN

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['seed','status','smoke-test'])
    parser.add_argument('--service-state',type=Path,default=ROOT/'.private/managed-service/service.json')
    parser.add_argument('--identity-directory',type=Path,default=ROOT/'.private/personal-tls')
    args=parser.parse_args();state=json.loads(args.service_state.read_text())
    def call(path,role='ISSUER_TOKEN',value=None,token=None):
        credential=token or state[role]
        return read_json(Request(ORIGIN+path,data=None if value is None else json.dumps(value).encode(),
            headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'}))
    if args.action=='seed':
        config=json.loads((args.identity_directory/'browser-web.json').read_text())
        metadata=json.loads((args.identity_directory/'certificate-metadata.json').read_text())
        if config.get('domain')!=DOMAIN or metadata.get('domain')!=DOMAIN or not metadata.get('trustedChainVerified'):
            raise ValueError('Expected verified personal domain identity')
        value={'domain':DOMAIN,'identityPassword':config['identityPassword'],'notAfter':metadata['notAfter'],
            'fingerprint':metadata['sha256Fingerprint'],'pkcs12Base64':base64.b64encode((args.identity_directory/'browser-server.p12').read_bytes()).decode()}
        result=call('/admin/identity',value=value)
        if result.get('ok') is not True:raise RuntimeError('Identity seed failed')
        print('Seeded verified personal identity; expires '+result['notAfter'])
    elif args.action=='status':print(json.dumps(call('/admin/status')))
    else:
        enrollment=call('/admin/enrollments','ADMIN_TOKEN',{'expiresIn':900})
        activation={'activationCode':enrollment['activationCode'],'deviceNonce':secrets.token_hex(32)}
        identity=read_json(Request(ORIGIN+'/v1/activate',data=json.dumps(activation).encode(),headers={'Content-Type':'application/json'}))
        token=identity['clientToken'];client_id=identity['clientId']
        try:
            again=read_json(Request(ORIGIN+'/v1/activate',data=json.dumps(activation).encode(),headers={'Content-Type':'application/json'}))
            if again['clientToken']!=token:raise RuntimeError('Activation retry changed device credentials')
            current=call('/v1/identity',token=token)
            if current['domain']!=DOMAIN or current['fingerprint']!=identity['fingerprint'] or current['pkcs12Base64']!=identity['pkcs12Base64']:
                raise RuntimeError('Authenticated identity response mismatch')
            from cryptography import x509
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.serialization import pkcs12
            key,certificate,chain=pkcs12.load_key_and_certificates(base64.b64decode(current['pkcs12Base64']),current['identityPassword'].encode())
            names=certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
            if names!=[DOMAIN] or not chain or key.public_key().public_numbers()!=certificate.public_key().public_numbers() or certificate.fingerprint(hashes.SHA256()).hex()!=current['fingerprint']:
                raise RuntimeError('Downloaded certificate/key identity mismatch')
            print('PASS: real HTTPS activation, idempotent device binding, authenticated download and matching real P12 identity')
        finally:call('/admin/clients/revoke','ADMIN_TOKEN',{'clientId':client_id})
        try:call('/v1/identity',token=token)
        except RuntimeError as error:
            if 'HTTP 401' not in str(error):raise
        else:raise RuntimeError('Revoked test credential still works')
        print('PASS: disposable test client revoked; certificate contents and credentials were not printed')
if __name__=='__main__':main()
