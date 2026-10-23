"""Package directory regression and optional real dpkg unpack in isolated roots.

The Linux integration preserves the Release data.tar.gz verbatim, substitutes
script-free host-compatible control metadata and never runs iOS maintainer
scripts or executables. It validates unpacking, not on-phone signing/runtime.
"""
import argparse
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import build_browser_rootless as builder


def file_entry(name, data=b'test'):
    member = tarfile.TarInfo(name)
    member.mode = 0o644
    return member, data


def raw_deb(path, data, version):
    # Deliberately do not use write_deb: doing so could repair the artifact
    # under test and mask this exact regression.
    metadata = ('Package: com.rostane.showcase\nVersion: ' + version +
                '\nArchitecture: all\nMaintainer: Test <test@example.invalid>\n'
                'Description: Isolated unpack test\n').encode()
    control = builder.tar_gz({'control': file_entry('control', metadata)})
    result = bytearray(b'!<arch>\n')
    for name, content in [('debian-binary', b'2.0\n'), ('control.tar.gz', control), ('data.tar.gz', data)]:
        result.extend(f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(content):<10}`\n'.encode())
        result.extend(content)
        if len(content) % 2:
            result.extend(b'\n')
    path.write_bytes(result)


class DirectoryTests(unittest.TestCase):
    def test_missing_license_parents_are_rejected(self):
        broken = builder.tar_gz({'var/jb/usr/share/showcase/licenses/broadway/LICENSE.Broadway': file_entry('license')})
        with self.assertRaisesRegex(ValueError, 'Missing or late'):
            builder.validate_directory_order(broken)

    def test_writer_adds_all_ancestors(self):
        name = 'var/jb/usr/share/showcase/licenses/broadway/LICENSE.Broadway'
        payload = {name: file_entry(name)}
        with tempfile.TemporaryDirectory() as work:
            target = Path(work)/'test.deb'
            builder.write_deb(target, {'control': file_entry('control')}, payload)
            data = builder.ar_members(target.read_bytes())['data.tar.gz']
            builder.validate_directory_order(data)
            installed = builder.tar_members(data)
            self.assertEqual(installed[name][1], b'test')
            for parent in PurePosixPath(name).parents:
                if str(parent) != '.':
                    self.assertTrue(installed[str(parent)][0].isdir())
            for name, (member, _) in installed.items():
                if member.isdir():
                    self.assertEqual(member.mode, 0o755)
                    self.assertEqual((member.uid, member.gid), (0, 0))

    def test_file_ancestor_rejected(self):
        entries = {'a': file_entry('a'), 'a/b': file_entry('a/b')}
        with self.assertRaisesRegex(ValueError, 'not a directory'):
            builder.add_parent_directories(entries)


def dpkg_unpack(root, deb, success=True):
    database = root/'var/lib/dpkg'
    (database/'info').mkdir(parents=True, exist_ok=True)
    (database/'updates').mkdir(exist_ok=True)
    (database/'status').touch(exist_ok=True)
    result = subprocess.run(['dpkg', '--root='+str(root), '--log='+str(root/'dpkg.log'),
                             '--unpack', str(deb)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if (result.returncode == 0) != success:
        raise AssertionError(result.stdout)
    return result.stdout


def real_dpkg(deb):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Real dpkg test requires Linux root inside the CI runner')
    release = builder.ar_members(deb.read_bytes())
    data = release['data.tar.gz']
    builder.validate_directory_order(data)
    payload = builder.tar_members(data)
    version = plistlib.loads(payload[builder.APP+'Info.plist'][1])['CFBundleShortVersionString']
    with tempfile.TemporaryDirectory(prefix='showcase-dpkg-') as directory:
        work = Path(directory).resolve()
        # Prove actual dpkg catches what tar extraction previously concealed.
        bad = work/'missing-parent.deb'
        raw_deb(bad, builder.tar_gz({'var/jb/usr/share/showcase/licenses/broadway/LICENSE.Broadway': file_entry('license')}), '1.3.0')
        failure = dpkg_unpack(work/'negative-root', bad, success=False)
        assert 'No such file or directory' in failure, failure
        candidate = work/'candidate.deb'
        raw_deb(candidate, data, version)
        assert builder.ar_members(candidate.read_bytes())['data.tar.gz'] == data
        old = work/'old.deb'
        old_payload = {builder.APP+'Info.plist': file_entry('Info.plist', b'old version')}
        builder.add_parent_directories(old_payload)
        raw_deb(old, builder.tar_gz(old_payload), '1.2.2')
        for scenario in ['fresh', 'upgrade']:
            root = work/(scenario+'-root')
            if scenario == 'upgrade':
                dpkg_unpack(root, old)
            dpkg_unpack(root, candidate)
            for name, (member, expected) in payload.items():
                path = root/name
                if member.isdir():
                    assert path.is_dir(), name
                else:
                    assert hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(expected).digest(), name
            info = plistlib.loads((root/builder.APP/'Info.plist').read_bytes())
            assert info['CFBundleShortVersionString'] == builder.VERSION
            assert info['CFBundleVersion'] == builder.BUILD_NUMBER
            print('PASS: real dpkg '+scenario+' unpack, complete payload hashes and '+version+'/'+builder.BUILD_NUMBER)
        print('PASS: real dpkg reproduces the missing-parent failure; iOS scripts were not executed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--deb', type=Path)
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DirectoryTests))
    if not result.wasSuccessful():
        sys.exit(1)
    if args.deb:
        real_dpkg(args.deb.resolve())
