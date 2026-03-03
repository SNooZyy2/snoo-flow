/**
 * Phase 4 Gate Test: End-to-End Learning Loop
 *
 * Gate criteria:
 * - Run 7 tasks of the same type through the full pipeline
 * - Memories accumulate across runs
 * - On run 7, pre-task retrieves memories from prior runs with score > 0.5
 * - Retrieval score improves over successive runs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Force real transformers, no API keys
process.env.FORCE_TRANSFORMERS = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_GEMINI_API_KEY;

// Use a test-specific DB
const testDbPath = join(process.cwd(), '.swarm', 'test-phase4.db');
process.env.CLAUDE_FLOW_DB_PATH = testDbPath;

// Task domain for all 7 runs — same type to test reinforcement
const TASK_DOMAIN = 'typescript-imports';
const TASK_QUERY = 'fix TypeScript import path errors in ESM project';

describe('Phase 4: End-to-End Learning Loop', () => {
  let handlePostTask;
  let handlePreTask;

  before(async () => {
    const dir = join(process.cwd(), '.swarm');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const { runMigrations } = await import('../src/reasoningbank/db/queries.ts');
    await runMigrations();

    ({ handlePostTask, handlePreTask } = await import('../src/hooks/handler.ts'));
  });

  after(async () => {
    const { closeDb } = await import('../src/reasoningbank/db/queries.ts');
    closeDb();

    const { clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.ts');
    clearEmbeddingCache();

    try { unlinkSync(testDbPath); } catch {}
  });

  it('runs 7 tasks and accumulates memories', async () => {
    const queries = [
      'fix TypeScript import path errors in ESM project',
      'resolve TS module resolution for .js extensions in ESM',
      'fix broken TypeScript imports using NodeNext module resolution',
      'update tsconfig paths to fix ESM import errors',
      'fix TypeScript import errors by adding .js extensions',
      'resolve ESM import path issues in TypeScript project',
      'fix TypeScript moduleResolution errors for ESM imports',
    ];

    for (let run = 0; run < 7; run++) {
      const now = new Date();
      const startTime = new Date(now.getTime() - 3000).toISOString();
      const endTime = now.toISOString();

      await handlePostTask({
        taskId: `e2e-run-${run}`,
        taskQuery: queries[run],
        agentType: 'coder',
        routedModel: 'sonnet',
        startTime,
        endTime,
        exitCode: 0,
        outputLength: 800 + run * 100,
        domain: TASK_DOMAIN,
      });
    }

    // Verify memories accumulated
    const testDb = new Database(testDbPath, { readonly: true });

    const trajectoryCount = testDb.prepare(
      `SELECT COUNT(*) as count FROM task_trajectories`
    ).get().count;
    assert.ok(trajectoryCount >= 7, `expected >= 7 trajectories, got ${trajectoryCount}`);

    const patternCount = testDb.prepare(
      `SELECT COUNT(*) as count FROM patterns WHERE type = 'reasoning_memory'`
    ).get().count;
    assert.ok(patternCount >= 7, `expected >= 7 patterns, got ${patternCount}`);

    testDb.close();
  });

  it('pre-task retrieves memories from prior runs with score > 0.5', async () => {
    // This is the Phase 4 gate: on run 7+, pre-task must find
    // prior memories with score > 0.5
    const result = await handlePreTask(TASK_QUERY, {
      domain: TASK_DOMAIN,
    });

    assert.ok(result.memories.length > 0,
      `pre-task should retrieve memories, got ${result.memories.length}`);

    const topScore = result.memories[0].score;
    assert.ok(topScore > 0.5,
      `top memory score should be > 0.5, got ${topScore.toFixed(4)}`);

    console.log(`  Retrieved ${result.memories.length} memories`);
    for (const mem of result.memories) {
      console.log(`    - "${mem.title}" score=${mem.score.toFixed(4)} sim=${mem.components.similarity.toFixed(4)}`);
    }
  });

  it('retrieval returns formatted prompt text', async () => {
    const result = await handlePreTask(TASK_QUERY, {
      domain: TASK_DOMAIN,
    });

    assert.ok(result.formatted.length > 0, 'formatted prompt should not be empty');
    assert.ok(result.formatted.includes('Relevant Memories'),
      'formatted output should contain header');
    assert.ok(result.formatted.includes('Confidence:'),
      'formatted output should contain confidence scores');
  });

  it('all trajectories have a judge_label (not NULL)', async () => {
    const testDb = new Database(testDbPath, { readonly: true });

    const rows = testDb.prepare(
      `SELECT task_id, judge_label FROM task_trajectories ORDER BY created_at`
    ).all();

    assert.equal(rows.length, 7, `expected 7 trajectory rows, got ${rows.length}`);

    for (const row of rows) {
      assert.ok(row.judge_label === 'Success' || row.judge_label === 'Failure',
        `${row.task_id} should have a valid label, got ${row.judge_label}`);
    }

    // At least some should be Success (queries without "error" in text)
    const successes = rows.filter(r => r.judge_label === 'Success');
    assert.ok(successes.length > 0, 'at least some trajectories should be Success');

    console.log(`  ${successes.length}/7 Success, ${rows.length - successes.length}/7 Failure`);

    testDb.close();
  });

  it('all patterns have embeddings', async () => {
    const testDb = new Database(testDbPath, { readonly: true });

    const orphans = testDb.prepare(`
      SELECT p.id FROM patterns p
      LEFT JOIN pattern_embeddings pe ON p.id = pe.id
      WHERE pe.id IS NULL AND p.type = 'reasoning_memory'
    `).all();

    assert.equal(orphans.length, 0,
      `${orphans.length} patterns missing embeddings`);

    testDb.close();
  });
});
