#!/usr/bin/env bash
# The tab right-click menus (scripts/linux-tab-menu.ts) in both layouts on
# Linux, under Xvfb and openbox. Run inside the framework's `nix develop` on a
# machine with the CEF distribution.
#
#   ND_FRAMEWORK_DIR=<checkout> ND_ACCEPT_DISPLAY=:94 bash scripts/linux-tab-menu.sh
#
# Marker: NB_LINUX_TAB_MENU_ALL_OK.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
FW="${ND_FRAMEWORK_DIR:-$HOME/Developer/NativeDesktop}"
DIST="${ND_CEF_DIST:-$HOME/.cache/nativedesktop/cef/151.3.23-linux64}"
DISPLAY_NUM="${ND_ACCEPT_DISPLAY:-:94}"
SHOTS="${NB_TAB_MENU_SHOTS:-$APP/screenshots/tab-menu-linux}"
WORK="$(mktemp -d)"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"' EXIT

ln -sfn "$DIST"/Resources/* "$DIST/Release/"
[ -n "${ND_CEF_LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH="$ND_CEF_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
. "$FW/scripts/headless-fonts.sh"
if [ -z "${NB_TAB_MENU_BUS:-}" ]; then export NB_TAB_MENU_BUS=1; exec dbus-run-session -- bash "$0" "$@"; fi

Xvfb "$DISPLAY_NUM" -screen 0 1920x1200x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
PIDS+=($!)
export DISPLAY="$DISPLAY_NUM"
for _ in $(seq 1 200); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.1; done
openbox >"$WORK/openbox.log" 2>&1 &
PIDS+=($!)
sleep 1
unset WAYLAND_DISPLAY SWAYSOCK

mkdir -p "$WORK/gtk-4.0" "$WORK/xdg" "$SHOTS"
chmod 700 "$WORK/xdg"
printf '[Settings]\ngtk-font-name = Adwaita Sans 11\ngtk-icon-theme-name = Adwaita\ngtk-decoration-layout = appmenu:minimize,maximize,close\n' \
  >"$WORK/gtk-4.0/settings.ini"
status=0
for layout in sidebar compact; do
  XDG_RUNTIME_DIR="$WORK/xdg" XDG_CONFIG_HOME="$WORK" \
    GDK_BACKEND=x11 GSK_RENDERER=cairo ND_BACKEND=gtk \
    ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT="$DIST/Release" \
    ND_CEF_CACHE="$WORK/cef-$layout" ND_HOST_BINARY="$FW/zig-out/bin/nd-hello" \
    NB_TAB_MENU_LAYOUT="$layout" NB_TAB_MENU_SHOTS="$SHOTS" \
    timeout --signal=KILL 600 bun scripts/linux-tab-menu.ts 2>&1 | tee "$WORK/drive-$layout.log" | grep -v '^\s*at '
  grep -q NB_LINUX_TAB_MENU_OK "$WORK/drive-$layout.log" || status=1
done
[ "$status" = 0 ] || { echo "NB_LINUX_TAB_MENU_ALL_FAIL captures in $SHOTS"; exit 1; }
echo "NB_LINUX_TAB_MENU_ALL_OK captures in $SHOTS"
