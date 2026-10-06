#!/usr/bin/env bash
# The sidebar motion drive (scripts/sidebar-motion-drive.ts) on Linux, in a
# Hyprland with XWayland nested in a headless mutter (ND_MOTION_RIG=hypr, the
# default: the owner's session) or under Xvfb and openbox (ND_MOTION_RIG=x11).
# Run inside the framework's `nix develop` on a machine with the CEF
# distribution, under the machine's rig lock.
#
#   ND_FRAMEWORK_DIR=<checkout> bash scripts/linux-sidebar-motion.sh
#
# GSK_RENDERER is left to GTK (the GPU renderer where there is one) unless
# NB_MOTION_GSK names one; ND_SPLIT_PAGE_MOTION=live and NB_MOTION_SLOW_RUN
# pass through to the drive. The window buttons are none, as on Hyprland.
#
# Marker: NB_LINUX_SIDEBAR_MOTION_OK.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
FW="${ND_FRAMEWORK_DIR:-$HOME/Developer/NativeDesktop}"
DIST="${ND_CEF_DIST:-$HOME/.cache/nativedesktop/cef/151.3.23-linux64}"
SHOTS="${NB_MOTION_SHOTS:-$APP/screenshots/sidebar-motion-linux}"
WORK="$(mktemp -d)"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"' EXIT

ln -sfn "$DIST"/Resources/* "$DIST/Release/"
[ -n "${ND_CEF_LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH="$ND_CEF_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
. "$FW/scripts/headless-fonts.sh"
if [ -z "${NB_MOTION_BUS:-}" ]; then export NB_MOTION_BUS=1; exec dbus-run-session -- bash "$0" "$@"; fi
RIG="${ND_MOTION_RIG:-hypr}"
if [ "$RIG" = hypr ]; then
  HYPR_RUNTIME_DIRS=()
  rig=hypr
  eval "$(sed -n '/^hypr_rig() {/,/^run_rig() {/p' "$FW/scripts/headless-app-chrome.sh" | sed '$d')"
  ND_ACCEPT_HYPR_MONITOR="${ND_ACCEPT_HYPR_MONITOR:-1920x1200@60,0x0,1}" hypr_rig || exit 1
  # The rig's config names options this Hyprland no longer has, and the
  # banner reporting them sits over the window in every capture.
  cat >"$WORK/hypr/hypr.conf" <<CONF
xwayland {
  enabled = true
  force_zero_scaling = ${ND_ACCEPT_HYPR_ZERO_SCALING:-true}
}
misc {
  disable_hyprland_logo = true
  disable_splash_rendering = true
  force_default_wallpaper = 0
}
general {
  border_size = 0
  gaps_in = 0
  gaps_out = 0
}
animations {
  enabled = false
}
CONF
  hyprctl reload >/dev/null
  sleep 1
  hyprctl keyword monitor "$(hyprctl -j monitors | jq -r '.[0].name'),${ND_ACCEPT_HYPR_MONITOR:-1920x1200@60,0x0,1}" >/dev/null
  sleep 1
  trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK" "${HYPR_RUNTIME_DIRS[@]:-}"' EXIT
else
  DISPLAY_NUM="${ND_ACCEPT_DISPLAY:-:94}"
  Xvfb "$DISPLAY_NUM" -screen 0 1920x1200x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
  PIDS+=($!)
  export DISPLAY="$DISPLAY_NUM"
  for _ in $(seq 1 200); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.1; done
  openbox >"$WORK/openbox.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  unset WAYLAND_DISPLAY SWAYSOCK
  export XDG_RUNTIME_DIR="$WORK/xdg"
  mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
  export NB_MOTION_X11=1
fi

mkdir -p "$WORK/conf/gtk-4.0" "$SHOTS"
printf '[Settings]\ngtk-font-name = Adwaita Sans 11\ngtk-icon-theme-name = Adwaita\ngtk-decoration-layout = :\n' >"$WORK/conf/gtk-4.0/settings.ini"
GSK_ENV=(GSK_DEBUG=renderer)
[ -n "${NB_MOTION_GSK:-}" ] && GSK_ENV+=(GSK_RENDERER="$NB_MOTION_GSK")
# The GPU: GTK and Chromium take their GL drivers from the dev shell's Mesa
# pin, as the compositors do (the system's /run/opengl-driver is built against
# another glibc and fails to load). NB_MOTION_GL=system tries the system's.
case "${NB_MOTION_GL:-pin}" in
  # Chromium reaches GL through ANGLE's GLX backend, whose vendor library
  # (libGLX_mesa) glvnd looks up on the library path.
  pin) [ -n "${ND_PIN_EGL_VENDOR_FILE:-}" ] && GSK_ENV+=(__EGL_VENDOR_LIBRARY_FILENAMES="$ND_PIN_EGL_VENDOR_FILE" LIBGL_DRIVERS_PATH="$ND_PIN_DRI_PATH" GBM_BACKENDS_PATH="$ND_PIN_GBM_PATH" LD_LIBRARY_PATH="$(dirname "$ND_PIN_DRI_PATH")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}") ;;
esac
env "${GSK_ENV[@]}" XDG_CONFIG_HOME="$WORK/conf" GDK_BACKEND=x11 ND_BACKEND=gtk \
  ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT="$DIST/Release" \
  ND_CEF_CACHE="$WORK/cef" ND_HOST_BINARY="$FW/zig-out/bin/nd-hello" \
  NB_MOTION_SHOTS="$SHOTS" NB_MOTION_HOST_LOG="$SHOTS/host.log" NB_MOTION_REPORT="$SHOTS/report.json" \
  timeout --signal=KILL 900 bun scripts/sidebar-motion-drive.ts 2>&1 | tee "$WORK/drive.log" | grep -v '^\s*at '
grep -q NB_SIDEBAR_MOTION_OK "$WORK/drive.log" || { echo "NB_LINUX_SIDEBAR_MOTION_FAIL captures in $SHOTS"; exit 1; }
echo "NB_LINUX_SIDEBAR_MOTION_OK captures in $SHOTS"
