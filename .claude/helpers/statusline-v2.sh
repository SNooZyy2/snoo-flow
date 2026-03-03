#!/bin/bash
# ADR-023: Canonical Statusline - Read Real Session Data from Stdin
# Claude Code pipes JSON on stdin with real-time context, cost, and model info.
# This script ONLY uses that stdin data + cached git branch. No fabricated metrics.

set -euo pipefail

# ANSI colors
PURPLE='\033[0;35m'
BOLD_PURPLE='\033[1;35m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BLUE='\033[0;94m'
DIM='\033[2m'
RESET='\033[0m'

# Cache config
CACHE_DIR="/tmp/claude-statusline-cache-$(id -u)"
CACHE_TTL=5
mkdir -p "$CACHE_DIR" 2>/dev/null || true

# Check if jq is available
if ! command -v jq &>/dev/null; then
    echo -e "${BOLD_PURPLE}▊${RESET} ${PURPLE}Claude Flow V3${RESET}"
    exit 0
fi

# Phase 1: Read stdin JSON from Claude Code
STDIN_JSON="{}"
if [ -p /dev/stdin ] || { [ ! -t 0 ] && [ -e /dev/stdin ]; }; then
    STDIN_JSON=$(timeout 1 cat 2>/dev/null || echo "{}")
fi

# Parse stdin data
MODEL_NAME=$(echo "$STDIN_JSON" | jq -r '.model.display_name // ""' 2>/dev/null || echo "")
CTX_PCT=$(echo "$STDIN_JSON" | jq -r '.context_window.used_percentage // ""' 2>/dev/null || echo "")
COST=$(echo "$STDIN_JSON" | jq -r '.cost.total_cost_usd // ""' 2>/dev/null || echo "")
DURATION_MS=$(echo "$STDIN_JSON" | jq -r '.cost.total_duration_ms // ""' 2>/dev/null || echo "")

# Phase 3: Cache git branch (5s TTL)
GIT_CACHE="$CACHE_DIR/git-branch"
GIT_BRANCH=""
if [ -f "$GIT_CACHE" ]; then
    CACHE_AGE=$(($(date +%s) - $(stat -c %Y "$GIT_CACHE" 2>/dev/null || echo 0)))
    if [ "$CACHE_AGE" -lt "$CACHE_TTL" ]; then
        GIT_BRANCH=$(cat "$GIT_CACHE" 2>/dev/null || echo "")
    fi
fi

if [ -z "$GIT_BRANCH" ] && [ -d .git ]; then
    GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
    echo "$GIT_BRANCH" > "$GIT_CACHE" 2>/dev/null || true
fi

# Format duration (ms to human readable)
format_duration() {
    local ms=$1
    if [ -z "$ms" ] || [ "$ms" = "null" ]; then
        echo ""
        return
    fi

    local seconds=$((ms / 1000))
    local hours=$((seconds / 3600))
    local minutes=$(((seconds % 3600) / 60))
    local secs=$((seconds % 60))

    if [ "$hours" -gt 0 ]; then
        echo "${hours}h ${minutes}m"
    elif [ "$minutes" -gt 0 ]; then
        echo "${minutes}m ${secs}s"
    else
        echo "${secs}s"
    fi
}

DURATION=$(format_duration "$DURATION_MS")

# Phase 4: Build statusline with real data only
SEGMENTS=()

# Always show prefix and model
if [ -n "$MODEL_NAME" ]; then
    SEGMENTS+=("${BOLD_PURPLE}▊${RESET} ${PURPLE}${MODEL_NAME}${RESET}")
else
    SEGMENTS+=("${BOLD_PURPLE}▊${RESET} ${PURPLE}Claude${RESET}")
fi

# Context % (colored by usage)
if [ -n "$CTX_PCT" ] && [ "$CTX_PCT" != "null" ]; then
    CTX_INT=${CTX_PCT%.*}  # Remove decimals
    CTX_COLOR=$GREEN
    if [ "$CTX_INT" -ge 75 ]; then
        CTX_COLOR=$RED
    elif [ "$CTX_INT" -ge 50 ]; then
        CTX_COLOR=$YELLOW
    fi
    SEGMENTS+=("${CTX_COLOR}Ctx ${CTX_INT}%${RESET}")
fi

# Cost
if [ -n "$COST" ] && [ "$COST" != "null" ] && [ "$COST" != "0" ]; then
    SEGMENTS+=("${CYAN}\$${COST}${RESET}")
fi

# Duration
if [ -n "$DURATION" ]; then
    SEGMENTS+=("${DIM}${DURATION}${RESET}")
fi

# Git branch
if [ -n "$GIT_BRANCH" ]; then
    SEGMENTS+=("${BLUE}⎇ ${GIT_BRANCH}${RESET}")
fi

# Join segments with pipe separator
SEP="${DIM}│${RESET}"
OUTPUT=""
for i in "${!SEGMENTS[@]}"; do
    if [ "$i" -eq 0 ]; then
        OUTPUT="${SEGMENTS[$i]}"
    else
        OUTPUT="${OUTPUT}  ${SEP}  ${SEGMENTS[$i]}"
    fi
done

echo -e "$OUTPUT"
