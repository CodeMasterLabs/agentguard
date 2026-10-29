#!/usr/bin/env sh
# Renders docs/og/og.html to dashboard/public/og.png (1200x630) with headless Edge or Chrome.
# Run from the repo root after `npm ci` (the page loads its fonts from node_modules).
# On Windows (Git Bash) paths are converted with cygpath; set BROWSER for Chrome or another path.
set -e
BROWSER="${BROWSER:-/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
ROOT="$(pwd)"
command -v cygpath >/dev/null 2>&1 && ROOT="$(cygpath -m "$ROOT")"
PROFILE="$(mktemp -d)"
command -v cygpath >/dev/null 2>&1 && PROFILE="$(cygpath -w "$PROFILE")"
"$BROWSER" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE" --window-size=1200,630 --virtual-time-budget=3000 \
  --screenshot="$ROOT/dashboard/public/og.png" "file:///$ROOT/docs/og/og.html"
