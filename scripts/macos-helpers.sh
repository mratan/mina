#!/bin/bash
# Builds Mina's native macOS helpers, each only when its source changed: sandbox/macos/mina-instance.c into
# build/macos/mina-instance, and sandbox/macos/mina-ps.c into build/macos/bin (ps, pgrep, pkill for workers). macOS ties privacy permissions (for example ~/Documents) to the exact binary, so a rebuild asks for them again.
# Needs the Command Line Tools (xcode-select --install). Usage: scripts/macos-helpers.sh [--check]
#   --check   exit 0 if the helper is current, 1 if it must be built (nothing is built)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
src="$repo/sandbox/macos/mina-instance.c"
out="$repo/build/macos/mina-instance"
if [ "$(uname -s)" != Darwin ]; then echo "macos-helpers: this is for macOS only" >&2; exit 2; fi
# ps, pgrep and pkill for workers (sandbox/macos/mina-ps.c): a separate binary, so that a change to it never changes the
# identity of mina-instance (the program of the jobs, which holds the privacy permissions).
ps_src="$repo/sandbox/macos/mina-ps.c"
ps_out="$repo/build/macos/bin/mina-ps"
ps_sha="$(shasum -a 256 "$ps_src" | cut -d' ' -f1)"
ps_current() { [ -x "$ps_out" ] && [ "$(cat "$ps_out.sha256" 2>/dev/null)" = "$ps_sha" ] && [ -L "$repo/build/macos/bin/ps" ]; }
build_ps() {
  ps_current && return 0
  mkdir -p "$repo/build/macos/bin"
  /usr/bin/xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -o "$ps_out.tmp" "$ps_src"
  /usr/bin/codesign -v --strict "$ps_out.tmp"
  mv -f "$ps_out.tmp" "$ps_out"
  echo "$ps_sha" > "$ps_out.sha256"
  for name in ps pgrep pkill; do ln -sfn mina-ps "$repo/build/macos/bin/$name"; done
  echo "built $ps_out (ps, pgrep, pkill)"
}
sha="$(shasum -a 256 "$src" | cut -d' ' -f1)"
current="$([ -x "$out" ] && "$out" version 2>/dev/null || true)"
if [ "$current" = "$sha" ]; then
  if [ "${1:-}" = --check ]; then ps_current && exit 0; exit 1; fi
  echo "mina-instance is current: $out"; build_ps; exit 0
fi
[ "${1:-}" = --check ] && exit 1
if ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then
  echo "macos-helpers: the Command Line Tools are missing. Install them with: xcode-select --install" >&2
  exit 1
fi
mkdir -p "$repo/build/macos"
tmp="$(mktemp "$repo/build/macos/.mina-instance.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
/usr/bin/xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -DMINA_SOURCE_SHA="\"$sha\"" -o "$tmp" "$src"
# The linker gives the binary an ad-hoc signature; macOS 27 refuses to run a binary whose signature is not valid.
/usr/bin/codesign -v --strict "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "built $out"
build_ps
