/**
 * Phase 3 Gate Test: Wire Pipeline
 *
 * Gate criteria:
 * - judge.ts loads without crash (no static ModelRouter import)
 * - exitCode: 0 → judge_label = 'Success'
 * - exitCode: 1 → judge_label = 'Failure'
 * - captureTrajectory() returns valid Trajectory shape
 * - Full pipeline: task_trajectories row with judge_label not NULL
 * - Full pipeline: patterns table has new rows from distillation
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Force real transformers, no API keys
process.env.FORCE_TRANSFORMERS = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_GEMINI_API_KEY;

// Use a test-specific DB
const testDbPath = join(process.cwd(), '.swarm', 'test-phase3.db');
process.env.CLAUDE_FLOW_DB_PATH = testDbPath;

describe('Phase 3: Wire Pipeline', () => {
  before(async () => {
    const dir = join(process.cwd(), '.swarm');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const { runMigrations } = await import('../src/reasoningbank/db/queries.ts');
    await runMigrations();
  });

  after(async () => {
    const { closeDb } = await import('../src/reasoningbank/db/queries.ts');
    closeDb();

    const { clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.ts');
    clearEmbeddingCache();

    const { unlinkSync } = await import('fs');
    try { unlinkSync(testDbPath); } catch {}
  });

  it('judge.ts loads without crash (Fix 7 — dynamic ModelRouter)', async () => {
    const mod = await import('../src/reasoningbank/core/judge.ts');
    assert.ok(typeof mod.judgeTrajectory === 'function', 'judgeTrajectory should be a function');
  });

  it('heuristic judge returns Success for exitCode: 0 (Fix 6)', async () => {
    const { judgeTrajectory } = await import('../src/reasoningbank/core/judge.ts');

    const trajectory = {
      steps: [
        { action: 'spawn', agent: 'coder', query: 'build feature' },
        { action: 'execute', exitCode: 0, outputLength: 500 },
      ],
      metadata: {},
    };

    const verdict = await judgeTrajectory(trajectory, 'build a login feature');
    assert.equal(verdict.label, 'Success', `expected Success, got ${verdict.label}`);
  });

  it('heuristic judge returns Failure for exitCode: 1 (Fix 6)', async () => {
    const { judgeTrajectory } = await import('../src/reasoningbank/core/judge.ts');

    const trajectory = {
      steps: [
        { action: 'spawn', agent: 'coder', query: 'build feature' },
        { action: 'execute', exitCode: 1, outputLength: 200 },
      ],
      metadata: {},
    };

    const verdict = await judgeTrajectory(trajectory, 'build a login feature');
    assert.equal(verdict.label, 'Failure', `expected Failure, got ${verdict.label}`);
  });

  it('captureTrajectory() returns valid Trajectory shape (Fix 4)', async () => {
    const { captureTrajectory } = await import('../src/trajectory/capture.ts');

    const traj = captureTrajectory({
      taskQuery: 'implement auth',
      agentType: 'coder',
      routedModel: 'sonnet',
      startTime: new Date(Date.now() - 5000).toISOString(),
      endTime: new Date().toISOString(),
      exitCode: 0,
      outputLength: 1200,
    });

    assert.ok(Array.isArray(traj.steps), 'steps should be an array');
    assert.equal(traj.steps.length, 2, 'should have 2 steps (spawn + execute)');
    assert.equal(traj.steps[0].action, 'spawn');
    assert.equal(traj.steps[1].action, 'execute');
    assert.equal(traj.steps[1].exitCode, 0);
    assert.ok(traj.metadata, 'should have metadata');
    assert.ok(traj.metadata.duration > 0, 'duration should be positive');
    assert.equal(traj.metadata.agent, 'coder');
  });

  it('full pipeline: task_trajectories row with judge_label not NULL (Fix 1+5)', async () => {
    const { handlePostTask } = await import('../src/hooks/handler.ts');

    const now = new Date();
    const fiveSecsAgo = new Date(now.getTime() - 5000);

    const result = await handlePostTask({
      taskId: 'test-pipe-1',
      taskQuery: 'implement JWT authentication',
      agentType: 'coder',
      routedModel: 'sonnet',
      startTime: fiveSecsAgo.toISOString(),
      endTime: now.toISOString(),
      exitCode: 0,
      outputLength: 1200,
      domain: 'auth',
    });

    assert.ok(result.verdict, 'should have verdict');
    assert.equal(result.verdict.label, 'Success', `expected Success, got ${result.verdict.label}`);

    // Check DB row
    const testDb = new Database(testDbPath, { readonly: true });
    const row = testDb.prepare(
      `SELECT * FROM task_trajectories WHERE task_id = 'test-pipe-1'`
    ).get();

    assert.ok(row, 'should have trajectory row in DB');
    assert.ok(row.judge_label, `judge_label should not be NULL, got ${row.judge_label}`);
    assert.equal(row.judge_label, 'Success');
    assert.equal(row.agent_id, 'coder');

    testDb.close();
  });

  it('full pipeline: patterns table has new rows from distillation', async () => {
    const testDb = new Database(testDbPath, { readonly: true });

    const rows = testDb.prepare(
      `SELECT * FROM patterns WHERE type = 'reasoning_memory'`
    ).all();

    assert.ok(rows.length > 0, `patterns table should have rows, found ${rows.length}`);

    const row = rows[0];
    const data = JSON.parse(row.pattern_data);
    assert.ok(data.title, 'pattern_data should have title');
    assert.ok(data.source, 'pattern_data should have source');

    testDb.close();
  });
});
