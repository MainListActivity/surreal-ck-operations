#!/bin/sh
# build-ps.sh <sandbox dir>: compiles ps.c into <sandbox dir>/shim/ps, which launch.sh puts first on PATH for
# company sessions (/bin/ps is setuid and cannot run inside the sandbox; see ps.c). Atomic replace, so a running
# session never sees a half-written binary. Without a C compiler it leaves any existing shim in place and says so.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dest=$1/shim
mkdir -p "$dest"
if ! /usr/bin/xcrun --find cc >/dev/null 2>&1; then
  echo "sck sandbox: no C compiler (xcode-select --install); ps shim not rebuilt — sandboxed droid Execute will fail" >&2
  exit 0
fi
/usr/bin/cc -O2 -Wall -o "$dest/ps.tmp" "$src/ps.c"
chmod 0755 "$dest/ps.tmp" && mv "$dest/ps.tmp" "$dest/ps"
