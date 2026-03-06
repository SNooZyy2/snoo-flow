#!/bin/bash
# Post-task: record meaningful command outcomes for learning.
# Shared by PostToolUse[Bash] and PostToolUseFailure[Bash].
SNOO="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$SNOO/.env.local" ] && set -a && . "$SNOO/.env.local" && set +a
TSX="$SNOO/node_modules/.bin/tsx"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Skip trivial read-only commands
FIRST_WORD="${COMMAND%% *}"
case "$FIRST_WORD" in
  ls|cat|head|tail|echo|which|pwd|wc|tree|file|stat|mkdir|cd|pushd|popd|type|env|printenv|set|export|source|true|false|sleep) exit 0 ;;
esac
case "$COMMAND" in
  "git status"*|"git diff"*|"git log"*|"git branch"*|"git remote"*|"git show"*|"git stash list"*) exit 0 ;;
  "npm run snoo"*|"tsx scripts/run.ts"*) exit 0 ;; # don't record our own learning commands
  "curl"*"/health"*|"curl"*"/status"*|"curl"*"/ping"*) exit 0 ;; # health checks
  "node -e"*|"node -p"*) exit 0 ;; # one-liner evals
esac

# Skip very short commands (< 15 chars) — too trivial to learn from
[ ${#COMMAND} -lt 15 ] && exit 0

# Detect success vs failure from hook event name
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
[ "$EVENT" = "PostToolUseFailure" ] && EXIT_CODE=1 || EXIT_CODE=0

# Truncate and record in background (don't block Claude)
COMMAND="${COMMAND:0:500}"
cd "$SNOO"
"$TSX" "$SNOO/scripts/run.ts" post "$COMMAND" "$EXIT_CODE" >/dev/null 2>&1 &
disown
exit 0
