# Technical Reference

This document covers architecture, internals, and configuration for snoo-flow. For an overview of what snoo-flow does and how to get started, see the [README](../README.md).

## Architecture

### Learning Pipeline

```
prompt --> retrieve memories --> Claude works --> judge outcome --> distill pattern --> scrub PII --> embed --> store
  ^                                                                                                           |
  +------------------------------------------- next prompt <--------------------------------------------------+
```

| Stage | Module | What It Does |
|-------|--------|-------------|
| Retrieve | `retrieve.ts` | Embeds the prompt, finds similar past patterns via cosine similarity + MMR |
| Capture | `capture.ts` | Builds a structured trajectory from tool use (command, args, exit code) |
| Judge | `judge.ts` | Assigns Success/Failure verdict (heuristic or LLM-as-judge) |
| Distill | `distill.ts` | Extracts reusable pattern ("when X, do Y because Z") |
| Store | `queries.ts` | PII-scrubbed pattern + 384-dim embedding into SQLite |
| Consolidate | `consolidate.ts` | Dedup, contradiction detection, pruning stale patterns |
| SONA | `sona-optimizer.ts` | Adaptive routing — learns which agent types work for which tasks |

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
      embeddings.ts               # 3-tier embedding: cache -> server -> in-process
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
      retrieve.sh                 # UserPromptSubmit -> memory retrieval + embed server auto-start
      record.sh                   # PostToolUse[Bash] -> outcome recording
      record-tool.sh              # PostToolUse[Edit|Write|Agent] -> recording
      consolidate.sh              # SessionEnd -> memory consolidation
    settings.json                 # Hook configuration for Claude Code
.swarm/
    memory.db                     # SQLite database (created at runtime)
    embed.sock                    # Unix socket for embed server (runtime)
    embed.pid                     # Embed server PID file (runtime)
    embed-server.log              # Server logs (runtime)
docs/
    ADR/                          # Architecture decision records
```

## Database Schema

All state lives in `.swarm/memory.db` (SQLite, WAL mode):

| Table | Purpose |
|---|---|
| `patterns` | Stored memories (id, type, pattern_data JSON, confidence, usage_count) |
| `pattern_embeddings` | 384-dim float32 vectors for semantic search |
| `pattern_links` | Relationships: entails, contradicts, refines, duplicate_of |
| `task_trajectories` | Complete task records with judge verdict |
| `consolidation_runs` | Audit log of consolidation passes |
| `metrics_log` | Performance metrics time series |

## Retrieval Algorithm

Memories are scored with three weighted components:

```
score = 0.65 x cosine_similarity + 0.15 x recency + 0.20 x reliability
```

- **Similarity (0.65):** Cosine similarity between query embedding and stored pattern embedding
- **Recency (0.15):** Exponential decay with 45-day half-life from `last_used` timestamp
- **Reliability (0.20):** Pattern confidence score, capped at 1.0

After scoring, MMR (Maximal Marginal Relevance) selection with diversity parameter `delta = 0.10` ensures the top-k results aren't redundant.

## Judgment

Without an LLM API key, snoo-flow uses a heuristic judge:

- **Exit code 0** + no error signals = Success (confidence: 0.7)
- **Exit code non-zero** or error string indicators = Failure (confidence: 0.6)

With an API key (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_GEMINI_API_KEY`), it uses an LLM-as-judge for more nuanced verdicts.

## Consolidation

Runs automatically when 20+ new memories accumulate (and at session end):

1. **Dedup:** LSH-bucketed cosine comparison. Merges patterns with similarity >= 0.95, keeping the higher-usage version
2. **Contradiction detection:** Compares Success vs Failure patterns. Flags pairs with similarity >= 0.85 as contradictions
3. **Pruning:** Removes patterns older than 180 days with zero usage and confidence < 0.5

## Embedding Server

snoo-flow includes a persistent ONNX embedding server ([ADR-001](ADR/001-persistent-embedding-server.md)) that loads the model once and serves requests over a Unix socket. This avoids reloading the ~250MB model on every hook invocation.

The server starts automatically on first prompt via `retrieve.sh`. It self-exits after 30 minutes of inactivity. If it's not running, embedding falls back to in-process model loading (slower but functional).

### Manual management

```bash
npm run embed-server:start    # Start
npm run embed-server:stop     # Stop
npx tsx scripts/benchmark-embed.ts   # Run benchmarks

# Check health
curl --unix-socket .swarm/embed.sock http://localhost/health 2>/dev/null | jq .
```

### Performance

| Scenario | Without server | With server |
|---|---|---|
| Embedding inference | ~255ms (cold) | ~3-5ms |
| Full hook latency | ~500ms | ~200ms |
| Concurrent hooks | N x 255ms | ~3ms x N (serialized) |
| Memory per model instance | ~250MB each | ~50MB shared |

### Troubleshooting the embed server

```bash
# Check for stale socket/pid
ls -la .swarm/embed.*

# Clean up and restart
rm -f .swarm/embed.sock .swarm/embed.pid
npm run embed-server:start

# Check logs
cat .swarm/embed-server.log
```

## Configuration

Algorithm parameters live in `src/reasoningbank/config/reasoningbank.yaml`:

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

## Database Troubleshooting

```bash
# Reinitialize (preserves existing data via migrations)
npx tsx src/bootstrap.ts

# Check what's stored
npx tsx scripts/run.ts stats
```
