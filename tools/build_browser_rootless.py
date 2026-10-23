#!/usr/bin/env python3
"""Build an iOS 16.2+ rootless browser-prototype deb on macOS, without SSH.

The verified upstream deb supplies the unchanged BTstack runtime.
The modified UI/network service are compiled from this checkout and ad-hoc
signed with their entitlements; postinst re-signs with on-device ldid and stops the probe on removal.
Only Python's standard library and Xcode command-line tools are required.
"""
import argparse
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_SHA256 = 'f91ab0bf7ddf94d9eb1eacc56db37e8943ea8f1dce60c4976f793d679707a1d6'
UPSTREAM_URL = ('https://github.com/amineross/showcase/releases/download/v1.0-beta5-2/'
                'com.rostane.showcase_1.0.beta5-2_iphoneos-arm64.deb')
APP = 'var/jb/Applications/Showcase.app/'
VERSION = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
BUILD_NUMBER = (ROOT / 'BUILD_NUMBER').read_text(encoding='utf-8').strip()
DISPLAY_NAME = plistlib.loads((ROOT / 'source/Info.plist').read_bytes())['CFBundleDisplayName']
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', VERSION):
    raise ValueError('VERSION must use major.minor.patch')
if not BUILD_NUMBER.isdigit() or int(BUILD_NUMBER) < 1:
    raise ValueError('BUILD_NUMBER must be a positive increasing integer')
NAME = 'com.rostane.showcase_' + VERSION + '_iphoneos-arm64.deb'


def run(arguments, capture=False):
    return subprocess.run(arguments, check=True, cwd=ROOT, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def ar_members(data):
    if not data.startswith(b'!<arch>\n'):
        raise ValueError('Not a Debian ar archive')
    at, result = 8, {}
    while at < len(data):
        header = data[at:at + 60]
        if len(header) != 60 or header[58:60] != b'`\n':
            raise ValueError('Malformed ar header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58])
        if size < 0 or at + 60 + size > len(data) or name in result:
            raise ValueError('Invalid ar member')
        result[name] = data[at + 60:at + 60 + size]
        at += 60 + size + size % 2
    if at != len(data):
        raise ValueError('Truncated ar archive')
    return result


def tar_members(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for member in archive:
            name = member.name.removeprefix('./') if hasattr(str, 'removeprefix') else member.name[2:] if member.name.startswith('./') else member.name
            if not name or name == '.':
                continue
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or name in result:
                raise ValueError('Unsafe/duplicate tar member: ' + name)
            if not (member.isfile() or member.isdir()):
                raise ValueError('Unexpected non-regular runtime member: ' + name)
            result[name.rstrip('/')] = (copy.copy(member), archive.extractfile(member).read() if member.isfile() else None)
    return result


def tar_gz(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.GNU_FORMAT) as archive:
        for name, (member, data) in sorted(entries.items()):
            member = copy.copy(member)
            member.name = './' + name
            member.uid = member.gid = 0
            member.uname, member.gname = 'root', 'wheel'
            member.mtime = 0
            member.pax_headers = {}
            member.size = len(data) if data is not None else 0
            archive.addfile(member, io.BytesIO(data) if data is not None else None)
    return gzip.compress(buffer.getvalue(), compresslevel=9, mtime=0)


def write_deb(path, control, payload):
    output = bytearray(b'!<arch>\n')
    for name, data in [('debian-binary', b'2.0\n'), ('control.tar.gz', tar_gz(control)), ('data.tar.gz', tar_gz(payload))]:
        # Debian packages use the simple ar name field, without GNU '/' suffix.
        header = f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode('ascii')
        assert len(header) == 60
        output.extend(header); output.extend(data)
        if len(data) % 2:
            output.extend(b'\n')
    path.write_bytes(output)


def replace(entries, name, data, mode=None):
    member = copy.copy(entries[name][0]) if name in entries else tarfile.TarInfo(name)
    if mode is not None:
        member.mode = mode
    entries[name] = member, data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream-deb', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/browser-rootless')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('This builder requires macOS and the Xcode iPhoneOS SDK.')
    raw = args.upstream_deb.read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA256:
        raise SystemExit('Upstream deb SHA-256 mismatch; refusing to reuse runtime.')
    archive = ar_members(raw)
    control = tar_members(archive['control.tar.gz'])
    payload = tar_members(archive['data.tar.gz'])
    old_control = control['control'][1].decode()
    if 'Architecture: iphoneos-arm64\n' not in old_control or 'Package: com.rostane.showcase\n' not in old_control:
        raise SystemExit('Expected the upstream Showcase rootless package.')
    if any(not (name == 'var' or name.startswith('var/jb')) for name in payload):
        raise SystemExit('Unexpected payload outside the rootless /var/jb layout.')
    args.output.mkdir(parents=True, exist_ok=True)
    run([sys.executable, 'tools/embed_browser.py'])
    sdk = run(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], True).strip()
    compiler = run(['xcrun', '--sdk', 'iphoneos', 'clang', '--version'], True).splitlines()[0]
    revision = run(['git', 'rev-parse', 'HEAD'], True).strip()
    source_paths = ['source/Showcase.m', 'source/carplay_services.m', 'source/browser_bridge.m',
                    'source/browser_bridge.h', 'source/browser_settings.h', 'source/browser_assets.h',
                    'source/browser_network.c', 'source/browser_network.h', 'source/browser_probe.m',
                    'source/browser_web_tls.m', 'source/browser_web_tls.h',
                    'packaging/control-rootless/postinst', 'packaging/control-rootless/prerm',
                    'source/carplay_pair.c', 'source/carplay_pair.h', 'source/baa_broker.h']
    provenance = {'package': 'com.rostane.showcase', 'version': VERSION,
                  'display_name': DISPLAY_NAME, 'build_number': BUILD_NUMBER,
                  'architecture': 'iphoneos-arm64', 'macho_architecture': 'arm64',
                  'deployment_target': '16.2', 'jailbreak_layout': 'Dopamine rootless /var/jb',
                  'source_repository': 'https://github.com/mymolasses/showcase', 'source_commit': revision,
                  'compiler': compiler, 'sdk': Path(sdk).name,
                  'upstream_runtime': {'url': UPSTREAM_URL, 'sha256': UPSTREAM_SHA256},
                  'compiled_source_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_paths}}
    unchanged = [APP + 'CarDisplaySim', 'var/jb/usr/bin/BTdaemon', 'var/jb/usr/lib/libBTstack.dylib']
    provenance['unchanged_runtime_sha256'] = {name: hashlib.sha256(payload[name][1]).hexdigest() for name in unchanged}
    with tempfile.TemporaryDirectory(prefix='showcase-rootless-build-') as directory:
        work = Path(directory)
        flags = ['xcrun', '--sdk', 'iphoneos', 'clang', '-target', 'arm64-apple-ios16.2',
                 '-fobjc-arc', '-DSHOWCASE_ROOTLESS=1', '-O2', '-Wno-deprecated-declarations',
                 '-DSHOWCASE_RELEASE_VERSION="' + VERSION + '"', '-DSHOWCASE_BUILD_NUMBER="' + BUILD_NUMBER + '"']
        ui = work / 'Showcase'
        service = work / 'CarPlay Simulator'
        probe = work / 'ShowcaseNet'
        run(flags + ['-DAPP_NAME="' + DISPLAY_NAME + '"', '-DAPP_VERSION="' + VERSION + '"', '-DPACKAGE_VERSION="' + VERSION + '"',
                     'source/Showcase.m', '-framework', 'UIKit', '-framework', 'AVFoundation',
                     '-framework', 'AudioToolbox', '-framework', 'CoreMedia', '-framework', 'Foundation',
                     '-framework', 'Security', '-Wl,-undefined,dynamic_lookup', '-o', str(ui)])
        run(flags + ['source/carplay_services.m', 'source/browser_bridge.m', 'source/carplay_pair.c',
                     'source/vendor/monocypher/monocypher.c', 'source/vendor/monocypher/monocypher-ed25519.c',
                     'source/vendor/libtommath/tommath.c', '-framework', 'Foundation', '-framework', 'Security',
                     '-Wl,-undefined,dynamic_lookup', '-o', str(service)])
        run(flags + ['source/browser_probe.m', 'source/browser_network.c', 'source/browser_web_tls.m',
                     '-framework', 'Foundation', '-framework', 'Security', '-o', str(probe)])
        for binary, ent in [(ui, 'ent_app.xml'), (service, 'ent_svc.xml'), (probe, 'ent_svc.xml')]:
            run(['codesign', '--force', '--sign', '-', '--timestamp=none', '--generate-entitlement-der',
                 '--entitlements', str(ROOT / 'source' / ent), str(binary)])
            run(['codesign', '--verify', '--strict', str(binary)])
            dependencies = run(['otool', '-L', str(binary)], True)
            if '/Users/' in dependencies or '/tmp/' in dependencies or '@rpath' in dependencies:
                raise SystemExit('Build-host dependency in iOS binary: ' + dependencies)
            if run(['lipo', '-archs', str(binary)], True).strip() != 'arm64':
                raise SystemExit('Expected arm64 executable')
            load_commands = run(['otool', '-l', str(binary)], True)
            if 'minos 16.2' not in load_commands:
                raise SystemExit('Missing iOS 16.2 deployment target')
        replace(payload, APP + 'Showcase', ui.read_bytes(), 0o4755)
        replace(payload, APP + 'CarPlay Simulator', service.read_bytes(), 0o4755)
        replace(payload, APP + 'ShowcaseNet', probe.read_bytes(), 0o4755)
    info = plistlib.loads(payload[APP + 'Info.plist'][1])
    info.update(CFBundleDisplayName=DISPLAY_NAME, CFBundleName=DISPLAY_NAME,
                CFBundleShortVersionString=VERSION, CFBundleVersion=BUILD_NUMBER, MinimumOSVersion='16.2')
    replace(payload, APP + 'Info.plist', plistlib.dumps(info), 0o644)
    # Retain upstream package ID and postinst signing for a normal upgrade over
    # Showcase; a second package would collide with its BTstack paths/socket.
    lines, skipping_description = [], False
    updates = {'Name': DISPLAY_NAME, 'Version': VERSION,
               'Maintainer': 'mymolasses <mymolasses@users.noreply.github.com>',
               'Depends': 'firmware (>= 16.2), uikittools, ldid',
               'Homepage': 'https://github.com/mymolasses/showcase'}
    for line in old_control.splitlines():
        if line.startswith('Description:'):
            skipping_description = True
            continue
        if skipping_description and line.startswith((' ', '\t')):
            continue
        skipping_description = False
        key = line.split(':', 1)[0]
        if key in ('Depiction', 'SileoDepiction'):
            continue
        lines.append(key + ': ' + updates[key] if key in updates else line)
    lines += ['Description: Unofficial foreground CarPlay browser prototype for rootless iOS 16.2+.',
              ' Adds local H.264 browser output and single-touch input without Android.',
              ' Built for testing with iPhone 14 Pro Max / Dopamine rootless.',
              ' Hardware compatibility remains unverified. Based on Showcase Beta 5-2.']
    replace(control, 'control', ('\n'.join(lines).rstrip() + '\n').encode(), 0o644)
    for script in ['postinst', 'prerm', 'postrm']:
        local_script = (ROOT / 'packaging/control-rootless' / script).read_bytes()
        if script == 'postrm' and control[script][1] != local_script:
            raise SystemExit('Upstream install scripts differ from this checkout: ' + script)
        replace(control, script, local_script, 0o755)
    # Store a machine-readable build record inside the package as well.
    record = (json.dumps(provenance, indent=2, ensure_ascii=False) + '\n').encode()
    replace(payload, 'var/jb/usr/share/showcase/browser-build.json', record, 0o644)
    replace(payload, 'var/jb/usr/share/showcase/BROWSER.md', (ROOT / 'docs/BROWSER.md').read_bytes(), 0o644)
    replace(payload, 'var/jb/usr/share/showcase/TEST_TESLA_BROWSER4.md', (ROOT / 'docs/TEST_TESLA_BROWSER4.md').read_bytes(), 0o644)
    replace(payload, 'var/jb/usr/share/showcase/BROWSER5.md', (ROOT / 'docs/BROWSER5.md').read_bytes(), 0o644)
    replace(payload, 'var/jb/usr/share/showcase/PLAYBACK_DIAGNOSTICS.md', (ROOT / 'docs/PLAYBACK_DIAGNOSTICS.md').read_bytes(), 0o644)
    replace(payload, 'var/jb/usr/share/showcase/PLAYBACK_REVIEW.md', (ROOT / 'docs/PLAYBACK_REVIEW.md').read_bytes(), 0o644)
    md5 = ''.join(hashlib.md5(data).hexdigest() + '  ' + name + '\n'
                  for name, (member, data) in sorted(payload.items()) if member.isfile())
    replace(control, 'md5sums', md5.encode(), 0o644)
    output = args.output / NAME
    write_deb(output, control, payload)
    assert run(['ar', '-t', str(output.resolve())], True).splitlines() == [
        'debian-binary', 'control.tar.gz', 'data.tar.gz']
    extracted = subprocess.run(['ar', '-p', str(output.resolve()), 'control.tar.gz'],
                               check=True, stdout=subprocess.PIPE).stdout
    subprocess.run(['tar', '-tzf', '-'], input=extracted, check=True, stdout=subprocess.DEVNULL)
    # Independently re-read what will be installed, including payload hashes,
    # privilege bits and unchanged runtime bytes; never execute maintainer scripts.
    built = ar_members(output.read_bytes())
    assert built['debian-binary'] == b'2.0\n'
    installed = tar_members(built['data.tar.gz'])
    installed_control = tar_members(built['control.tar.gz'])
    for name, (member, data) in payload.items():
        got, got_data = installed[name]
        assert got.mode == member.mode and got.uid == got.gid == 0 and got_data == data, name
    for line in installed_control['md5sums'][1].decode().splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.md5(installed[name][1]).hexdigest() == digest, name
    for name in unchanged:
        assert hashlib.sha256(installed[name][1]).hexdigest() == provenance['unchanged_runtime_sha256'][name]
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    (args.output / 'SHA256SUMS').write_text(sha + '  ' + NAME + '\n')
    (args.output / 'build-provenance.json').write_bytes(record)
    print('Built and archive-validated:', output)
    print('SHA256:', sha)
    print('Requires active Dopamine/rootless environment; phone/vehicle validation remains pending.')


if __name__ == '__main__':
    main()
