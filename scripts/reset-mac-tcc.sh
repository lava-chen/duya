#!/usr/bin/env bash
# reset-mac-tcc.sh — reset the macOS TCC grants for duya (plan 572 Phase 6).
#
# Dev/packaged verification helper: TCC attributes grants to the
# responsible process (dev mode: the Terminal/IDE host; packaged: the
# DUYA bundle). After re-signing or switching between dev and packaged
# builds, stale grants silently disable CGEventTaps — reset and
# re-grant instead of chasing ghosts.
#
# Usage:
#   scripts/reset-mac-tcc.sh              # all three services
#   scripts/reset-mac-tcc.sh accessibility screen listen

set -uo pipefail

BUNDLE_ID="${DUYA_MAC_BUNDLE_ID:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' node_modules/electron/dist/Electron.app/Contents/Info.plist 2>/dev/null || echo com.duya.app)}"

services=("$@")
[ ${#services[@]} -eq 0 ] && services=(accessibility screen listen)

for svc in "${services[@]}"; do
  case "$svc" in
    accessibility|listen) tccsvc="Accessibility" ;;
    screen) tccsvc="ScreenCapture" ;;
    *) echo "unknown service: $svc" >&2; exit 1 ;;
  esac
  echo "resetting $tccsvc for $BUNDLE_ID"
  tccutil reset "$tccsvc" "$BUNDLE_ID" 2>&1 || \
    echo "note: bundle-scoped reset unsupported on this macOS — run 'tccutil reset $tccsvc' (resets ALL apps)" >&2
done
