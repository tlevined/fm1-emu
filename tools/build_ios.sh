#!/usr/bin/env bash
# Everything the iOS app needs before Xcode: the emulator as a static library for the iPad, the web
# app bundled into the app, FM-1 SID for the plugin, and the Xcode project (XcodeGen).
#   BUNDLE_PREFIX=com.yourname DEVELOPMENT_TEAM=ABCDE12345 tools/build_ios.sh
# Then open ios/FM1.xcodeproj, or archive it as .github/workflows/ios.yml does.
# Needs: macOS with Xcode 26, rustup (targets aarch64-apple-ios and wasm32-unknown-unknown),
# XcodeGen (brew install xcodegen).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${BUNDLE_PREFIX:?set BUNDLE_PREFIX, e.g. com.yourname}"
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM (your Apple team ID)}"

rustup target add aarch64-apple-ios wasm32-unknown-unknown >/dev/null
IPHONEOS_DEPLOYMENT_TARGET=17.0 cargo build --release -p fm1-ios --target aarch64-apple-ios

rm -rf ios/App/site
web/build.sh "$ROOT/ios/App/site" >/dev/null
# (the app serves the page itself: no service worker, no PDF report)
rm -f ios/App/site/sw.js ios/App/site/fm1-emu-report.pdf

if [ -f fm1-sid/web/sidplayer.fwsc ]; then
  cp fm1-sid/web/sidplayer.fwsc ios/AU/sidplayer.fwsc
else
  echo "warning: fm1-sid/ is empty (git submodule update --init): the plugin starts with no firmware" >&2
fi

(cd ios && xcodegen generate)
echo "ios/FM1.xcodeproj is ready"
