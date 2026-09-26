#!/usr/bin/env bash
# build-ax-helper.sh — compile the plan 572 Swift AX helper.
#
# Produces resources/ax-helper/bin/ax-helper. Default: universal
# (arm64 + x86_64 via lipo). When only the host arch can be built
# (SDK/toolchain limits), a single-arch binary is emitted and a
# warning is printed.
#
# The ScreenCaptureKit window-capture op (screenshot.swift) requires a
# macOS 14+ SDK; with older SDKs it is excluded and the helper answers
# `unsupported` for that op instead (graceful degradation, never a
# build failure).
#
# Requires: Xcode Command Line Tools (swiftc + lipo).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/resources/ax-helper"
OUT_DIR="$SRC_DIR/bin"
BUILD_DIR="$SRC_DIR/.build"
BIN_NAME="ax-helper"

mkdir -p "$OUT_DIR" "$BUILD_DIR"

SDK_VERSION="$(xcrun --show-sdk-version 2>/dev/null || echo 0)"
SDK_MAJOR="${SDK_VERSION%%.*}"
SWIFT_SOURCES=("$SRC_DIR/main.swift")
SCK_FLAGS=()
if [ "${SDK_MAJOR:-0}" -ge 14 ]; then
  SWIFT_SOURCES+=("$SRC_DIR/screenshot.swift")
  SCK_FLAGS=(-DDUYA_HAS_SCK)
  echo "[ax-helper] SDK $SDK_VERSION: ScreenCaptureKit op enabled"
else
  echo "[ax-helper] SDK $SDK_VERSION < 14: screenshotWindow op degrades to 'unsupported'"
fi

HOST_ARCH="$(uname -m)"
built=()
for arch in arm64 x86_64; do
  out="$BUILD_DIR/ax-helper-$arch"
  # swiftc runs in the if-condition so a non-zero exit takes the else
  # branch (set -e is suppressed in condition contexts — do NOT wrap
  # in a function whose tail echo masks failures).
  if swiftc -O \
    -target "${arch}-apple-macos12.0" \
    ${SCK_FLAGS[@]+"${SCK_FLAGS[@]}"} \
    "${SWIFT_SOURCES[@]}" \
    -o "$out" 2>"$BUILD_DIR/err-$arch.log"; then
    built+=("$out")
  else
    echo "[ax-helper] ${arch} build failed (see $BUILD_DIR/err-$arch.log); continuing" >&2
  fi
done

if [ ${#built[@]} -eq 2 ]; then
  lipo -create -output "$OUT_DIR/$BIN_NAME" "${built[@]}"
  echo "[ax-helper] universal binary → $OUT_DIR/$BIN_NAME"
elif [ ${#built[@]} -eq 1 ]; then
  echo "[ax-helper] WARNING: building single-arch (${built[0]##*-}); universal unavailable" >&2
  cp "${built[0]}" "$OUT_DIR/$BIN_NAME"
else
  cat "$BUILD_DIR"/err-*.log >&2 || true
  echo "[ax-helper] ERROR: no architecture built" >&2
  exit 1
fi

chmod +x "$OUT_DIR/$BIN_NAME"
# Sanity: the binary must start and answer ready. macOS has no
# `timeout` binary — use the perl alarm trick for the budget.
if echo '{"id":0,"op":"ping"}' | perl -e 'alarm 5; exec @ARGV' "$OUT_DIR/$BIN_NAME" 2>/dev/null | head -1 | grep -q '"ready"'; then
  echo "[ax-helper] smoke: ok"
else
  echo "[ax-helper] WARNING: smoke check produced no ready line (may need a TTY-less env)" >&2
fi
