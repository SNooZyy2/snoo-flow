# snoo-flow — Self-Learning Memory for Claude Code

## What This Is

A self-learning memory system that hooks into Claude Code's lifecycle. Every prompt retrieves relevant past experience, every tool use records what happened, and every session consolidates knowledge.

```
prompt → retrieve memories → Claude works → record outcome → judge → distill → store
  ^                                                                                |
  +-------------------------------- next prompt ←----------------------------------+
```

See `README.md` for full setup guide, usage tutorial, and architecture details.

## Learning Pipeline

| Stage | Module | What It Does |
|-------|--------|-------------|
| Retrieve | `retrieve.ts` | Embeds the prompt, finds similar past patterns via cosine similarity + MMR |
| Capture | `capture.ts` | Builds a structured trajectory from tool use (command, args, exit code) |
| Judge | `judge.ts` | Assigns Success/Failure verdict (heuristic or LLM-as-judge) |
| Distill | `distill.ts` | Extracts reusable pattern ("when X, do Y because Z") |
| Store | `queries.ts` | PII-scrubbed pattern + 384-dim embedding → SQLite |
| Consolidate | `consolidate.ts` | Dedup, contradiction detection, pruning stale patterns |
| SONA | `sona-optimizer.ts` | Adaptive routing — learns which agent types work for which tasks |

## Build & Test

```bash
npm install
npm run build    # tsc
npm test         # tsx --test (resolves .ts imports)
npm run lint     # tsc --noEmit
```

ALWAYS run tests after making code changes.
ALWAYS verify build succeeds before committing.

## Embedding Server

Persistent ONNX embedding server (~85x faster than cold-loading per hook). Starts automatically on first prompt.

```bash
npm run embed-server:start    # Manual start
npm run embed-server:stop     # Stop
curl --unix-socket .swarm/embed.sock http://localhost/health 2>/dev/null | jq .
```

Self-exits after 30 minutes idle. Falls back to in-process loading if not running.

## Directory Structure

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
    core/                         # retrieve, judge, distill, consolidate
    db/
      queries.ts                  # SQLite operations (schema source of truth)
      schema.ts                   # TypeScript types
    utils/
      embeddings.ts               # 3-tier: cache → server → in-process
      config.ts                   # YAML config loader with defaults
      mmr.js                      # Maximal Marginal Relevance selection
      pii-scrubber.js             # PII redaction before storage
    config/reasoningbank.yaml     # Algorithm parameters (weights, thresholds)
    prompts/                      # LLM judge + distill prompt templates
  routing/sona-optimizer.ts       # Adaptive routing
scripts/
  run.ts                          # Unified CLI runner (called by all hooks)
  embed-server.ts                 # Persistent embedding server (ADR-001)
  benchmark-embed.ts              # Performance benchmarking
tests/                            # All test files
.claude/
  hooks/                          # Shell hooks registered with Claude Code
  settings.json                   # Hook configuration
.swarm/
  memory.db                       # SQLite database (created at runtime)
  embed.sock                      # Unix socket for embed server (runtime)
docs/
  ADR/                            # Architecture decision records
```

## Key Rules

- `embeddings.ts` ONLY — `embeddings.js` is hash-based and must not be added
- Do NOT add `intelligence.ts` (O(n) facade claiming O(log n))
- Do NOT add `types/index.ts` or `config/reasoningbank-types.ts` (dead files)
- `src/router/router.ts` is the ModelRouter — dynamically imported by judge/distill via try/catch
- ESM throughout: `"type": "module"` in package.json
- `runMigrations()` inline DDL is canonical — ignore separate .sql migration files
- Schema source of truth: `src/reasoningbank/db/queries.ts`

## Database

All state lives in `.swarm/memory.db` (SQLite, WAL mode):

| Table | Purpose |
|-------|---------|
| `patterns` | Stored memories with confidence and usage count |
| `pattern_embeddings` | 384-dim float32 vectors for semantic search |
| `pattern_links` | Relationships: entails, contradicts, refines, duplicate_of |
| `task_trajectories` | Complete task records with judge verdict |
| `consolidation_runs` | Audit log of consolidation passes |
| `metrics_log` | Performance metrics time series |

## Research Database Access

The research DB from ruvnet-research is symlinked at `.research.db` (read-only).

```bash
node scripts/research-query.js "SELECT * FROM open_findings WHERE severity='CRITICAL' LIMIT 5"
```

## Configuration

Algorithm parameters live in `src/reasoningbank/config/reasoningbank.yaml`:

- **Retrieval weights:** similarity=0.65, recency=0.15, reliability=0.20
- **Embeddings:** local provider, Xenova/all-MiniLM-L6-v2, 384 dimensions
- **Consolidation:** dedup at 0.87 similarity, prune after 180 days idle, prune at 5+ contradictions
- **Judge/Distill model:** gemini-2.0-flash-lite via OpenRouter (EOL end of March 2026)

## LLM Judge (Optional)

Without an API key, judge and distill use local heuristics (exit code + template extraction).
With an API key, they call an LLM for semantic judgment and structured distillation.

To enable: create `.env.local` in the project root:
```
OPENROUTER_API_KEY=sk-or-v1-...
```

The hooks source `.env.local` automatically. Supports `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`.
The router (`src/router/router.ts`) handles both APIs with native fetch, no extra dependencies.

## Security

- NEVER hardcode API keys or credentials
- NEVER commit .env files (`.env.*` is gitignored)
- API keys go in `.env.local` only — hooks source it automatically
- PII scrubber runs on all distilled memories before storage (Supabase keys, JWTs, Google keys, base64 secrets)

## Git

- Do NOT add `Co-Authored-By` trailers to commits

## File Organization

- Source code → `src/`
- Tests → `tests/`
- Scripts → `scripts/`
- Docs → `docs/`
- NEVER save files to the root folder (except config files like package.json, tsconfig.json)
