#!/bin/bash
# Post-task: record Edit/Write/Agent outcomes for learning.
# Matched by PostToolUse and PostToolUseFailure for non-Bash tools.
SNOO="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$SNOO/.env.local" ] && set -a && . "$SNOO/.env.local" && set +a
TSX="$SNOO/node_modules/.bin/tsx"

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
[ "$EVENT" = "PostToolUseFailure" ] && EXIT_CODE=1 || EXIT_CODE=0

# Build a human-readable description from tool_input
case "$TOOL" in
  Edit)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"')
    OLD=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""')
    NEW=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""')
    OLD_LEN=${#OLD}
    NEW_LEN=${#NEW}
    # Skip trivial edits (< 30 chars changed) — too small to learn from
    [ $OLD_LEN -lt 30 ] && [ $NEW_LEN -lt 30 ] && exit 0
    # Include more context: file path + truncated change summary
    OLD=$(echo "$OLD" | head -c 150)
    NEW=$(echo "$NEW" | head -c 150)
    DESC="Edit ${FILE}: '${OLD}' → '${NEW}'"
    ;;
  Write)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // "unknown"')
    LEN=$(echo "$INPUT" | jq -r '.tool_input.content // ""' | wc -c)
    # Skip very small writes (< 100 bytes) — likely config tweaks, not learnable
    [ "$LEN" -lt 100 ] && exit 0
    DESC="Write ${FILE} (${LEN} bytes)"
    ;;
  Agent)
    AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "unknown"')
    AGENT_DESC=$(echo "$INPUT" | jq -r '.tool_input.description // ""' | head -c 300)
    DESC="Agent[${AGENT_TYPE}]: ${AGENT_DESC}"
    ;;
  *)
    exit 0 ;; # Unknown tool — skip
esac

# Truncate and record in background (don't block Claude)
DESC="${DESC:0:800}"
cd "$SNOO"
"$TSX" "$SNOO/scripts/run.ts" post "$DESC" "$EXIT_CODE" >/dev/null 2>&1 &
disown
exit 0
