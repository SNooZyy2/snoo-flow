#!/bin/bash
# Pre-task: retrieve learned patterns relevant to the user's prompt.
# Stdout is injected into Claude's context via UserPromptSubmit hook.
SNOO="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$SNOO/.env.local" ] && set -a && . "$SNOO/.env.local" && set +a
TSX="$SNOO/node_modules/.bin/tsx"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty')
[ -z "$PROMPT" ] && exit 0

cd "$SNOO"

# ADR-001: Auto-start persistent embed server if not running
SOCK=".swarm/embed.sock"
PID_FILE=".swarm/embed.pid"

# Check if server is actually alive (socket exists AND process is running)
server_alive() {
  [ -S "$SOCK" ] && [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

if ! server_alive; then
  # Clean up stale socket/pid from crashed server
  rm -f "$SOCK" "$PID_FILE"
  # Start server fully detached: nohup + setsid + /dev/null stdin
  nohup setsid "$TSX" "$SNOO/scripts/embed-server.ts" </dev/null >> .swarm/embed-server.log 2>&1 &
  # Poll for readiness (socket appears after model load, ~400ms)
  for i in $(seq 1 20); do  # 20 x 100ms = 2s max wait
    [ -S "$SOCK" ] && break
    sleep 0.1
  done
fi

PROMPT="${PROMPT:0:500}"
"$TSX" "$SNOO/scripts/run.ts" pre "$PROMPT" 2>/dev/null || true
exit 0
