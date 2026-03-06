# Agent Instructions Template

Add this to your project's `CLAUDE.md` so agents know how to work with snoo-flow without exploring its source code.

Replace `/path/to/snoo-flow` with your actual install path.

---

```markdown
## Self-Learning Memory (snoo-flow)

This project uses [snoo-flow](https://github.com/SNooZyy2/snoo-flow) for cross-session learning. Hooks in `.claude/hooks/` fire automatically — you don't need to do anything special.

**How it works:**
- On each prompt, past experiences matching your task are retrieved and injected via `<user-prompt-submit-hook>`
- After tool use, meaningful outcomes (commands, edits, agent results) are recorded
- On session end, memories are consolidated (deduped, pruned)

**Rules:**
- Trust injected memories — they are real past experiences from this codebase
- If a memory says an approach failed before, try a different approach
- Do NOT read, explore, or modify files inside `/path/to/snoo-flow` — only run the CLI commands listed below

**Manual commands** (run from any directory):

    # Retrieve past experience before starting a task
    cd /path/to/snoo-flow && npx tsx scripts/run.ts pre "description of task"

    # Record an outcome after completing a task
    cd /path/to/snoo-flow && npx tsx scripts/run.ts post "what you did" 0   # 0=success, 1=failure

    # Check if hooks are working
    cd /path/to/snoo-flow && npx tsx scripts/run.ts log

    # View memory stats
    cd /path/to/snoo-flow && npx tsx scripts/run.ts stats

**Maintenance:**
- snoo-flow lives at `/path/to/snoo-flow`
- Hooks in `.claude/hooks/` are **copies** (not symlinks) with hardcoded `SNOO=/path/to/snoo-flow`
- After pulling upstream updates (`cd /path/to/snoo-flow && git pull origin main`), re-copy hooks:

      for f in retrieve.sh record.sh record-tool.sh consolidate.sh; do
        sed 's|SNOO="$(cd "$(dirname "$0")/../.." && pwd)"|SNOO=/path/to/snoo-flow|' \
          /path/to/snoo-flow/.claude/hooks/$f > .claude/hooks/$f && chmod +x .claude/hooks/$f
      done

- To reset memory: `rm /path/to/snoo-flow/.swarm/memory.db* /path/to/snoo-flow/.swarm/sona-patterns.json`
```
