#!/bin/bash
# Pre-task: retrieve learned patterns relevant to the user's prompt.
# Stdout is injected into Claude's context via UserPromptSubmit hook.
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty')
[ -z "$PROMPT" ] && exit 0

cd "$(dirname "$0")/../.."
PROMPT="${PROMPT:0:500}"
tsx scripts/run.ts pre "$PROMPT" 2>/dev/null || true
exit 0
