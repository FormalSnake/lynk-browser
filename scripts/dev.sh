#!/usr/bin/env bash
# `nd dev`, forwarding whatever flags were given (e.g. --backend gtk).
set -euo pipefail
cd "$(dirname "$0")/.."

exec nd dev "$@"
