#!/bin/sh
set -eu

REPOSITORY=${DUYA_GITHUB_REPOSITORY:-lava-chen/duya}
DUYA_HOME=${DUYA_HOME:-${HOME}/.duya}
BIN_DIR=${DUYA_BIN_DIR:-${HOME}/.local/bin}
REQUESTED_VERSION=${DUYA_VERSION:-latest}

usage() {
  cat <<'EOF'
Install Duya CLI/TUI.

Usage: install.sh [--version VERSION] [--install-dir DIR] [--bin-dir DIR]
       duya upgrade [--version VERSION]

Environment:
  DUYA_VERSION               Version to install (default: latest stable)
  DUYA_HOME                  Install root (default: ~/.duya)
  DUYA_BIN_DIR               Command directory (default: ~/.local/bin)
  DUYA_GITHUB_REPOSITORY     Release repository (default: lava-chen/duya)
EOF
}

fail() {
  printf 'duya installer: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a value'
      REQUESTED_VERSION=$2
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail '--install-dir requires a value'
      DUYA_HOME=$2
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || fail '--bin-dir requires a value'
      BIN_DIR=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

command -v tar >/dev/null 2>&1 || fail 'tar is required'
if command -v curl >/dev/null 2>&1; then
  fetch() { curl --fail --location --silent --show-error "$1" --output "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget --quiet --output-document="$2" "$1"; }
else
  fail 'curl or wget is required'
fi

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "unsupported operating system: $(uname -s) (supported: macOS and Linux)" ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $machine (supported: x64 and arm64)" ;;
esac

if [ "$platform" = darwin ] && [ "$arch" = x64 ] && command -v sysctl >/dev/null 2>&1; then
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
fi

mkdir -p "$DUYA_HOME" "$BIN_DIR" "$DUYA_HOME/releases"
DUYA_HOME=$(cd "$DUYA_HOME" && pwd -P)
BIN_DIR=$(cd "$BIN_DIR" && pwd -P)
if [ -e "$DUYA_HOME/current" ] && [ ! -L "$DUYA_HOME/current" ]; then
  fail "$DUYA_HOME/current exists and is not an installer-managed symlink"
fi
lock_dir=$DUYA_HOME/.install.lock
if ! mkdir "$lock_dir" 2>/dev/null; then
  fail "another install or upgrade is running (lock: $lock_dir)"
fi
temporary=
cleanup() {
  [ -z "$temporary" ] || rm -rf "$temporary"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
temporary=$(mktemp -d "$DUYA_HOME/.install.XXXXXX")

if [ "$REQUESTED_VERSION" = latest ]; then
  fetch "https://api.github.com/repos/$REPOSITORY/releases?per_page=100" "$temporary/releases.json" \
    || fail 'could not fetch the GitHub Releases list'
  version=$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"cli/v[0-9]+\.[0-9]+\.[0-9]+"' "$temporary/releases.json" \
    | sed -E 's/.*"cli\/v([0-9]+\.[0-9]+\.[0-9]+)"/\1/' | head -n 1 || true)
  [ -n "$version" ] || fail 'no stable CLI release was found'
else
  version=${REQUESTED_VERSION#v}
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
    || fail "invalid version: $REQUESTED_VERSION"
fi

tag=cli/v$version
asset=duya-cli-$version-$platform-$arch.tar.gz
release_url=https://github.com/$REPOSITORY/releases/download/$tag
fetch "$release_url/$asset" "$temporary/$asset" || fail "could not download $asset"
fetch "$release_url/SHA256SUMS" "$temporary/SHA256SUMS" || fail 'could not download the release checksums'

expected=$(awk -v file="$asset" '$2 == file || $2 == ("*" file) { print $1; exit }' "$temporary/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
else
  fail 'sha256sum or shasum is required to verify the downloaded package'
fi
[ "$expected" = "$actual" ] || fail "SHA-256 mismatch for $asset"

mkdir "$temporary/extracted"
tar -xzf "$temporary/$asset" -C "$temporary/extracted"
package=$temporary/extracted/duya-cli
[ -f "$package/VERSION" ] || fail 'release package is missing VERSION'
[ "$(cat "$package/VERSION")" = "$version" ] || fail 'release package version does not match its tag'

if [ -e "$BIN_DIR/duya" ] && [ ! -L "$BIN_DIR/duya" ]; then
  fail "$BIN_DIR/duya already exists and is not a Duya installer symlink; move it before installing"
fi

release_dir=$DUYA_HOME/releases/$version
if [ -e "$release_dir" ]; then
  [ "$(cat "$release_dir/VERSION" 2>/dev/null || true)" = "$version" ] \
    || fail "an incomplete installation already exists at $release_dir"
else
  mv "$package" "$release_dir"
fi
cp "$release_dir/install.sh" "$DUYA_HOME/install.sh"
chmod 755 "$DUYA_HOME/install.sh"

shim_tmp=$BIN_DIR/.duya.$$
duya_home_quoted=$(printf '%s' "$DUYA_HOME" | sed "s/'/'\\\\''/g")
{
  printf '%s\n' '#!/bin/sh' 'set -eu'
  printf 'DUYA_HOME=${DUYA_HOME:-%s}\n' "'$duya_home_quoted'"
  cat <<'EOF'
if [ "${1-}" = upgrade ]; then
  shift
  exec sh "$DUYA_HOME/install.sh" "$@"
fi
DUYA_CLI_VERSION=$(cat "$DUYA_HOME/current/VERSION")
export DUYA_CLI_VERSION
exec "$DUYA_HOME/current/runtime/node" "$DUYA_HOME/current/app/cli.cjs" "$@"
EOF
} >"$shim_tmp"
chmod 755 "$shim_tmp"
mv -f "$shim_tmp" "$BIN_DIR/duya"

previous=$(readlink "$DUYA_HOME/current" 2>/dev/null || true)
current_tmp=$DUYA_HOME/.current.$$
ln -s "$release_dir" "$current_tmp"
if [ "$platform" = darwin ]; then
  mv -hf "$current_tmp" "$DUYA_HOME/current"
else
  mv -Tf "$current_tmp" "$DUYA_HOME/current"
fi

if ! "$BIN_DIR/duya" --version >/dev/null 2>&1; then
  if [ -n "$previous" ]; then
    rollback_tmp=$DUYA_HOME/.current.rollback.$$
    ln -s "$previous" "$rollback_tmp"
    if [ "$platform" = darwin ]; then
      mv -hf "$rollback_tmp" "$DUYA_HOME/current"
    else
      mv -Tf "$rollback_tmp" "$DUYA_HOME/current"
    fi
  else
    rm -f "$DUYA_HOME/current"
    rm -f "$BIN_DIR/duya"
  fi
  fail "Duya CLI $version was installed but failed its startup check; the previous version was restored"
fi

printf 'Installed Duya CLI %s for %s-%s.\n' "$version" "$platform" "$arch"
case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run duya from any terminal.\n' "$BIN_DIR" ;;
esac
printf 'Run `duya upgrade` to install the latest stable CLI release.\n'
