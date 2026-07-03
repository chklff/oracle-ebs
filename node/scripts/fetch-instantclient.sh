#!/usr/bin/env bash
#
# Download Oracle Instant Client (Basic Lite) into vendor/instantclient so the
# wrapper can run in Thick mode (needed only for databases that enforce Native
# Network Encryption). No root / no system install: the libraries live inside
# the app directory and are pointed at via EBS_CLIENT_LIB_DIR.
#
# Instant Client is free and, since 2021, redistributable under the Oracle Free
# Use Terms and Conditions. These files are downloaded from Oracle at deploy
# time and are intentionally NOT committed to this repository.
#
# Usage:
#   npm run fetch-client              # default target: ./vendor/instantclient
#   bash scripts/fetch-instantclient.sh /custom/dir
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$APP_DIR/vendor/instantclient}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os/$arch" in
  Linux/x86_64)
    URL="https://download.oracle.com/otn_software/linux/instantclient/instantclient-basiclite-linuxx64.zip"
    ;;
  Linux/aarch64)
    URL="https://download.oracle.com/otn_software/linux/instantclient/instantclient-basiclite-linux-arm64.zip"
    ;;
  MINGW*/*|MSYS*/*|CYGWIN*/*)
    echo "On Windows, use the PowerShell script instead:" >&2
    echo "  npm run fetch-client:win" >&2
    exit 1
    ;;
  *)
    echo "Unsupported platform for this script: $os/$arch" >&2
    echo "Thin mode needs nothing. For Thick mode on this platform, download" >&2
    echo "Instant Client Basic Lite manually from Oracle and set EBS_CLIENT_LIB_DIR." >&2
    exit 1
    ;;
esac

for tool in curl unzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool missing: $tool" >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Instant Client Basic Lite for $os/$arch ..."
curl -fL --retry 3 "$URL" -o "$tmp/ic.zip"

echo "Unpacking ..."
unzip -oq "$tmp/ic.zip" -d "$tmp"

inner="$(find "$tmp" -maxdepth 1 -type d -name 'instantclient_*' | head -n 1)"
if [ -z "$inner" ]; then
  echo "Could not find the unpacked instantclient_* directory." >&2
  exit 1
fi

mkdir -p "$DEST"
cp -a "$inner"/. "$DEST"/

echo
echo "Instant Client installed at: $DEST"
echo "Add this to your .env:"
echo "  EBS_DB_THICK=true"
echo "  EBS_CLIENT_LIB_DIR=$DEST"
