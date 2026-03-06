#!/usr/bin/env tsx
/**
 * snoo-flow CLI runner
 *
 * Usage:
 *   tsx scripts/run.ts pre  "description of what you're about to do"
 *   tsx scripts/run.ts post "description of what you did" [exit-code]
 *   tsx scripts/run.ts stats
 */

import { bootstrap } from '../src/bootstrap.js';
import { handlePreTask, handlePostTask } from '../src/hooks/handler.js';
import { consolidate } from '../src/reasoningbank/core/consolidate.js';
import * as db from '../src/reasoningbank/db/queries.js';

// Suppress internal logs — only show results
const origLog = console.log;
const origWarn = console.warn;
let quiet = true;
console.log = (...args: any[]) => { if (!quiet) origLog(...args); };
console.warn = (...args: any[]) => { if (!quiet) origWarn(...args); };

function output(...args: any[]) { origLog(...args); }

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  await bootstrap();

  if (cmd === 'pre') {
    const query = rest.join(' ');
    if (!query) {
      console.error('Usage: run.ts pre "task description"');
      process.exit(1);
    }

    const { memories, formatted } = await handlePreTask(query);

    if (memories.length === 0) {
      output('No prior patterns found for this task.');
    } else {
      output(formatted);
    }

  } else if (cmd === 'post') {
    const lastArg = rest[rest.length - 1];
    const exitCode = /^\d+$/.test(lastArg) ? parseInt(lastArg, 10) : 0;
    const taskQuery = /^\d+$/.test(lastArg) ? rest.slice(0, -1).join(' ') : rest.join(' ');

    if (!taskQuery) {
      console.error('Usage: run.ts post "task description" [exit-code]');
      process.exit(1);
    }

    const now = new Date().toISOString();
    const result = await handlePostTask({
      taskId: `task-${Date.now()}`,
      taskQuery,
      agentType: 'human',
      startTime: now,
      endTime: now,
      exitCode,
    });

    output(`Verdict: ${result.verdict.label} (${(result.verdict.confidence * 100).toFixed(0)}%)`);
    output(`Reasons: ${result.verdict.reasons.join(', ')}`);
    output(`Patterns stored: ${result.memoryIds.length}`);
    if (result.consolidated) output('Memory consolidation ran.');

  } else if (cmd === 'stats') {
    const patterns = db.fetchMemoryCandidates({});
    const conn = db.getDb();
    const trajCount = (conn.prepare('SELECT COUNT(*) as c FROM task_trajectories').get() as any).c;
    output(`Patterns: ${patterns.length}`);
    output(`Trajectories: ${trajCount}`);

  } else if (cmd === 'log') {
    const limit = parseInt(rest[0], 10) || 20;
    const entries = db.getRetrievalLog(limit);
    if (entries.length === 0) {
      output('No retrieval log entries yet.');
    } else {
      for (const e of entries) {
        const results = JSON.parse(e.results_json);
        output(`[${e.created_at}] ${e.duration_ms}ms | ${e.memories_returned}/${e.memories_considered} memories`);
        output(`  Prompt: ${e.prompt.substring(0, 80)}${e.prompt.length > 80 ? '...' : ''}`);
        for (const r of results) {
          output(`    - "${r.title}" score=${r.score.toFixed(3)} sim=${r.similarity.toFixed(3)}`);
        }
        output('');
      }
    }

  } else if (cmd === 'consolidate') {
    const result = await consolidate();
    output(`Consolidation complete: ${result.duplicatesFound} dupes, ${result.contradictionsFound} contradictions, ${result.itemsPruned} pruned (${result.itemsProcessed} processed in ${result.durationMs}ms)`);

  } else {
    quiet = false;
    console.log(`snoo-flow — learning loop runner

Commands:
  pre  "task description"              Retrieve prior patterns before starting work
  post "task description" [exit-code]  Record what happened (0=success, 1=failure)
  log  [limit]                         Show recent retrieval log (default: 20)
  consolidate                          Run memory consolidation (dedup, prune)
  stats                                Show memory stats`);
  }
}

main().then(() => {
  // Force exit — WASM threads from @xenova/transformers linger
  // and prevent clean shutdown (causes zombie processes)
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
