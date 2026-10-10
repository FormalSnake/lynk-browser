#!/usr/bin/env bash
# The sidebar drive (scripts/sidebar-drive.ts) on Linux, under Xvfb and
# openbox (ND_SIDEBAR_RIG=x11, the default) or a nested Hyprland with XWayland
# (ND_SIDEBAR_RIG=hypr), once per window-button layout: trailing (GNOME's default) and
# leading. Run inside the framework's `nix develop` on a machine with the CEF
# distribution.
#
#   ND_FRAMEWORK_DIR=<checkout> ND_ACCEPT_DISPLAY=:93 bash scripts/linux-sidebar.sh
#
# NB_SIDEBAR_GTK_CSS=<dir> copies that dir's *.css (a desktop's
# ~/.config/gtk-4.0, symlinks followed) into the rig profile, so the drive runs
# under that user theme instead of stock Adwaita. The real dir is never used:
# the profile is the run's own.
#
# Marker: NB_LINUX_SIDEBAR_OK.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
FW="${ND_FRAMEWORK_DIR:-$HOME/Developer/NativeDesktop}"
DIST="${ND_CEF_DIST:-$HOME/.cache/nativedesktop/cef/151.3.23-linux64}"
DISPLAY_NUM="${ND_ACCEPT_DISPLAY:-:93}"
SHOTS="${NB_SIDEBAR_SHOTS:-$APP/screenshots/sidebar-linux}"
WORK="$(mktemp -d)"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"' EXIT

ln -sfn "$DIST"/Resources/* "$DIST/Release/"
# libcef.so needs sonames NixOS keeps off the default loader path; the
# framework's dev shell exports their closure.
[ -n "${ND_CEF_LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH="$ND_CEF_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Stock Adwaita and its fonts, never this machine's own theme, and a private
# session bus with no settings portal on it.
. "$FW/scripts/headless-fonts.sh"
if [ -z "${NB_SIDEBAR_BUS:-}" ]; then export NB_SIDEBAR_BUS=1; exec dbus-run-session -- bash "$0" "$@"; fi
RIG="${ND_SIDEBAR_RIG:-x11}"
if [ "$RIG" = hypr ]; then
  # Hyprland with XWayland, nested in a headless mutter: the framework's own
  # rig (scripts/headless-app-chrome.sh), borrowed rather than copied.
  HYPR_RUNTIME_DIRS=()
  rig=hypr
  eval "$(sed -n '/^hypr_rig() {/,/^run_rig() {/p' "$FW/scripts/headless-app-chrome.sh" | sed '$d')"
  ND_ACCEPT_HYPR_MONITOR="${ND_ACCEPT_HYPR_MONITOR:-1920x1200@60,0x0,1}" hypr_rig || exit 1
  # The rig's config names options this Hyprland no longer has, and the
  # banner reporting them sits over the window's top edge in every capture.
  sed -i -e '/vfr = /d' -e '/blur {/d' -e '/shadow {/d' "$WORK/hypr/hypr.conf"
  # Blur stays on as Hyprland ships it, except behind the browser's popups: an
  # XWayland popup is a window to Hyprland, blurred across its whole surface,
  # and a popover's transparent shadow and arrow margin read as a frosted box.
  # The same rule line goes in a desktop's own config. The main window has the
  # same class but carries the page's title.
  echo 'windowrule = no_blur on, match:class ^(nd-hello)$, match:title ^(nd-hello)$, match:xwayland true, match:float true' >>"$WORK/hypr/hypr.conf"
  hyprctl reload >/dev/null
  sleep 1
  # A reload forgets the rig's runtime monitor rule.
  hyprctl keyword monitor "$(hyprctl -j monitors | jq -r '.[0].name'),${ND_ACCEPT_HYPR_MONITOR:-1920x1200@60,0x0,1}" >/dev/null
  sleep 1
  trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK" "${HYPR_RUNTIME_DIRS[@]:-}"' EXIT
else
  Xvfb "$DISPLAY_NUM" -screen 0 1920x1200x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
  PIDS+=($!)
  export DISPLAY="$DISPLAY_NUM"
  for _ in $(seq 1 200); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.1; done
  openbox >"$WORK/openbox.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  unset WAYLAND_DISPLAY SWAYSOCK
fi

FAILED=0
for layout in end start none; do
  echo "== window buttons on the $layout side"
  mkdir -p "$WORK/$layout/gtk-4.0" "$WORK/$layout/xdg"
  chmod 700 "$WORK/$layout/xdg"
  case "$layout" in
    end) deco="appmenu:minimize,maximize,close" ;;
    start) deco="close,minimize,maximize:" ;;
    # What g815's Hyprland session reports through the settings portal.
    none) deco=":" ;;
  esac
  printf '[Settings]\ngtk-font-name = Adwaita Sans 11\ngtk-icon-theme-name = Adwaita\ngtk-decoration-layout = %s\n' "$deco" \
    >"$WORK/$layout/gtk-4.0/settings.ini"
  if [ -n "${NB_SIDEBAR_GTK_CSS:-}" ]; then cp -L "$NB_SIDEBAR_GTK_CSS"/*.css "$WORK/$layout/gtk-4.0/"; fi
  # Under Hyprland the runtime dir is the compositor's, where its sockets are.
  [ "$RIG" = hypr ] || export XDG_RUNTIME_DIR="$WORK/$layout/xdg"
  [ "$RIG" = hypr ] || export ND_SIDEBAR_X11=1
  XDG_CONFIG_HOME="$WORK/$layout" \
    GDK_BACKEND=x11 GSK_RENDERER=cairo ND_BACKEND=gtk \
    ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT="$DIST/Release" \
    ND_CEF_CACHE="$WORK/$layout/cef" ND_SIDEBAR_CONTROLS="$layout" ND_SIDEBAR_NO_PAINT="$([ "$RIG" = hypr ] && echo 1)" \
    ND_HOST_BINARY="$FW/zig-out/bin/nd-hello" NB_SIDEBAR_SHOTS="$SHOTS/$RIG-$layout" NB_SIDEBAR_HOST_LOG="$SHOTS/$RIG-$layout/host.log" \
    timeout --signal=KILL 900 bun scripts/sidebar-drive.ts 2>&1 | tee "$WORK/$layout.log" | grep -v '^\s*at '
  grep -q NB_SIDEBAR_OK "$WORK/$layout.log" || FAILED=1
done
[ "$FAILED" -eq 0 ] || { echo "NB_LINUX_SIDEBAR_FAIL captures in $SHOTS"; exit 1; }
echo "NB_LINUX_SIDEBAR_OK captures in $SHOTS"
