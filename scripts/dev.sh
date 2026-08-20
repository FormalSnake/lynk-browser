#!/usr/bin/env bash
# `nd dev`, with the one thing Linux needs to reach an https:// page.
#
# WebKitGTK gets TLS from glib-networking, which GIO loads as a module. Without
# it every https URL answers "TLS support is not enabled" while http keeps
# working. Testing GIO_EXTRA_MODULES for emptiness is not the check: a desktop
# session sets it for gvfs and dconf and still ships no TLS backend. The
# framework's flake dev shell is where the backend comes from, so this looks for
# the module and re-enters the shell when it is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

FRAMEWORK="${ND_FRAMEWORK_DIR:-$(cd .. && pwd)/NativeDesktop}"

tls_backend_present() {
  local dir so
  local IFS=:
  for dir in ${GIO_EXTRA_MODULES:-} /run/current-system/sw/lib/gio/modules /usr/lib/*/gio/modules /usr/lib/gio/modules; do
    for so in "$dir"/libgiognutls.so "$dir"/libgioopenssl.so; do
      [ -e "$so" ] && return 0
    done
  done
  return 1
}

if [ "$(uname -s)" = "Linux" ] && ! tls_backend_present; then
  if [ -f "$FRAMEWORK/flake.nix" ] && command -v nix >/dev/null 2>&1; then
    exec nix develop "$FRAMEWORK" -c nd dev "$@"
  fi
  echo "ND_WARN dev.sh: no glib-networking and no flake at $FRAMEWORK (set ND_FRAMEWORK_DIR); https pages will fail with \"TLS support is not enabled\"" >&2
fi

exec nd dev "$@"
