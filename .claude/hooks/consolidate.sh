#!/bin/bash
# Session end: consolidate accumulated memories (dedup, prune, detect contradictions).
SNOO="$(cd "$(dirname "$0")/../.." && pwd)"
TSX="$SNOO/node_modules/.bin/tsx"

cd "$SNOO"
"$TSX" "$SNOO/scripts/run.ts" consolidate >/dev/null 2>&1 &
disown
exit 0
