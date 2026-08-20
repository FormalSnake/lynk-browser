#!/usr/bin/env bash
# Runs any command under a headless compositor. Used by the drive wrappers.
#
# Theming is pinned as well as the compositor. Without that, every screenshot
# this app takes renders the CAPTURE HOST's GTK theme rather than stock
# Adwaita: three "hardcoded colour" blockers in the Stage 5 review turned out
# to be the reviewer reading a developer box's own `formalshell-colors.css`.
# Two channels leak a live session in and both have to be closed: user CSS
# under $XDG_CONFIG_HOME, and the settings portal on the user DBus, which
# outranks settings.ini and GSettings alike. The framework owns both fixes, so
# this sources them rather than growing a second copy.
set -euo pipefail
cd "$(dirname "$0")/.."

FRAMEWORK_SCRIPTS="${ND_FRAMEWORK_DIR:-../NativeDesktop}/scripts"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
export GSK_RENDERER=cairo

if [ -r "$FRAMEWORK_SCRIPTS/headless-theme.sh" ]; then
  . "$FRAMEWORK_SCRIPTS/headless-fonts.sh"
  . "$FRAMEWORK_SCRIPTS/headless-theme.sh"
else
  echo "ND_WARN headless.sh: no framework theme scripts at $FRAMEWORK_SCRIPTS, captures will show the host theme" >&2
fi

# The half XDG_CONFIG_HOME cannot close. A PRIVATE session bus is a real bus
# (WebKitGTK's network process proxies one, so a nonexistent address aborts a
# webview run) carrying no portal. Re-enter under one, once.
if [ -z "${NB_HEADLESS_BUS:-}" ] && command -v dbus-run-session >/dev/null 2>&1; then
  export NB_HEADLESS_BUS=1
  exec dbus-run-session -- "$0" "$@"
fi

# CEF's windowed embedding is X11-only, so the chromium engine needs a real X
# server instead of the system engine's plain Wayland compositor.
if [ "${ND_WEBVIEW_ENGINE:-}" = "chromium" ]; then
  export DISPLAY="${ND_CEF_DISPLAY:-:96}"
  export GDK_BACKEND=x11
  Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
  COMPOSITOR_PID=$!
  # Never `kill "${VAR:-0}"`: an empty variable signals the whole process group,
  # which over ssh takes the session down with it.
  trap '[ -n "${COMPOSITOR_PID:-}" ] && kill "$COMPOSITOR_PID" 2>/dev/null; true' EXIT
  for _ in $(seq 1 100); do
    xwininfo -root >/dev/null 2>&1 && break
    sleep 0.1
  done
else
  export WAYLAND_DISPLAY=nb-headless-0
  export GDK_BACKEND=wayland
  weston --backend=headless --socket="$WAYLAND_DISPLAY" --idle-time=0 &
  COMPOSITOR_PID=$!
  # Never `kill "${VAR:-0}"`: an empty variable signals the whole process group,
  # which over ssh takes the session down with it.
  trap '[ -n "${COMPOSITOR_PID:-}" ] && kill "$COMPOSITOR_PID" 2>/dev/null; true' EXIT
  for _ in $(seq 1 50); do
    [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
    sleep 0.1
  done
fi

"$@"
