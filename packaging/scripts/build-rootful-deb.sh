#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
# VARIANT=taurine builds com.rostane.showcase-taurine (iOS 14 Taurine only):
# Showcase built with SHOWCASE_TAURINE, the BTdaemon from btstack-rootless and
# BTQuiet. Use scripts/build-taurine-deb.sh, which builds those two first.
VARIANT="${VARIANT:-}"
CONTROL_DIR="$ROOT/control"
APP_FLAGS=""
if [ "$VARIANT" = taurine ]; then
  CONTROL_DIR="$ROOT/control-taurine"
  APP_FLAGS="-DSHOWCASE_TAURINE"
elif [ -n "$VARIANT" ]; then
  echo "Unknown VARIANT: $VARIANT"
  exit 1
fi
CONTROL="$CONTROL_DIR/control"
TAURINE_BUILD="$REPO_ROOT/build/taurine"
PAYLOAD="$ROOT/payload"
PAYLOAD_APP="$ROOT/payload/Applications/Showcase.app"
BTSTACK_DYLIB="$PAYLOAD/usr/lib/libBTstack.dylib"
BUILD="$ROOT/build"
REMOTE_BASE="${REMOTE_BASE:-/tmp/showcase-deb-build}"
SDK_REMOTE="${SDK_REMOTE:-/tmp/iPhoneOS10.3.sdk}"

IPAD_HOST="${IPAD_HOST:-localhost}"
IPAD_PORT="${IPAD_PORT:-2222}"
IPAD_USER="${IPAD_USER:-root}"
IPAD_PASS="${IPAD_PASS:-alpine}"

SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o NumberOfPasswordPrompts=1
  -p "$IPAD_PORT"
)

SCP_OPTS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o NumberOfPasswordPrompts=1
  -P "$IPAD_PORT"
)

. "$ROOT/scripts/version.sh"

field() {
  awk -F': ' -v key="$1" '$1 == key { print $2; exit }' "$CONTROL"
}

need_file() {
  if [ ! -f "$1" ]; then
    echo "Missing file: $1"
    exit 1
  fi
}

PKG="$(field Package)"
VER="$PACKAGE_VERSION"
ARCH="$(field Architecture)"
DEB_NAME="${PKG}_${VER}_${ARCH}.deb"

if [ ! -d "$PAYLOAD_APP" ]; then
  echo "Missing payload: $PAYLOAD_APP"
  echo "Run scripts/fetch-installed-app.sh first."
  exit 1
fi

need_file "$BTSTACK_DYLIB"
if [ "$VARIANT" = taurine ]; then
  need_file "$TAURINE_BUILD/BTdaemon"
  need_file "$TAURINE_BUILD/BTQuiet.dylib"
  need_file "$REPO_ROOT/tweak/BTQuiet.plist"
fi
need_file "$REPO_ROOT/source/Showcase.m"
need_file "$REPO_ROOT/source/carplay_bt.m"
need_file "$REPO_ROOT/source/carplay_services.m"
need_file "$REPO_ROOT/source/carplay_pair.c"
need_file "$REPO_ROOT/source/carplay_pair.h"
need_file "$REPO_ROOT/source/baa_broker.h"
need_file "$REPO_ROOT/source/browser_bridge.m"
need_file "$REPO_ROOT/source/browser_bridge.h"
need_file "$REPO_ROOT/source/browser_settings.h"
need_file "$REPO_ROOT/source/browser_assets.h"
need_file "$REPO_ROOT/source/vendor/monocypher/monocypher.c"
need_file "$REPO_ROOT/source/vendor/monocypher/monocypher-ed25519.c"
need_file "$REPO_ROOT/source/vendor/libtommath/tommath.c"
need_file "$REPO_ROOT/source/Info.plist"
need_file "$REPO_ROOT/source/ent_app.xml"
need_file "$REPO_ROOT/source/ent_bt.xml"
need_file "$REPO_ROOT/source/ent_svc.xml"
need_file "$REPO_ROOT/icon/generated/Icon-OEM-104.png"
need_file "$REPO_ROOT/icon/generated/Icon-OEM-120.png"

sshpass -p "$IPAD_PASS" ssh "${SSH_OPTS[@]}" "$IPAD_USER@$IPAD_HOST" "
set -e
test -d '$SDK_REMOTE'
command -v clang >/dev/null
command -v ldid >/dev/null
command -v dpkg-deb >/dev/null
"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/showcase-rootful.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/send" "$WORK/rootfs" "$WORK/rootfs/DEBIAN" "$BUILD" "$ROOT/repo/debs"

cp "$REPO_ROOT/source/Showcase.m" \
   "$REPO_ROOT/source/carplay_bt.m" \
   "$REPO_ROOT/source/carplay_services.m" \
   "$REPO_ROOT/source/carplay_pair.c" \
   "$REPO_ROOT/source/carplay_pair.h" \
   "$REPO_ROOT/source/baa_broker.h" \
   "$REPO_ROOT/source/browser_bridge.m" \
   "$REPO_ROOT/source/browser_bridge.h" \
   "$REPO_ROOT/source/browser_settings.h" \
   "$REPO_ROOT/source/browser_assets.h" \
   "$REPO_ROOT/source/Info.plist" \
   "$REPO_ROOT/source/ent_app.xml" \
   "$REPO_ROOT/source/ent_bt.xml" \
   "$REPO_ROOT/source/ent_svc.xml" \
   "$WORK/send/"
cp "$BTSTACK_DYLIB" "$WORK/send/libBTstack.dylib"
COPYFILE_DISABLE=1 tar --format ustar -C "$REPO_ROOT/source" \
  -cf "$WORK/send/crypto-vendor.tar" vendor

sshpass -p "$IPAD_PASS" ssh "${SSH_OPTS[@]}" "$IPAD_USER@$IPAD_HOST" \
  "rm -rf '$REMOTE_BASE' && mkdir -p '$REMOTE_BASE'"

sshpass -p "$IPAD_PASS" scp "${SCP_OPTS[@]}" \
  "$WORK/send/"* \
  "$IPAD_USER@$IPAD_HOST:$REMOTE_BASE/"

sshpass -p "$IPAD_PASS" ssh "${SSH_OPTS[@]}" "$IPAD_USER@$IPAD_HOST" "
set -e
cd '$REMOTE_BASE'
tar -xf crypto-vendor.tar

clang -fobjc-arc -miphoneos-version-min=12.0 -isysroot '$SDK_REMOTE' \
    -DAPP_VERSION='\"$DISPLAY_VERSION\"' -DPACKAGE_VERSION='\"$PACKAGE_VERSION\"' $APP_FLAGS -o Showcase Showcase.m \
    -framework UIKit -framework AVFoundation -framework AudioToolbox \
    -framework CoreMedia -framework Foundation -framework Security \
    -Wl,-undefined,dynamic_lookup

clang -fobjc-arc -miphoneos-version-min=12.0 -isysroot '$SDK_REMOTE' \
    -o carplay_bt carplay_bt.m \
    ./libBTstack.dylib \
    -framework Foundation -framework Security \
    -Wl,-undefined,dynamic_lookup

clang -fobjc-arc -miphoneos-version-min=12.0 -isysroot '$SDK_REMOTE' \
    -o carplay_services carplay_services.m carplay_pair.c browser_bridge.m \
    vendor/monocypher/monocypher.c \
    vendor/monocypher/monocypher-ed25519.c \
    vendor/libtommath/tommath.c \
    -framework Foundation -framework Security \
    -Wl,-undefined,dynamic_lookup
"

cp -R "$PAYLOAD"/. "$WORK/rootfs"/
for bin in Showcase carplay_bt carplay_services; do
  sshpass -p "$IPAD_PASS" scp "${SCP_OPTS[@]}" \
    "$IPAD_USER@$IPAD_HOST:$REMOTE_BASE/$bin" \
    "$WORK/rootfs/Applications/Showcase.app/$bin"
done
fill_version "$REPO_ROOT/source/Info.plist" > "$WORK/rootfs/Applications/Showcase.app/Info.plist"
rm -rf "$WORK/rootfs/Applications/Showcase.app/"*.lproj
cp -R "$REPO_ROOT/source/Localizations/"*.lproj "$WORK/rootfs/Applications/Showcase.app/"
cp "$REPO_ROOT/icon/generated/Icon-OEM-104.png" \
   "$WORK/rootfs/Applications/Showcase.app/Icon-OEM-104.png"
cp "$REPO_ROOT/icon/generated/Icon-OEM-120.png" \
   "$WORK/rootfs/Applications/Showcase.app/Icon-OEM-120.png"

fill_version "$CONTROL" > "$WORK/rootfs/DEBIAN/control"
cp "$CONTROL_DIR/postinst" "$WORK/rootfs/DEBIAN/postinst"
cp "$CONTROL_DIR/prerm" "$WORK/rootfs/DEBIAN/prerm"
cp "$CONTROL_DIR/postrm" "$WORK/rootfs/DEBIAN/postrm"
if [ "$VARIANT" = taurine ]; then
  cp "$TAURINE_BUILD/BTdaemon" "$WORK/rootfs/usr/bin/BTdaemon"
  mkdir -p "$WORK/rootfs/Library/MobileSubstrate/DynamicLibraries"
  cp "$TAURINE_BUILD/BTQuiet.dylib" "$REPO_ROOT/tweak/BTQuiet.plist" \
     "$WORK/rootfs/Library/MobileSubstrate/DynamicLibraries/"
fi
cp "$REPO_ROOT/source/ent_app.xml" "$WORK/rootfs/DEBIAN/ent_app.xml"
cp "$REPO_ROOT/source/ent_bt.xml" "$WORK/rootfs/DEBIAN/ent_bt.xml"
cp "$REPO_ROOT/source/ent_svc.xml" "$WORK/rootfs/DEBIAN/ent_svc.xml"

find "$WORK/rootfs" -name '.DS_Store' -delete
find "$WORK/rootfs" -name '._*' -delete
xattr -cr "$WORK/rootfs" 2>/dev/null || true

COPYFILE_DISABLE=1 tar --format ustar -C "$WORK" -cf "$WORK/rootfs.tar" rootfs

sshpass -p "$IPAD_PASS" ssh "${SSH_OPTS[@]}" "$IPAD_USER@$IPAD_HOST" \
  "rm -rf '$REMOTE_BASE' && mkdir -p '$REMOTE_BASE'"

sshpass -p "$IPAD_PASS" scp "${SCP_OPTS[@]}" \
  "$WORK/rootfs.tar" \
  "$IPAD_USER@$IPAD_HOST:$REMOTE_BASE/rootfs.tar"

sshpass -p "$IPAD_PASS" ssh "${SSH_OPTS[@]}" "$IPAD_USER@$IPAD_HOST" "
set -e
cd '$REMOTE_BASE'
tar xf rootfs.tar
cd rootfs
find . -name '._*' -delete
find . -name '.DS_Store' -delete

chown root:wheel .
chown -R root:wheel Applications usr Library DEBIAN
chmod 0755 . Applications Applications/Showcase.app usr usr/bin usr/lib Library Library/LaunchDaemons
chmod 0644 Applications/Showcase.app/Info.plist Applications/Showcase.app/Icon*.png
chmod 0755 Applications/Showcase.app/*.lproj
chmod 0644 Applications/Showcase.app/*.lproj/*
chmod 4755 Applications/Showcase.app/Showcase Applications/Showcase.app/carplay_bt Applications/Showcase.app/carplay_services
chmod 0755 usr/bin/BTdaemon usr/lib/libBTstack.dylib
chmod 0644 Library/LaunchDaemons/ch.ringwald.BTstack.plist
if [ -d Library/MobileSubstrate ]; then
  chmod 0755 Library/MobileSubstrate Library/MobileSubstrate/DynamicLibraries
  chmod 0644 Library/MobileSubstrate/DynamicLibraries/*
fi
chmod 0755 DEBIAN/postinst DEBIAN/prerm DEBIAN/postrm
chmod 0644 DEBIAN/control

ldid -SDEBIAN/ent_app.xml Applications/Showcase.app/Showcase
ldid -SDEBIAN/ent_bt.xml  Applications/Showcase.app/carplay_bt
ldid -SDEBIAN/ent_svc.xml Applications/Showcase.app/carplay_services
rm -f DEBIAN/ent_app.xml DEBIAN/ent_bt.xml DEBIAN/ent_svc.xml

find . -path ./DEBIAN -prune -o -type f -exec md5sum {} \\; > DEBIAN/md5sums
chmod 0644 DEBIAN/md5sums

dpkg-deb -Zgzip -z9 -b . '../$DEB_NAME'
dpkg-deb -I '../$DEB_NAME'
dpkg-deb -c '../$DEB_NAME' | sed -n '1,80p'
"

sshpass -p "$IPAD_PASS" scp "${SCP_OPTS[@]}" \
  "$IPAD_USER@$IPAD_HOST:$REMOTE_BASE/$DEB_NAME" \
  "$BUILD/$DEB_NAME"

cp "$BUILD/$DEB_NAME" "$ROOT/repo/debs/$DEB_NAME"

echo "Built $BUILD/$DEB_NAME"
echo "Copied repo payload to $ROOT/repo/debs/$DEB_NAME"
