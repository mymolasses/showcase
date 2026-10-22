# VERSION holds major.minor.patch; BUILD_NUMBER is an independent integer.
VERSION_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)/VERSION"
PACKAGE_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
UPSTREAM_VERSION="${PACKAGE_VERSION%-*}"
SHORT_VERSION="${UPSTREAM_VERSION%%~*}"
PRERELEASE="$(echo "$UPSTREAM_VERSION" | sed -n 's/^[^~]*~//p')"
PRERELEASE_NUMBER="$(echo "$PRERELEASE" | sed 's/[^0-9]//g')"
DISPLAY_VERSION="$(echo "$SHORT_VERSION $(echo "$PRERELEASE" | sed -e 's/^alpha/Alpha /' -e 's/^beta/Beta /' -e 's/^rc/RC /')" | sed 's/ *$//')"
BUNDLE_VERSION="$(tr -d '[:space:]' < "$(dirname "$VERSION_FILE")/BUILD_NUMBER")"
# Fills the @...@ placeholders of a template (control, Info.plist).
fill_version() {
  sed -e "s|@PACKAGE_VERSION@|$PACKAGE_VERSION|g" -e "s|@SHORT_VERSION@|$SHORT_VERSION|g" \
      -e "s|@BUNDLE_VERSION@|$BUNDLE_VERSION|g" -e "s|@DISPLAY_VERSION@|$DISPLAY_VERSION|g" "$1"
}
