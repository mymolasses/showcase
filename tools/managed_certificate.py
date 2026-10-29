#!/usr/bin/env python3
"""Issue/renew one managed CarPlay identity. No private artifact is published.

The issuer credential can update only this service's DNS challenge and identity.
The full-zone Cloudflare credential stays in the service, never on the runner.
"""
from datetime import datetime, timezone
from pathlib import Path
import argparse
import base64
import json
import os
import re
import secrets
import shlex
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler

DOMAIN = 'car.littlepond.eu.org'
ORIGIN = 'https://setup.littlepond.eu.org'

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def read_json(request):
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            data = response.read(400001)
            if len(data) > 400000:
                raise RuntimeError('Response too large')
            return json.loads(data)
    except HTTPError as error:
        raise RuntimeError('Managed service returned HTTP ' + str(error.code)) from None

def api(path, value=None):
    token = os.environ.get('SHOWCASE_ISSUER_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('Missing managed issuer credential')
    return read_json(Request(ORIGIN + path,
        data=None if value is None else json.dumps(value).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}))

def challenge(cleanup=False):
    domain, validation = os.environ.get('CERTBOT_DOMAIN'), os.environ.get('CERTBOT_VALIDATION', '')
    if domain != DOMAIN or len(validation) != 43 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in validation):
        raise RuntimeError('Unexpected ACME identifier or validation')
    api('/admin/challenge' + ('/cleanup' if cleanup else ''), {'domain': domain, 'validation': validation})
    if cleanup:
        return
    url = 'https://cloudflare-dns.com/dns-query?' + urlencode({'name': '_acme-challenge.' + DOMAIN, 'type': 'TXT'})
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = read_json(Request(url, headers={'Accept': 'application/dns-json'}))
        if any(item.get('type') == 16 and item.get('data', '').replace('"', '') == validation for item in result.get('Answer', [])):
            return
        time.sleep(3)
    raise RuntimeError('DNS challenge did not propagate')

def renew(force=False):
    status = api('/admin/status')
    if status.get('domain') != DOMAIN:
        raise RuntimeError('Wrong managed domain')
    if status.get('notAfter'):
        expires = datetime.fromisoformat(status['notAfter'].replace('Z', '+00:00'))
        if not force and (expires - datetime.now(timezone.utc)).total_seconds() > 35 * 86400:
            print('Managed certificate is valid; renewal is not due')
            return
    with tempfile.TemporaryDirectory(prefix='showcase-certificate-') as work:
        root = Path(work)
        hook = shlex.quote(sys.executable) + ' ' + shlex.quote(str(Path(__file__).resolve()))
        certbot = [os.environ['SHOWCASE_CERTBOT_BIN']] if os.environ.get('SHOWCASE_CERTBOT_BIN') else [sys.executable, '-m', 'certbot']
        subprocess.run([*certbot, 'certonly', '--non-interactive', '--agree-tos',
            '--register-unsafely-without-email', '--manual', '--preferred-challenges', 'dns',
            '--manual-auth-hook', hook + ' --hook-auth', '--manual-cleanup-hook', hook + ' --hook-cleanup',
            '--key-type', 'rsa', '--rsa-key-size', '2048', '-d', DOMAIN,
            '--config-dir', str(root/'config'), '--work-dir', str(root/'work'), '--logs-dir', str(root/'logs')], check=True)
        live = root/'config/live'/DOMAIN
        # Verify real hostname and public trust before publishing anything.
        subprocess.run(['openssl', 'verify', '-verify_hostname', DOMAIN, '-untrusted', str(live/'chain.pem'), str(live/'cert.pem')], check=True)
        expiry = subprocess.check_output(['openssl', 'x509', '-in', str(live/'cert.pem'), '-noout', '-enddate'], text=True).strip().split('=', 1)[1]
        expires = datetime.strptime(expiry, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
        fingerprint = subprocess.check_output(['openssl', 'x509', '-in', str(live/'cert.pem'), '-noout', '-fingerprint', '-sha256'], text=True).strip().split('=', 1)[1].replace(':', '').lower()
        password = secrets.token_urlsafe(32)
        environment = {**os.environ, 'SHOWCASE_P12_PASSWORD': password}
        version = subprocess.check_output(['openssl', 'version'], text=True)
        major = re.search(r'OpenSSL\s+(\d+)', version)
        legacy = ['-legacy'] if major and int(major.group(1)) >= 3 else []
        subprocess.run(['openssl', 'pkcs12', '-export', *legacy, '-inkey', str(live/'privkey.pem'),
            '-in', str(live/'cert.pem'), '-certfile', str(live/'chain.pem'), '-out', str(root/'identity.p12'),
            '-passout', 'env:SHOWCASE_P12_PASSWORD'], check=True, env=environment)
        result = api('/admin/identity', {'domain': DOMAIN, 'notAfter': expires.isoformat(), 'fingerprint': fingerprint,
            'identityPassword': password, 'pkcs12Base64': base64.b64encode((root/'identity.p12').read_bytes()).decode()})
        if result.get('ok') is not True:
            raise RuntimeError('Managed certificate publication failed')
        print('Published managed certificate; expires ' + expires.date().isoformat())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hook-auth', action='store_true')
    parser.add_argument('--hook-cleanup', action='store_true')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.hook_auth or args.hook_cleanup:
        challenge(args.hook_cleanup)
    else:
        renew(args.force)

if __name__ == '__main__':
    main()
