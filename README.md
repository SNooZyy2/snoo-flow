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

**Claude remembers what worked. And what didn't.**

Every prompt retrieves relevant past experience. Every tool use records what happened.
Every session consolidates knowledge. Over time, Claude gets better at tasks it has seen before.

```
  ┌──────────┐     ┌──────────────────┐     ┌──────────────┐     ┌───────┐
  │  Prompt  │────>│ Retrieve Memories│────>│ Claude Works │────>│ Judge │
  └──────────┘     └──────────────────┘     └──────────────┘     └───┬───┘
       ▲                                                             │
       │            ┌──────────┐     ┌──────────┐     ┌──────────┐   │
       └────────────│  Store   │<────│  Scrub   │<─── │  Distill │<──┘
                  └──────────┘     └──────────┘     └──────────┘
```

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57.svg)](https://sqlite.org)
[![ONNX Runtime](https://img.shields.io/badge/Embeddings-ONNX-purple.svg)](https://onnxruntime.ai)

</div>

---

## How It Works

snoo-flow hooks into Claude Code's lifecycle events:

| Event | What happens |
|---|---|
| You type a prompt | Retrieves similar past experiences and injects them into context |
| Claude runs a Bash command | Records the command and whether it succeeded or failed |
| Claude edits/writes a file | Records the edit description and outcome |
| Claude spawns an agent | Records the agent type and result |
| Session ends | Consolidates memories (dedup, contradiction detection, pruning) |

All of this is automatic. You don't need to do anything differently — just use Claude Code as normal.

### What gets stored

When Claude completes a tool use, snoo-flow:

1. **Captures** a trajectory (what was attempted, what happened)
2. **Judges** the outcome (Success or Failure, with confidence and reasons)
3. **Distills** reusable patterns ("when doing X, approach Y works because Z")
4. **Scrubs PII** from the pattern (emails, API keys, etc. are redacted)
5. **Embeds** the pattern as a 384-dim vector for semantic search
6. **Stores** it in a local SQLite database

### What gets retrieved

On each prompt, snoo-flow:

1. Embeds your prompt text
2. Finds the most relevant stored patterns via cosine similarity
3. Scores them using a weighted formula: `0.65 × similarity + 0.15 × recency + 0.20 × reliability`
4. Selects diverse results via MMR (Maximal Marginal Relevance)
5. Formats them as context that Claude sees before responding

The result: if Claude failed at a similar task before, it sees the failure pattern and avoids repeating it. If it succeeded, it sees the strategy that worked.

## Setup

### Prerequisites

- Node.js 20+ (tested on v24)
- Claude Code CLI installed

### Install

```bash
git clone https://github.com/SNooZyy2/snoo-flow.git
cd snoo-flow
npm install
```

This installs dependencies and downloads the embedding model (~23MB, cached in `~/.cache/huggingface/` after first run).

### Register hooks with Claude Code

snoo-flow ships a `.claude/settings.json` that defines all the hooks. Claude Code picks this up automatically when you work inside the `snoo-flow` directory.

If you're working in a different project and want snoo-flow's learning there, copy the hook configuration:

```bash
# From your project directory:
mkdir -p .claude/hooks
cp /path/to/snoo-flow/.claude/hooks/*.sh .claude/hooks/
cp /path/to/snoo-flow/.claude/settings.json .claude/settings.json
```

Then update the `cd` paths inside each hook script to point to your snoo-flow install.

### Verify it works

```bash
# Initialize the database
npx tsx src/bootstrap.ts

# Run all tests (31 tests across 6 suites)
npm test

# Check stats
npx tsx scripts/run.ts stats
```

## Usage

### Automatic (recommended)

Just use Claude Code normally. The hooks handle everything:

1. **Start a session** in the snoo-flow directory (or any directory with the hooks configured)
2. **Type prompts** — snoo-flow retrieves relevant memories and shows them to Claude
3. **Let Claude work** — every tool use is recorded in the background
4. **End the session** — memories are consolidated automatically

You'll see retrieved memories appear in Claude's context when they're relevant. The first few sessions won't have much to retrieve, but patterns accumulate over time.

### Manual CLI

You can also interact with the learning system directly:

```bash
# Retrieve memories for a query
npx tsx scripts/run.ts pre "fix TypeScript import errors"

# Record an outcome manually
npx tsx scripts/run.ts post "refactored auth module to use JWT" 0     # 0 = success
npx tsx scripts/run.ts post "database migration failed on prod" 1     # 1 = failure

# View stats
npx tsx scripts/run.ts stats

# Run consolidation manually
npx tsx scripts/run.ts consolidate
```

### Embedding Server

snoo-flow includes a persistent embedding server (ADR-001) that loads the ONNX model once and serves requests over a Unix socket. This is ~85x faster than cold-loading the model on every hook invocation.

The server starts automatically when you type your first prompt (via `retrieve.sh`). You can also manage it manually:

```bash
# Start the server
npm run embed-server:start

# Check if it's running
curl --unix-socket .swarm/embed.sock http://localhost/health 2>/dev/null | jq .

# Stop the server
npm run embed-server:stop

# Run benchmarks
npx tsx scripts/benchmark-embed.ts
```

The server self-exits after 30 minutes of inactivity. If it's not running, everything still works — embedding computation falls back to in-process model loading (slower but functional).

**Performance comparison:**

| Scenario | Without server | With server |
|---|---|---|
| Embedding inference | ~255ms (cold) | ~3-5ms |
| Full hook latency | ~500ms | ~200ms |
| Concurrent hooks | N x 255ms | ~3ms x N (serialized) |
| Memory per model instance | ~250MB each | ~50MB shared |

## Architecture

### Directory Structure

```
src/
  bootstrap.ts                    # DB init + env setup
  hooks/
    handler.ts                    # Orchestrates the full pipeline
    pre-task.ts                   # CLI entrypoint for retrieval
    post-task.ts                  # CLI entrypoint for recording
  trajectory/
    capture.ts                    # Builds structured trajectory objects
  reasoningbank/
    core/
      retrieve.ts                 # Memory retrieval (Algorithm 1)
      judge.ts                    # Verdict assignment (Algorithm 2)
      distill.ts                  # Pattern extraction (Algorithm 3)
      consolidate.ts              # Dedup + prune (Algorithm 4)
    db/
      queries.ts                  # SQLite operations (schema source of truth)
      schema.ts                   # TypeScript types
    utils/
      embeddings.ts               # 3-tier embedding: cache → server → in-process
      config.ts                   # YAML config loader with defaults
      mmr.js                      # Maximal Marginal Relevance selection
      pii-scrubber.js             # PII redaction before storage
    config/
      reasoningbank.yaml          # Algorithm parameters
    prompts/
      judge.json                  # LLM judge prompt template
      distill-success.json        # Success pattern extraction prompt
      distill-failure.json        # Failure pattern extraction prompt
  routing/
    sona-optimizer.ts             # Adaptive routing (learns agent selection)
scripts/
    run.ts                        # Unified CLI runner (called by all hooks)
    embed-server.ts               # Persistent embedding server (ADR-001)
    benchmark-embed.ts            # Performance benchmarking tool
tests/                            # 31 tests across 6 suites
.claude/
    hooks/
      retrieve.sh                 # UserPromptSubmit → memory retrieval
      record.sh                   # PostToolUse[Bash] → outcome recording
      record-tool.sh              # PostToolUse[Edit|Write|Agent] → recording
      consolidate.sh              # SessionEnd → memory consolidation
    settings.json                 # Hook configuration for Claude Code
.swarm/
    memory.db                     # SQLite database (created at runtime)
    embed.sock                    # Unix socket for embed server (runtime)
    embed.pid                     # Embed server PID file (runtime)
    embed-server.log              # Server logs (runtime)
docs/
    ADR/001-persistent-embedding-server.md   # Architecture decision record
```

### Database Schema

All state lives in `.swarm/memory.db` (SQLite, WAL mode):

| Table | Purpose |
|---|---|
| `patterns` | Stored memories (id, type, pattern_data JSON, confidence, usage_count) |
| `pattern_embeddings` | 384-dim float32 vectors for semantic search |
| `pattern_links` | Relationships: entails, contradicts, refines, duplicate_of |
| `task_trajectories` | Complete task records with judge verdict |
| `consolidation_runs` | Audit log of consolidation passes |
| `metrics_log` | Performance metrics time series |

### Retrieval Scoring

Memories are scored with three components:

```
score = 0.65 × cosine_similarity + 0.15 × recency + 0.20 × reliability
```

- **Similarity (0.65):** Cosine similarity between query embedding and stored pattern embedding
- **Recency (0.15):** Exponential decay with 45-day half-life from `last_used` timestamp
- **Reliability (0.20):** Pattern confidence score, capped at 1.0

After scoring, MMR selection with diversity parameter `delta = 0.10` ensures the top-k results aren't redundant.

### Judgment

Without an LLM API key, snoo-flow uses a heuristic judge:

- **Exit code 0** + no error signals → Success (confidence: 0.7)
- **Exit code non-zero** or error string indicators → Failure (confidence: 0.6)

With an API key (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_GEMINI_API_KEY`), it uses an LLM-as-judge for more nuanced verdicts.

### Consolidation

Runs automatically when 20+ new memories accumulate (and at session end):

1. **Dedup:** LSH-bucketed cosine comparison. Merges patterns with similarity >= 0.95, keeping the higher-usage version
2. **Contradiction detection:** Compares Success vs Failure patterns. Flags pairs with similarity >= 0.85 as contradictions
3. **Pruning:** Removes patterns older than 180 days with zero usage and confidence < 0.5

## Configuration

Algorithm parameters are in `src/reasoningbank/config/reasoningbank.yaml`:

```yaml
retrieve:
  k: 3                              # Top-k results to return
  alpha: 0.65                       # Similarity weight
  beta: 0.15                        # Recency weight
  gamma: 0.20                       # Reliability weight
  delta: 0.10                       # MMR diversity parameter
  recency_half_life_days: 45        # Exponential decay half-life

embeddings:
  provider: local
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
  cache_ttl_seconds: 3600

consolidate:
  run_every_new_items: 20           # Trigger threshold
  dedup_similarity_threshold: 0.87
  contradiction_threshold: 0.60
  prune_age_days: 180
```

## Build & Test

```bash
npm run build     # TypeScript compilation (tsc)
npm test          # Run all 31 tests
npm run lint      # Type-check without emitting (tsc --noEmit)
```

## Troubleshooting

### "No prior patterns found"

Expected for the first few sessions. Patterns accumulate as you work. After 5-10 tool uses, you should start seeing retrievals on related prompts.

### High CPU / zombie processes

If you see hanging `tsx` processes (pre-ADR-001 behavior or if using an older version):

```bash
# Kill any zombie tsx processes
pkill -f 'tsx.*run.ts' || true

# Restart the embed server
npm run embed-server:stop
npm run embed-server:start
```

The `process.exit(0)` in `run.ts` and `setsid` in `retrieve.sh` prevent this from recurring.

### Embed server not starting

```bash
# Check for stale socket/pid
ls -la .swarm/embed.*

# Clean up and restart
rm -f .swarm/embed.sock .swarm/embed.pid
npm run embed-server:start

# Check logs
cat .swarm/embed-server.log
```

### Database issues

```bash
# Reinitialize the database (preserves existing data via migrations)
npx tsx src/bootstrap.ts

# Check what's stored
npx tsx scripts/run.ts stats
```

## License

MIT
