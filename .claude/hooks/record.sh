#!/bin/bash
# Post-task: record meaningful command outcomes for learning.
# Shared by PostToolUse[Bash] and PostToolUseFailure[Bash].
SNOO="$(cd "$(dirname "$0")/../.." && pwd)"
TSX="$SNOO/node_modules/.bin/tsx"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Skip trivial read-only commands
FIRST_WORD="${COMMAND%% *}"
case "$FIRST_WORD" in
  ls|cat|head|tail|echo|which|pwd|wc|tree|file|stat|mkdir) exit 0 ;;
esac
case "$COMMAND" in
  "git status"*|"git diff"*|"git log"*|"git branch"*|"git remote"*|"git show"*) exit 0 ;;
  "npm run snoo"*|"tsx scripts/run.ts"*) exit 0 ;; # don't record our own learning commands
esac

# Detect success vs failure from hook event name
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
[ "$EVENT" = "PostToolUseFailure" ] && EXIT_CODE=1 || EXIT_CODE=0

# Truncate and record in background (don't block Claude)
COMMAND="${COMMAND:0:500}"
cd "$SNOO"
"$TSX" "$SNOO/scripts/run.ts" post "$COMMAND" "$EXIT_CODE" >/dev/null 2>&1 &
disown
exit 0
