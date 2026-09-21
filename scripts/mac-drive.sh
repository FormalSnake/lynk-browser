#!/usr/bin/env bash
# Runs a drive on macOS against the REAL engine. `nd dev` and a bare
# `bun scripts/browser-drive.ts` run NDShell as a plain binary, and CEF cannot
# work that way: macOS needs the framework and the five helper .app bundles at
# fixed paths relative to the executable. Without them the host prints
# `ND_WARN ND_WEBVIEW_ENGINE=chromium needs a bundled host (...); running bare`
# and falls back to WKWebView, so the run reports on an engine the app is not
# shipped with.
#
#   scripts/mac-drive.sh [scripts/browser-drive.ts]
#
# ND_FRAMEWORK_DIR points at the framework checkout that assembles the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

FRAMEWORK="${ND_FRAMEWORK_DIR:-$HOME/Developer/NativeDesktop}"
[ -x "$FRAMEWORK/scripts/mac/dev-cef-bundle.sh" ] || {
  echo "no dev-cef-bundle.sh under $FRAMEWORK (set ND_FRAMEWORK_DIR)" >&2
  exit 1
}

# Reused when it is already there: assembling it again while a host from an
# earlier run still has the bundle open leaves CEF unable to start, and the
# host then falls back to WKWebView without failing. ND_REBUILD_BUNDLE=1
# forces the assembly.
#
# The repo's nix devshell exports an SDKROOT that breaks the system Swift
# toolchain, so the bundle build is run without it, the way the framework's own
# mac gates do.
BUNDLE="$FRAMEWORK/swift/.build/NDShellDev.app/Contents/MacOS/NDShell"
if [ -x "$BUNDLE" ] && [ -z "${ND_REBUILD_BUNDLE:-}" ]; then
  HOST="$BUNDLE"
else
  HOST="$(cd "$FRAMEWORK" && env -u SDKROOT -u DEVELOPER_DIR ./scripts/mac/dev-cef-bundle.sh | tail -1)"
fi
echo "host: $HOST"

# A CEF profile of this run's own. Several agents run mac hosts on one machine
# and CEF refuses a second process on a user-data dir another one holds, which
# shows up as the host quietly falling back to WKWebView.
CACHE="$(mktemp -d /tmp/nb-mac-drive-cef.XXXXXX)"
trap 'rm -rf "$CACHE"' EXIT

exec env \
  ND_HOST_BINARY="$HOST" \
  ND_WEBVIEW_ENGINE=chromium \
  ND_CEF_STYLE=chrome \
  ND_CEF_CACHE="$CACHE" \
  bun "${1:-scripts/browser-drive.ts}"
