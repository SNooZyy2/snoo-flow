<div align="center">

```
 ███████╗███╗   ██╗ ██████╗  ██████╗       ███████╗██╗      ██████╗ ██╗    ██╗
 ██╔════╝████╗  ██║██╔═══██╗██╔═══██╗      ██╔════╝██║     ██╔═══██╗██║    ██║
 ███████╗██╔██╗ ██║██║   ██║██║   ██║█████╗█████╗  ██║     ██║   ██║██║ █╗ ██║
 ╚════██║██║╚██╗██║██║   ██║██║   ██║╚════╝██╔══╝  ██║     ██║   ██║██║███╗██║
 ███████║██║ ╚████║╚██████╔╝╚██████╔╝      ██║     ███████╗╚██████╔╝╚███╔███╔╝
 ╚══════╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝       ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝
```

### Self-Learning Memory for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57.svg)](https://sqlite.org)

</div>

---

## The Problem

Every time you start a new conversation with Claude Code, it starts from scratch. It doesn't remember what worked last time. It doesn't know that a particular approach failed yesterday. It has no memory of your project's quirks, your preferred patterns, or the mistakes it already made.

You end up repeating yourself, watching Claude make the same mistakes, and manually course-correcting over and over.

## The Innovation

**snoo-flow gives Claude Code a learning memory.**

It automatically watches what Claude does, records whether things worked or failed, extracts reusable lessons, and feeds them back the next time something similar comes up. No manual note-taking. No copy-pasting old conversations. It just works in the background.

Think of it like this: instead of a goldfish that forgets everything between conversations, Claude becomes more like a colleague who says *"Oh, I ran into this before — here's what worked."*

```
  You type a prompt
       |
       v
  snoo-flow finds relevant past experience
       |
       v
  Claude sees what worked (and what didn't) before responding
       |
       v
  Claude does the work
       |
       v
  snoo-flow records what happened and whether it worked
       |
       v
  The lesson is saved for next time
```

Over time, Claude gets noticeably better at tasks it has seen before — fewer repeated mistakes, faster solutions, and smarter decisions.

## What It Actually Does

| When this happens... | snoo-flow does this |
|---|---|
| You type a prompt | Finds similar past experiences and shows them to Claude |
| Claude runs a command | Records whether it succeeded or failed |
| Claude edits a file | Records what was changed and the outcome |
| Claude spawns an agent | Records the agent type and result |
| A session ends | Cleans up memories (removes duplicates, flags contradictions) |

All of this is **completely automatic**. You use Claude Code exactly as you normally would.

## Getting Started

### What You Need

- [Node.js](https://nodejs.org) version 20 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed

### Install

```bash
git clone https://github.com/SNooZyy2/snoo-flow.git
cd snoo-flow
npm install
```

### Initialize

```bash
npx tsx src/bootstrap.ts
```

That's it. The hooks are pre-configured. Next time you open Claude Code in this directory, snoo-flow starts learning automatically.

### Use It in Other Projects

If you want snoo-flow's learning in a different project directory:

```bash
# From your other project:
mkdir -p .claude/hooks
cp /path/to/snoo-flow/.claude/hooks/*.sh .claude/hooks/
cp /path/to/snoo-flow/.claude/settings.json .claude/settings.json
```

Then update the `cd` path inside each hook script to point to your snoo-flow install location.

## How to Use It

**Just use Claude Code normally.** That's the whole point.

1. Work in a directory with snoo-flow hooks configured
2. Type prompts, let Claude work, end your session
3. Over the first few sessions, snoo-flow builds up its memory
4. After 5-10 tool uses, you'll start seeing relevant past experience appear in Claude's context

You can also check on what snoo-flow has learned:

```bash
# See stats about stored memories
npx tsx scripts/run.ts stats

# Manually search memories
npx tsx scripts/run.ts pre "fix TypeScript import errors"

# Manually record an outcome
npx tsx scripts/run.ts post "refactored auth module" 0    # 0 = success
npx tsx scripts/run.ts post "migration failed" 1           # 1 = failure

# Check if learning hooks are actually working
npx tsx scripts/run.ts log        # show last 20 retrieval events
npx tsx scripts/run.ts log 5      # show last 5

# Run memory cleanup manually
npx tsx scripts/run.ts consolidate
```

The `log` command shows every time snoo-flow retrieved memories for a prompt — including how many memories were found, how long it took, and the top matches with their scores. If you see entries appearing here, the hooks are working.

## How the Learning Works

snoo-flow runs a six-stage pipeline on every tool use:

1. **Capture** — Records what Claude attempted and what happened
2. **Judge** — Determines if the outcome was a success or failure
3. **Distill** — Extracts a reusable lesson: *"when doing X, approach Y works because Z"*
4. **Scrub** — Removes any sensitive info (emails, API keys, etc.) from the lesson
5. **Embed** — Converts the lesson into a searchable format
6. **Store** — Saves it locally in a SQLite database on your machine

When you type a new prompt, snoo-flow searches for lessons that are relevant to what you're about to do, scoring them on how similar they are, how recent they are, and how reliable they've been. Claude sees the best matches before it responds.

## Privacy and Security

- **Everything stays local.** Memories are stored in a SQLite file on your machine (`.swarm/memory.db`)
- **PII is scrubbed.** Emails, API keys, and other sensitive data are automatically redacted before storage
- **No external calls.** snoo-flow uses a local embedding model — your data never leaves your computer
- **No API keys required.** The default setup works entirely offline. An optional LLM-as-judge feature is available if you want more nuanced outcome scoring (requires an API key)

## Troubleshooting

**"No prior patterns found"** — This is normal for the first few sessions. Memories build up as you work. After 5-10 tool uses, retrieval kicks in.

**Slow first run** — The first time snoo-flow runs, it downloads a small embedding model (~23MB). After that, it's cached.

**High CPU or hanging processes** — Restart the embedding server:
```bash
npm run embed-server:stop
npm run embed-server:start
```

## Technical Details

For architecture docs, database schema, configuration options, embedding server internals, and the retrieval algorithm — see [docs/TECHNICAL.md](docs/TECHNICAL.md).

## License

MIT
