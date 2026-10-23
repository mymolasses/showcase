"""Pinned static WebRTC dependency builds shared by Release and native tests."""
from pathlib import Path
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'libdatachannel': ('https://github.com/paullouisageneau/libdatachannel.git', 'v0.24.1', 'a02b751917ac8afc8c58dc6f4461d25ff9465d48'),
    'mbedtls': ('https://github.com/Mbed-TLS/mbedtls.git', 'mbedtls-3.6.5', 'e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df'),
}

def run(args):
    subprocess.run([str(x) for x in args], check=True)

def prepare(platform='macos'):
    if sys.platform != 'darwin':
        raise RuntimeError('Native browser builds require macOS/Xcode')
    target = ROOT / 'build/browser-native' / platform
    manifest = target / 'flags.json'
    if manifest.exists():
        data = json.loads(manifest.read_text())
        if data.get('pins') == PINS_JSON and all(Path(p).exists() for p in data['libraries']):
            return data
    sources = ROOT / 'build/browser-native/sources'
    sources.mkdir(parents=True, exist_ok=True)
    for name, (url, tag, revision) in PINS.items():
        checkout = sources / name
        if not checkout.exists():
            run(['git', 'clone', '--depth', '1', '--branch', tag, '--recurse-submodules', '--shallow-submodules', url, checkout])
        actual = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != revision:
            raise RuntimeError('Dependency revision mismatch: ' + name)
    prefix = target / 'installed'
    common = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON']
    if platform == 'ios':
        common += ['-DCMAKE_SYSTEM_NAME=iOS', '-DCMAKE_OSX_SYSROOT=iphoneos', '-DCMAKE_OSX_ARCHITECTURES=arm64',
                   '-DCMAKE_OSX_DEPLOYMENT_TARGET=16.2', '-DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO']
    jobs = str(min(4, os.cpu_count() or 2))
    mb = target / 'mbedtls'
    run(['cmake', '-S', sources/'mbedtls', '-B', mb, *common, '-DENABLE_PROGRAMS=OFF', '-DENABLE_TESTING=OFF',
         '-DUSE_SHARED_MBEDTLS_LIBRARY=OFF', '-DUSE_STATIC_MBEDTLS_LIBRARY=ON', '-DCMAKE_INSTALL_PREFIX='+str(prefix)])
    run(['cmake', '--build', mb, '--parallel', jobs])
    run(['cmake', '--install', mb])
    rtc = target / 'rtc'
    run(['cmake', '-S', sources/'libdatachannel', '-B', rtc, *common, '-DUSE_MBEDTLS=ON', '-DUSE_NICE=OFF',
         '-DNO_EXAMPLES=ON', '-DNO_TESTS=ON', '-DNO_WEBSOCKET=ON', '-DNO_MEDIA=OFF',
         '-DBUILD_SHARED_DEPS_LIBS=OFF', '-DPREFER_SYSTEM_LIB=OFF', '-DCMAKE_PREFIX_PATH='+str(prefix),
         '-DCMAKE_INSTALL_PREFIX='+str(prefix), '-DMBEDTLS_ROOT_DIR='+str(prefix)])
    run(['cmake', '--build', rtc, '--target', 'datachannel', '--parallel', jobs])
    # All inputs are pinned sources; retain the static dependency closure.
    libraries = [str(p.resolve()) for p in rtc.rglob('*.a') if p.name != 'libdatachannel-static.a']
    libraries += [str(p.resolve()) for p in (prefix/'lib').glob('*.a')]
    main = next(p for p in libraries if Path(p).name == 'libdatachannel.a')
    libraries = [main] + sorted(set(libraries) - {main})
    includes = [str(sources/'libdatachannel/include'), str(prefix/'include')]
    data = dict(pins=PINS_JSON, includes=includes, libraries=libraries)
    manifest.write_text(json.dumps(data, indent=2)+'\n')
    return data

PINS_JSON = {name:list(values) for name,values in PINS.items()}

def flags(platform='macos'):
    data = prepare(platform)
    return ['-DRTC_STATIC=1', '-DRTC_ENABLE_MEDIA=1', '-DRTC_ENABLE_WEBSOCKET=0',
            *[arg for p in data['includes'] for arg in ['-I',p]], *data['libraries'], '-lc++',
            '-framework','VideoToolbox','-framework','CoreMedia','-framework','CoreVideo',
            '-framework','CoreGraphics','-framework','ImageIO']

def bridge_sources():
    return [str(ROOT/'source'/name) for name in ['browser_bridge.m','browser_jpeg.m','browser_rtc.m']]

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--flags':
        print(json.dumps(flags(sys.argv[2] if len(sys.argv)>2 else 'macos')))
    else:
        prepare(sys.argv[1] if len(sys.argv)>1 else 'macos')
