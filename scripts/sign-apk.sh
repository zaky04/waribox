#!/usr/bin/env bash
set -euo pipefail

BT="$HOME/Android/Sdk/build-tools/35.0.0"
ROOT="/mnt/c/Users/djaka/APPLI GESTION BOUT"
SRC="$ROOT/apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
ALIGNED="/tmp/waribox-aligned.apk"
SIGNED="$ROOT/apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-signed.apk"

echo "BT=$BT"
echo "SRC=$SRC"
ls -la "$SRC"

rm -f "$ALIGNED" "$SIGNED"

"$BT/zipalign" -v -p 4 "$SRC" "$ALIGNED"
"$BT/apksigner" sign \
  --ks "$HOME/.android/debug.keystore" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$SIGNED" \
  "$ALIGNED"

echo "--- verify ---"
"$BT/apksigner" verify --verbose "$SIGNED"
ls -la "$SIGNED"
