#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/headless.sh" bun scripts/extensions-drive.ts
