#!/usr/bin/env bash
# What a site sees of the browser (scripts/identity-probe.ts) on Linux, under
# Xvfb and openbox. Run inside the framework's `nix develop` on a machine with
# the CEF distribution.
#
#   ND_FRAMEWORK_DIR=<checkout> ND_ACCEPT_DISPLAY=:93 bash scripts/linux-identity.sh
#
# NB_IDENTITY_SCRIPT=scripts/webstore-drive.ts runs the live store check in the
# same rig instead. Marker: NB_IDENTITY_OK.
set -euo pipefail
cd "$(dirname "$0")/.."
FW="${ND_FRAMEWORK_DIR:-$HOME/Developer/NativeDesktop}"
DIST="${ND_CEF_DIST:-$HOME/.cache/nativedesktop/cef/151.3.23-linux64}"
DISPLAY_NUM="${ND_ACCEPT_DISPLAY:-:93}"
WORK="$(mktemp -d)"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"' EXIT

ln -sfn "$DIST"/Resources/* "$DIST/Release/"
[ -n "${ND_CEF_LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH="$ND_CEF_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
. "$FW/scripts/headless-fonts.sh"
if [ -z "${NB_IDENTITY_BUS:-}" ]; then export NB_IDENTITY_BUS=1; exec dbus-run-session -- bash "$0" "$@"; fi

Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
PIDS+=($!)
export DISPLAY="$DISPLAY_NUM"
for _ in $(seq 1 200); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.1; done
openbox >"$WORK/openbox.log" 2>&1 &
PIDS+=($!)
sleep 1
unset WAYLAND_DISPLAY SWAYSOCK

mkdir -p "$WORK/xdg" "$WORK/data"
chmod 700 "$WORK/xdg"
XDG_RUNTIME_DIR="$WORK/xdg" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK" \
  GDK_BACKEND=x11 GSK_RENDERER=cairo ND_BACKEND=gtk ND_APP_ID="${ND_APP_ID:-dev.nativebrowser.identity}" \
  ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT="$DIST/Release" \
  ND_CEF_CACHE="$WORK/cef" ND_HOST_BINARY="${ND_HOST_BINARY:-$FW/zig-out/bin/nd-hello}" \
  NB_IDENTITY_LOG="$WORK/host.log" \
  timeout --signal=KILL 180 bun "${NB_IDENTITY_SCRIPT:-scripts/identity-probe.ts}"
