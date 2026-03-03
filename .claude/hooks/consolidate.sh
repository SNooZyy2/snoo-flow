#!/bin/bash
# Session end: consolidate accumulated memories (dedup, prune, detect contradictions).
cd "$(dirname "$0")/../.."
tsx scripts/run.ts consolidate >/dev/null 2>&1 &
disown
exit 0
