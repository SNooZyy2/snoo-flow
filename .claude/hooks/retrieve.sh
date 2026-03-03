#!/bin/bash
# Pre-task: retrieve learned patterns relevant to the user's prompt.
# Stdout is injected into Claude's context via UserPromptSubmit hook.
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty')
[ -z "$PROMPT" ] && exit 0

cd "$(dirname "$0")/../.."

# ADR-001: Auto-start persistent embed server if not running
SOCK=".swarm/embed.sock"
if [ ! -S "$SOCK" ]; then
  setsid tsx scripts/embed-server.ts >> .swarm/embed-server.log 2>&1 &
  # Poll for readiness (socket appears after model load)
  for i in $(seq 1 20); do  # 20 x 100ms = 2s max wait
    [ -S "$SOCK" ] && break
    sleep 0.1
  done
  # If still no socket after 2s, proceed — embeddings.ts falls back to in-process
fi

PROMPT="${PROMPT:0:500}"
tsx scripts/run.ts pre "$PROMPT" 2>/dev/null || true
exit 0
