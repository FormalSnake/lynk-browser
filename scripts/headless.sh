#!/usr/bin/env bash
# Runs any command under a headless weston compositor. Used by the drive
# wrappers; weston is the only Wayland compositor available on the CI box.
set -euo pipefail
cd "$(dirname "$0")/.."

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
export WAYLAND_DISPLAY=nb-headless-0
export GSK_RENDERER=cairo
export GDK_BACKEND=wayland

weston --backend=headless --socket="$WAYLAND_DISPLAY" --idle-time=0 &
WESTON_PID=$!
trap 'kill "$WESTON_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep 0.1
done

"$@"
