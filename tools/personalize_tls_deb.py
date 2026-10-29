#!/usr/bin/env python3
"""Add a personal HTTPS identity to the verified 1.5.0 package.

The signed application binaries stay byte-for-byte unchanged. Output contains a
certificate private key and must stay private, outside public Releases/artifacts.
Requires cryptography for PKCS#12 validation; all input/output paths are explicit.
"""
from pathlib import Path
import argparse
import hashlib
import json
import plistlib
from cryptography import x509
from cryptography.hazmat.primitives.serialization import pkcs12
import build_browser_rootless as package

BASE_SHA256 = 'c202650d8254290b3b25ef41df61419c703164f05edcfa08fb062af532c2b43c'
DOMAIN = 'car.littlepond.eu.org'
STAGE = 'var/jb/usr/share/showcase/personal-tls/'

INSTALL = '''
# Personal HTTPS provisioning: the identity never enters the signed app bundle.
PERSONAL_TLS="/var/jb/usr/share/showcase/personal-tls"
PERSONAL_DST="/var/mobile/Library/Showcase"
if [ ! -d "$PERSONAL_DST" ]; then
    mkdir -p "$PERSONAL_DST"
    chmod 0700 "$PERSONAL_DST"
    chown 501:501 "$PERSONAL_DST"
fi
for file in browser-server.p12 browser-web.json; do
    if [ -f "$PERSONAL_DST/$file" ] && [ ! -e "$PERSONAL_DST/$file.before-personal" ]; then
        cp "$PERSONAL_DST/$file" "$PERSONAL_DST/$file.before-personal"
        chmod 0600 "$PERSONAL_DST/$file.before-personal"
        chown 501:501 "$PERSONAL_DST/$file.before-personal"
    fi
    cp "$PERSONAL_TLS/$file" "$PERSONAL_DST/$file.next"
    chmod 0600 "$PERSONAL_DST/$file.next"
    chown 501:501 "$PERSONAL_DST/$file.next"
    mv -f "$PERSONAL_DST/$file.next" "$PERSONAL_DST/$file"
done
'''

def personalize(base: Path, identity_dir: Path, output: Path):
    if output.resolve() == base.resolve():
        raise ValueError('Do not replace the verified base package')
    raw = base.read_bytes()
    if hashlib.sha256(raw).hexdigest() != BASE_SHA256:
        raise ValueError('Expected the verified 1.5.0 / 1015 package')
    config_data = (identity_dir / 'browser-web.json').read_bytes()
    config = json.loads(config_data)
    if config.get('domain') != DOMAIN or len(config.get('identityPassword', '')) < 16:
        raise ValueError('Unexpected personal identity configuration')
    identity_data = (identity_dir / 'browser-server.p12').read_bytes()
    key, leaf, chain = pkcs12.load_key_and_certificates(identity_data, config['identityPassword'].encode())
    if not key or not leaf or not chain:
        raise ValueError('Incomplete identity')
    names = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    if names != [DOMAIN] or key.public_key().public_numbers() != leaf.public_key().public_numbers():
        raise ValueError('Identity hostname/key mismatch')
    metadata = json.loads((identity_dir / 'certificate-metadata.json').read_text())
    if not metadata.get('trustedChainVerified') or metadata.get('domain') != DOMAIN:
        raise ValueError('Run trusted-chain verification before packaging')
    members = package.ar_members(raw)
    original = package.tar_members(members['data.tar.gz'])
    payload = package.tar_members(members['data.tar.gz'])
    control = package.tar_members(members['control.tar.gz'])
    info = plistlib.loads(payload[package.APP + 'Info.plist'][1])
    if info['CFBundleShortVersionString'] != '1.5.0' or str(info['CFBundleVersion']) != '1015':
        raise ValueError('Unexpected application version')
    for name, data in [('browser-server.p12', identity_data), ('browser-web.json', config_data)]:
        package.replace(payload, STAGE + name, data, 0o600)
    package.replace(payload, STAGE + 'certificate-metadata.json', json.dumps(metadata, indent=2).encode(), 0o600)
    script = control['postinst'][1].decode()
    if not script.rstrip().endswith('exit 0'):
        raise ValueError('Unexpected install script')
    script = script.rstrip()[:-len('exit 0')] + INSTALL + '\nexit 0\n'
    package.replace(control, 'postinst', script.encode(), 0o755)
    md5 = ''.join(hashlib.md5(data).hexdigest() + '  ' + name + '\n'
        for name, (member, data) in sorted(payload.items()) if member.isfile())
    package.replace(control, 'md5sums', md5.encode(), 0o644)
    output.parent.mkdir(parents=True, exist_ok=True)
    package.write_deb(output, control, payload)
    output.chmod(0o600)
    result = package.ar_members(output.read_bytes())
    package.validate_directory_order(result['data.tar.gz'])
    installed = package.tar_members(result['data.tar.gz'])
    for name, (member, data) in original.items():
        if installed[name][1] != data or installed[name][0].mode != member.mode:
            raise ValueError('Original runtime changed: ' + name)
    for name in ['browser-server.p12', 'browser-web.json', 'certificate-metadata.json']:
        if installed[STAGE + name][0].mode != 0o600:
            raise ValueError('Personal material must have mode 0600')
    readback = package.tar_members(result['control.tar.gz'])
    if readback['postinst'][1].count(INSTALL.encode()) != 1:
        raise ValueError('Provisioning install hook missing or duplicated')
    for line in readback['md5sums'][1].decode().splitlines():
        digest, name = line.split('  ', 1)
        if hashlib.md5(installed[name][1]).hexdigest() != digest:
            raise ValueError('Package integrity mismatch: ' + name)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(digest + '  ' + output.name + '\n')
    report = {**metadata, 'basePackageSha256': BASE_SHA256, 'personalPackageSha256': digest,
        'version': '1.5.0', 'build': '1015', 'nativeBinariesUnchanged': True,
        'privateMaterialMode': '0600', 'certificateRenewalAutomatic': False,
        'hardwareTested': False, 'entryURL': 'https://' + DOMAIN + '/'}
    output.with_name('personal-package-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-deb', type=Path, required=True)
    parser.add_argument('--identity-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    personalize(args.base_deb, args.identity_dir, args.output)
