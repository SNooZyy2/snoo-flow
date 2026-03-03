# snoo-flow v0.1 — Close the Learning Loop

## What This Is

MVP prototype that fixes the 8 breaks preventing snoo-flow from learning from its own experience. The full feedback loop:

```
pre-task → AI works → post-task → judge → distill → consolidate
   ^                                                       |
   +--------------- retrieve learned patterns <------------+
```

## Progress

| Phase | Status | Gate |
|-------|--------|------|
| 0 — Bootstrap | **DONE** | `.swarm/memory.db` created, 7 tables, 2 triggers, UPSERT verified |
| 1 — Real embeddings | **DONE** | cosine(auth, auth)=0.84 > 0.7, cosine(login, banana)=0.21 < 0.3, dims=384 |
| 2 — Fix distill | **DONE** | distillMemories() stores pattern+embedding rows, confidence=0.6, 5/5 tests pass |
| 3 — Wire pipeline | **DONE** | `task_trajectories` row with `judge_label` populated, `patterns` has distilled rows, exitCode:0→Success, 6/6 tests pass |
| 4 — E2E + CI | **DONE** | Run 7 → pre-task retrieves prior memories, score=0.79 > 0.5; 21/21 tests pass; CI workflow created |

### Phase 0 Completed Work
- 17 files copied from source repos (16 reasoningbank + sona-optimizer)
- `embeddings.js` NOT copied (Fix 9 — prevents hash-based fallback)
- Fix 8 applied to `queries.ts`: 3 UPSERTs fixed, LIMIT 1000 added, BLOB guard added
- `task_trajectories` schema changed to composite PK `(task_id, agent_id, created_at)`
- 2 cleanup triggers added (`trg_cleanup_embeddings`, `trg_update_last_used`)
- `bootstrap.ts` written
- `npm install` — 88 packages, 0 vulnerabilities

### Phase 1 Completed Work
- Fix 2 applied: `DEFAULT_CONFIG` changed from `claude/1024` to `local/384` in `config.ts`
- Provider type union extended: `'claude' | 'openai' | 'local'`
- YAML fallback values in `loadConfig()` also updated to `local/384`
- `tsx` added as dev dependency for running TS tests (resolves `.js` → `.ts` imports)
- `npm test` script updated from `node --test` to `tsx --test`
- NPX detection bypass: `bootstrap.ts` sets `FORCE_TRANSFORMERS=1` (spec allows either remove or bypass)
- Gate test: `tests/phase1-embeddings.test.js` — 5/5 passing
- **Review note**: config test exercises YAML path (not DEFAULT_CONFIG fallback) since YAML is findable from cwd — both paths produce correct values so gate holds

### Phase 2 Completed Work
- Fix 7 (distill.ts): Static `import { ModelRouter }` → dynamic `await import()` with try/catch
- Fix 3: `templateBasedDistill` made `async`, returns `Promise<string[]>`, calls `storeMemories()` instead of `return []`
- Guard added: `if (!hasApiKey || !ModelRouter)` → template fallback (covers both missing key and missing router)
- Gate test: `tests/phase2-distill.test.js` — 5/5 passing

### Phase 3 Completed Work
- Fix 7 (judge.ts): Static `import { ModelRouter }` → dynamic `await import()` with try/catch (same pattern as distill.ts)
- Fix 6 (judge.ts): `heuristicJudge()` now checks `step.exitCode` — 0=success signal, non-zero=error signal, plus string-based indicators
- Guard updated: `if (!hasApiKey || !ModelRouter)` → heuristic fallback
- Fix 4: `src/trajectory/capture.ts` created — `captureTrajectory()` returns Trajectory with spawn+execute steps and metadata
- Fix 5 (post-task.ts): Added `import * as db`, `db.storeTrajectory()` after judging, `--agent` CLI arg parsing, agentId forwarded to distill
- Fix 1: `src/hooks/handler.ts` created — `handlePostTask()` orchestrates capture→judge→persist→distill→consolidate→SONA; `handlePreTask()` wraps retrieveMemories
- SONA integration: dynamic import with try/catch, non-fatal failure
- Gate test: `tests/phase3-pipeline.test.js` — 6/6 passing
- **Pre-existing issue noted**: `post-task.ts` and `pre-task.ts` have wrong relative import paths (e.g. `../core/judge.js` instead of `../reasoningbank/core/judge.js`) — CLI entrypoints never ran via tsc output; `handler.ts` uses correct paths

### Phase 4 Completed Work
- E2E test: `tests/phase4-e2e.test.js` — runs 7 tasks of same type, verifies memory accumulation and retrieval
- Gate passed: pre-task retrieves memories with top score 0.79 (gate: > 0.5), 3 memories retrieved from 7 candidates
- GitHub Actions CI: `.github/workflows/ci.yml` — typecheck + test jobs on push/PR to main/master
- Typecheck fixes for CI: fixed `post-task.ts`/`pre-task.ts` wrong import paths, added `.d.ts` for `mmr.js`/`pii-scrubber.js`, added `@ts-expect-error` for optional dynamic imports, annotated implicit `any` params
- All 21 tests pass: Phase 1 (5), Phase 2 (5), Phase 3 (6), Phase 4 (5)

## Spec Documents (Archived)

v0.1 specs have been archived to `docs/spec/_archive/` — all phases complete.

## Source Repos (read-only reference)

| Repo | Path | What Was Copied From |
|------|------|----------------------|
| agentic-flow | `~/repos/agentic-flow/agentic-flow/src/reasoningbank/` | Core pipeline (16 files) |
| claude-flow | `~/repos/claude-flow/v3/@claude-flow/cli/` | sona-optimizer.ts |

## Build & Test

```bash
npm install
npm run build    # tsc
npm test         # tsx --test (resolves .ts imports)
npm run lint     # tsc --noEmit
```

ALWAYS run tests after making code changes.
ALWAYS verify build succeeds before committing.

## Directory Structure

```
src/
  bootstrap.ts       # DB init + env setup
  hooks/             # handler.ts (Phase 3), pre-task.ts, post-task.ts
  trajectory/        # capture.ts (Phase 3)
  reasoningbank/
    core/            # retrieve.ts, judge.ts, distill.ts, consolidate.ts
    db/              # queries.ts (Fix 8 applied), schema.ts
    utils/           # embeddings.ts, mmr.js, pii-scrubber.js, config.ts
    config/          # reasoningbank.yaml
    prompts/         # judge.json, distill-success.json, distill-failure.json
  routing/           # sona-optimizer.ts
  config/            # default.yaml (Phase 3)
tests/               # All test files here
scripts/             # research-query.js + utility scripts
docs/
  spec/_archive/     # Archived v0.1 spec docs (SPEC, FILES, FIXES, etc.)
.research.db         # → symlink to ruvnet-research/db/research.db (read-only)
.swarm/memory.db     # Learning loop DB (created by bootstrap)
```

## Research Database Access

The research DB from ruvnet-research is symlinked at `.research.db` (read-only).
Use it to look up findings, facade flags, realness scores, and architecture decisions.

```bash
# Quick query
node scripts/research-query.js "SELECT * FROM open_findings WHERE severity='CRITICAL' LIMIT 5"

# Inline
node -e "
const Database = require('better-sqlite3');
const db = new Database('.research.db', { readonly: true });
const rows = db.prepare('SELECT description FROM findings WHERE category LIKE ? LIMIT 5').all('%facade%');
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

### Useful Research Queries

```sql
-- Findings for a specific file
SELECT severity, category, description FROM findings f
JOIN files fi ON f.file_id = fi.id
WHERE fi.relative_path LIKE '%judge.ts%';

-- All CRITICAL findings
SELECT * FROM open_findings WHERE severity = 'CRITICAL';

-- Check if a file is a known facade
SELECT f.relative_path, f.depth, fi.severity, fi.description
FROM files f
LEFT JOIN findings fi ON f.id = fi.file_id
WHERE f.relative_path LIKE '%target%' AND fi.category LIKE '%facade%';
```

## Key Rules

- `embeddings.ts` ONLY — `embeddings.js` is hash-based and was intentionally excluded
- Do NOT add `intelligence.ts` (O(n) facade claiming O(log n))
- Do NOT add `types/index.ts` or `config/reasoningbank-types.ts` (dead files)
- Do NOT add `router/router.ts` (use dynamic import with catch instead)
- ESM throughout: `"type": "module"` in package.json
- `runMigrations()` inline DDL is canonical — ignore separate .sql migration files
- Schema source of truth: `src/reasoningbank/db/queries.ts`

## Security

- NEVER hardcode API keys or credentials
- NEVER commit .env files
- Optional LLM judge requires API key via env var, not hardcoded
- PII scrubber runs on all distilled memories before storage

## Git

- Do NOT add `Co-Authored-By` trailers to commits

## File Organization

- Source code → `src/`
- Tests → `tests/`
- Scripts → `scripts/`
- Docs → `docs/`
- NEVER save files to the root folder (except config files like package.json, tsconfig.json)
